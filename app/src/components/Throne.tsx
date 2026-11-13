"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CrownGauge } from "./CrownGauge";
import { ClaimButton } from "./ClaimButton";
import { CrownLegend } from "./CrownLegend";
import { TakeButton } from "./TakeButton";
import { ago, duration, heat, meltFraction, priceAt, short, sol } from "@/lib/price";
import { useCrown, useNow } from "@/lib/useCrown";
import { LIVE, type Takeover } from "@/lib/api";

const BAR: Record<string, string> = { gold: "bg-gold", ember: "bg-ember", red: "bg-red" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2">
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

  const melt = `${(view.meltBps / 100).toFixed(view.meltBps % 100 ? 1 : 0)}%`;

  return (
    <>
      <section aria-label="the crown" className={`grid gap-6 sm:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)] sm:gap-8 ${bumping ? "bump" : ""}`}>
        <div className="flex flex-col gap-4">
          <div className="relative">
            <CrownLegend heat={colour} variant="side" className="absolute right-full top-1/2 mr-6 hidden w-56 -translate-y-1/2 xl:flex" />
            <div className="plate rounded bg-card px-16 py-6 sm:px-6 sm:py-8">
              <CrownGauge fraction={fraction} heat={colour} className="w-full" />
            </div>
          </div>
          <CrownLegend heat={colour} variant="below" className="xl:hidden" />
          <dl className="flex flex-col text-sm">
            <Row label="all-time fees">{sol(view.totalFees)} SOL</Row>
            <Row label="burned">{sol(view.totalBurnSol)} SOL</Row>
          </dl>
        </div>

        <div className="flex min-w-0 flex-col">
          <h1 className="text-4xl font-extrabold leading-none tracking-tight sm:text-[42px]">the crown</h1>
          <p className="mt-2 max-w-md text-sm text-muted">
            pays the king 85% of the fees on every $CROWN trade. sold to whoever pays the price below. the last king receives 90% of it.
          </p>

          <p className="num mt-5 text-[40px] font-extrabold leading-none tracking-tight text-mint sm:text-[52px]">
            <span data-testid="price">{sol(live.price, 4)} SOL</span>
            {view.king && !atFloor && <span className="text-xl font-normal text-muted"> ↓</span>}
          </p>
          <div className="mt-3 h-2.5 overflow-hidden rounded-sm bg-card" role="presentation">
            <div className={`h-full ${BAR[colour]}`} style={{ width: `${Math.max(fraction * 100, 2)}%` }} />
          </div>
          <p className="num mt-1.5 text-[13px] text-muted">
            {!LIVE
              ? "$CROWN is not live yet"
              : !view.king
              ? "opening price · does not fall until someone takes it"
              : atFloor
                ? `at the floor · will not go below ${sol(live.floor, 4)} SOL`
                : `falling ${melt} a minute · will not go below ${sol(live.floor, 4)} SOL`}
          </p>

          <dl className="mt-4 flex flex-col text-sm">
            <Row label="king">
              {view.king ? <span className="text-sky">{short(view.king)}{isKing && " (you)"}</span> : <span className="text-muted">nobody yet</span>}
            </Row>
            {view.king && <Row label="reigning">{duration(now - view.reignStartedTs)}</Row>}
            {view.king && <Row label="earned this reign"><span className="text-mint">{sol(view.kingFeesThisReign, 4)} SOL</span></Row>}
            <Row label="fees now"><span className="text-mint">{sol(view.feesPerMinute, 4)} SOL a minute</span></Row>
          </dl>

          <div className="mt-4">
            {LIVE ? (
              <TakeButton price={live.price} isKing={isKing} onTaken={refresh} />
            ) : (
              <button disabled className="w-full rounded bg-mint px-6 py-3 text-lg font-semibold text-bg opacity-60">[not live yet]</button>
            )}
            {isKing && <div className="mt-3"><ClaimButton onClaimed={refresh} /></div>}
          </div>
        </div>
      </section>

      <p className="text-center text-xs text-muted">
        fees are the king&apos;s 85% share. the king claims them with a button, and every takeover pays out what the old king is owed. the price ticks locally.
      </p>

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
