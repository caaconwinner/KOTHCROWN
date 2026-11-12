"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCrown, getHistory, LAZY_CRANK, pingCrank, type CrownView, type Takeover } from "./api";

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
  const [view, setView] = useState<CrownView | null>(null);
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
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Fees are only paid out when someone sends the sync transaction. Where no
  // always-on crank runs, an open page nudges the server to do it.
  useEffect(() => {
    if (!LAZY_CRANK) return;
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
