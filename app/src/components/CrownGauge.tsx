import { useId } from "react";
import { CROWN_BODY_ROWS, CROWN_ROWS, crownSink, type Heat } from "@/lib/price";

const FILL: Record<Heat, string> = { gold: "#facc15", ember: "#fb923c", red: "#f87171" };

const cells = (rows: string[], offset = 0) =>
  rows.flatMap((row, y) => [...row].map((c, x) => (c === "X" ? { x, y: y + offset } : null)).filter((c) => c !== null));
const BODY = cells(CROWN_ROWS.slice(0, CROWN_BODY_ROWS));
const BAND = cells(CROWN_ROWS.slice(CROWN_BODY_ROWS), CROWN_BODY_ROWS);

/** Drips hanging under the band, as in the logo: [column, length in pixels]. */
const DRIPS: [number, number][] = [[1, 1], [7, 2]];
/** Drops that fall while the crown is melting: [column, row it starts from,
 * share of the cycle to wait]. Spread across the band and out of step with
 * each other, so something is always falling. */
const DROPS: [number, number, number][] = [
  [7, 8, 0], [1, 7, 0.37], [4, 6, 0.71], [9, 6, 0.18], [2, 6, 0.55], [5, 6, 0.9], [10, 6, 0.46], [0, 6, 0.82],
];

/**
 * The pixel crown as the melt gauge. It sinks into its band as the price
 * falls from the last takeover price to the floor, and while it is melting
 * drops fall from it, eight of them out of step: each column drips about
 * every 2.4 seconds at 2%/min and every 0.6 seconds at 8%/min. The band (the floor) always stays.
 */
export function CrownGauge({ fraction, heat, meltBps = 0, className }: {
  fraction: number;
  heat: Heat;
  /** Melt rate while the crown is melting; 0 (or omitted) for a still crown. */
  meltBps?: number;
  className?: string;
}) {
  const clip = useId();
  const sink = crownSink(fraction);
  const pct = Math.round(fraction * 100);
  const melting = meltBps > 0;
  const cycle = melting ? Math.min(3, Math.max(0.5, 480 / meltBps)) : 0; // seconds per drop, per column
  return (
    <svg
      viewBox={melting ? "0 0 11 11" : "0 0 11 6"}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      data-sink={sink}
      aria-label={pct === 0 ? "the crown is at its floor price" : `the crown has ${pct}% left to melt`}
      fill={FILL[heat]}
    >
      <clipPath id={clip}>
        <rect x={0} y={0} width={11} height={CROWN_BODY_ROWS} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <g transform={`translate(0 ${sink})`}>
          {BODY.map((p) => <rect key={`${p.x},${p.y}`} x={p.x} y={p.y} width={1.02} height={1.02} />)}
        </g>
      </g>
      {/* Starts a hair above its row so no seam shows when the body sits at a fractional offset. */}
      {BAND.map((p) => <rect key={`${p.x},${p.y}`} x={p.x} y={p.y - 0.03} width={1.02} height={1.05} />)}
      {melting && DRIPS.map(([x, len]) => <rect key={`drip${x}`} x={x} y={5.98} width={1.02} height={len + 0.02} />)}
      {melting && DROPS.map(([x, y, wait]) => (
        <rect
          key={`drop${x}-${y}`}
          className="drop"
          x={x}
          y={y}
          width={1.02}
          height={1.02}
          style={{ animationDuration: `${cycle}s`, animationDelay: `${-(cycle * wait).toFixed(2)}s` }}
        />
      ))}
    </svg>
  );
}
