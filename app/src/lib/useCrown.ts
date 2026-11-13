"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCrown, getHistory, LAZY_CRANK, LIVE, pingCrank, type CrownView, type Takeover } from "./api";

/** Before launch: the throne page with every number at zero. */
const PRELAUNCH_VIEW: CrownView = {
  mint: "", king: null, price: "0", floor: "0", meltBps: 0, feesPerMinute: "0", checkpointPrice: "0",
  checkpointTs: 0, reignStartedTs: 0, kingFeesThisReign: "0", takeoverCount: 0, totalFees: "0",
  totalBurnSol: "0", totalTokensBurned: "0", burnBucketLamports: "0", locked: false, params: {}, now: 0,
};

const POLL_MS = 5_000;

export interface CrownData {
  view: CrownView | null;
  history: Takeover[];
  error: string | null;
  /** Seconds to add to this device's clock to get the server's. */
  clockOffset: number;
  /** Goes up by one each time the crown changes hands while the page is open. */
  bumps: number;
  refresh: () => void;
}

/** Polls the indexer. The price itself is not polled: see `priceAt`. */
export function useCrown(): CrownData {
  const [view, setView] = useState<CrownView | null>(LIVE ? null : PRELAUNCH_VIEW);
  const [history, setHistory] = useState<Takeover[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [bumps, setBumps] = useState(0);
  const lastCount = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, h] = await Promise.all([getCrown(), getHistory()]);
      setClockOffset(v.now - Date.now() / 1000);
      if (lastCount.current !== null && v.takeoverCount > lastCount.current) setBumps((b) => b + 1);
      lastCount.current = v.takeoverCount;
      setView(v);
      setHistory(h);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!LIVE) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Fees are only paid out when someone sends the sync transaction. Where no
  // always-on crank runs, an open page nudges the server to do it.
  useEffect(() => {
    if (!LAZY_CRANK || !LIVE) return;
    pingCrank();
    const id = setInterval(pingCrank, 60_000);
    return () => clearInterval(id);
  }, []);

  return { view, history, error, clockOffset, bumps, refresh: load };
}

/** Re-renders once a second and returns the server-adjusted time in seconds. */
export function useNow(clockOffset: number): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(id);
  }, []);
  return now + clockOffset;
}
