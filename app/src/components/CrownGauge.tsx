"use client";

import { useRef } from "react";
import { CROWN_BAND, CROWN_H, CROWN_MELT_ORDER, CROWN_W, pixelsGone, type Heat } from "@/lib/price";

const FILL: Record<Heat, string> = { gold: "#facc15", ember: "#fb923c", red: "#f87171" };
/** Room under the crown for a pixel to fall into. */
const FALL_ROOM = 5;

/**
 * The pixel crown as the melt gauge. As the price falls from the last
 * takeover price to the floor, its pixels fall off one at a time and leave a
 * hole where they were. The band (the floor) never loses a pixel. A takeover
 * puts every pixel back.
 */
export function CrownGauge({ fraction, heat, className }: { fraction: number; heat: Heat; className?: string }) {
  const gone = pixelsGone(fraction);
  // Pixels that were already missing when the page opened (or when the crown
  // was last refilled) are simply absent. Only ones lost since then are drawn
  // falling, so a page load does not start with a shower.
  const settled = useRef(gone);
  if (gone < settled.current) settled.current = gone;

  const pct = Math.round(fraction * 100);
  return (
    <svg
      viewBox={`0 0 ${CROWN_W} ${CROWN_H + FALL_ROOM}`}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      data-gone={gone}
      aria-label={pct === 0 ? "the crown is at its floor price" : `the crown has ${pct}% left to melt`}
      fill={FILL[heat]}
    >
      {CROWN_MELT_ORDER.map((p, i) => {
        if (i < settled.current) return null;
        return <rect key={i} x={p.x} y={p.y} width={1.03} height={1.03} className={i < gone ? "fell" : undefined} />;
      })}
      {CROWN_BAND.map((p) => <rect key={`b${p.x},${p.y}`} x={p.x} y={p.y} width={1.03} height={1.03} />)}
    </svg>
  );
}
