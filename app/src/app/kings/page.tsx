"use client";

import { useEffect, useState } from "react";
import { getLeaderboard, LIVE, type Entry, type Leaderboard } from "@/lib/api";
import { duration, short, sol } from "@/lib/price";

function Board({ title, entries, format, empty }: { title: string; entries: Entry[]; format: (v: string) => string; empty: string }) {
  return (
    <section className="rounded bg-card p-4">
      <h2 className="mb-2 text-sm text-muted">{title}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {entries.map((e, i) => (
            <li key={`${e.king}-${e.signature ?? i}`} className="flex items-baseline justify-between gap-3">
              <span><span className="num text-muted">{i + 1}.</span> <span className="text-sky">{short(e.king)}</span></span>
              <span className="num">{format(e.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function Kings() {
  const [lb, setLb] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!LIVE) return;
    getLeaderboard().then(setLb).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!LIVE) return <p className="text-center text-sm text-muted">no kings yet. the crown has not launched.</p>;
  if (error) return <p role="alert" className="text-center text-sm text-red">can&apos;t reach the indexer: {error}</p>;
  if (!lb) return <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-40 rounded bg-card" />)}</div>;

  const none = "nobody yet.";
  return (
    <>
      <h1 className="text-center text-xl font-semibold">hall of kings</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <Board title="longest reign" entries={lb.longestReign} format={(v) => duration(Number(v))} empty={none} />
        <Board title="most earned in fees" entries={lb.mostEarned} format={(v) => `${sol(v)} SOL`} empty={none} />
        <Board title="biggest takeover" entries={lb.biggestTakeover} format={(v) => `${sol(v)} SOL`} empty={none} />
        <Board title="most burned" entries={lb.mostBurned} format={(v) => `${sol(v)} SOL`} empty={none} />
      </div>
      <p className="num text-center text-sm text-muted">
        {lb.totals.takeovers} takeovers · {sol(lb.totals.solBoughtBack)} SOL spent on buybacks ·{" "}
        {(Number(lb.totals.tokensBurned) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} $CROWN burned
      </p>
      <p className="text-center text-xs text-muted">finished reigns only. the reign in progress is on the front page.</p>
    </>
  );
}
