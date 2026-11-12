"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CrownGauge } from "./CrownGauge";
import { TakeButton } from "./TakeButton";
import { ago, duration, heat, meltFraction, priceAt, short, sol } from "@/lib/price";
import { useCrown, useNow } from "@/lib/useCrown";
import type { Takeover } from "@/lib/api";

const BAR: Record<string, string> = { gold: "bg-gold", ember: "bg-ember", red: "bg-red" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right">{children}</dd>
    </div>
  );
}

function FeedCard({ t, now, fresh }: { t: Takeover; now: number; fresh: boolean }) {
  return (
    <li className={`rounded bg-card px-4 py-3 text-sm ${fresh ? "fresh" : ""}`}>
      <span className="text-sky">{short(t.newKing)}</span>{" "}
      {t.oldKing === null ? "claimed it" : t.oldKing === t.newKing ? "fortified it" : (
        <>took it from <span className="text-sky">{short(t.oldKing)}</span></>
      )}{" "}
      for <span className="num text-mint">{sol(t.pricePaid)} SOL</span>
      <span className="text-muted">
        {t.oldKing !== null && <> · old king reigned {duration(t.reignSecs)} and earned <span className="num">{sol(t.oldReignFees)} SOL</span></>}
        {" "}· <span className="num">{sol(t.toBurn)} SOL</span> burned · {ago(t.ts, now)}
      </span>
    </li>
  );
}

export function Throne() {
  const { view, history, error, clockOffset, bumps, refresh } = useCrown();
  const now = useNow(clockOffset);
  const { publicKey } = useWallet();

  // Shake and flash for a moment whenever the crown changes hands.
  const [bumping, setBumping] = useState(false);
  useEffect(() => {
    if (bumps === 0) return;
    setBumping(true);
    const id = setTimeout(() => setBumping(false), 700);
    return () => clearTimeout(id);
  }, [bumps]);

  if (!view) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        {error && <p role="alert" className="text-center text-sm text-red">can&apos;t reach the indexer: {error}</p>}
        <div className="mx-auto h-12 w-52 rounded bg-card" />
        <div className="h-64 rounded bg-card" />
        <div className="h-14 rounded bg-card" />
      </div>
    );
  }

  const live = priceAt(view, now);
  const start = history.find((t) => t.takeoverCount === view.takeoverCount)?.newPrice ?? null;
  const fraction = view.king ? meltFraction(live.price, live.floor, start === null ? null : BigInt(start)) : 1;
  const colour = heat(view.meltBps);
  const atFloor = view.king !== null && live.price <= live.floor;
  const isKing = publicKey !== null && view.king === publicKey.toBase58();

  return (
    <>
      <TakeButton price={live.price} isKing={isKing} onTaken={refresh} />

      <section aria-label="the crown" className={`rounded bg-card p-5 sm:p-6 ${bumping ? "bump" : ""}`}>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <CrownGauge fraction={fraction} heat={colour} className="mx-auto w-40 shrink-0 sm:mx-0 sm:w-44" />
          <dl className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
            <Row label="king">
              {view.king ? <span className="text-sky">{short(view.king)}{isKing && " (you)"}</span> : <span className="text-muted">nobody yet</span>}
            </Row>
            {view.king && <Row label="reigning">{duration(now - view.reignStartedTs)}</Row>}
            {view.king && <Row label="earned this reign"><span className="text-mint">{sol(view.kingFeesThisReign, 4)} SOL</span></Row>}
            <Row label="crown price">
              <span className="text-xl font-semibold text-mint" data-testid="price">{sol(live.price, 4)} SOL</span>
              {view.king && !atFloor && <span className="text-muted"> ↓</span>}
            </Row>
            <div className="py-1">
              <div className="h-2.5 overflow-hidden rounded-sm bg-bg" role="presentation">
                <div className={`h-full ${BAR[colour]}`} style={{ width: `${Math.max(fraction * 100, 2)}%` }} />
              </div>
              <div className="num mt-1 text-xs text-muted">
                {!view.king ? "opening price, does not melt until someone takes it" : atFloor ? "at the floor" : `melting ${(view.meltBps / 100).toFixed(view.meltBps % 100 ? 1 : 0)}%/min`}
              </div>
            </div>
            <Row label="floor">{sol(live.floor, 4)} SOL</Row>
            <Row label="fees"><span className="text-mint">{sol(view.feesPerMinute, 4)} SOL/min</span></Row>
            <Row label="all-time fees">{sol(view.totalFees)} SOL</Row>
            <Row label="burned">{sol(view.totalBurnSol)} SOL</Row>
          </dl>
        </div>
        <p className="mt-4 text-xs text-muted">
          fees are the king&apos;s 95% share and update about once a minute, when they are paid out. the price ticks locally between updates.
        </p>
      </section>

      {error && <p role="alert" className="text-center text-sm text-red">can&apos;t reach the indexer, showing the last numbers: {error}</p>}

      <section aria-label="takeovers" className="flex flex-col gap-3">
        <h2 className="border-b border-line pb-1 text-sm text-muted">takeovers</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted">no takeovers yet. the first one pays the opening price.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((t, i) => <FeedCard key={t.signature} t={t} now={now} fresh={bumping && i === 0} />)}
          </ul>
        )}
      </section>
    </>
  );
}
