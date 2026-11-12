import { useId } from "react";
import { CROWN_BODY_ROWS, CROWN_ROWS, crownSink, type Heat } from "@/lib/price";

const FILL: Record<Heat, string> = { gold: "#facc15", ember: "#fb923c", red: "#f87171" };

const cells = (rows: string[], offset = 0) =>
  rows.flatMap((row, y) => [...row].map((c, x) => (c === "X" ? { x, y: y + offset } : null)).filter((c) => c !== null));
const BODY = cells(CROWN_ROWS.slice(0, CROWN_BODY_ROWS));
const BAND = cells(CROWN_ROWS.slice(CROWN_BODY_ROWS), CROWN_BODY_ROWS);

/**
 * The pixel crown as the melt gauge. It sinks into its band as the price
 * falls from the last takeover price to the floor. The band (the floor)
 * always stays.
 */
export function CrownGauge({ fraction, heat, className }: { fraction: number; heat: Heat; className?: string }) {
  const clip = useId();
  const sink = crownSink(fraction);
  const pct = Math.round(fraction * 100);
  return (
    <svg
      viewBox="0 0 11 6"
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
      {BAND.map((p) => <rect key={`${p.x},${p.y}`} x={p.x} y={p.y} width={1.02} height={1.02} />)}
    </svg>
  );
}
