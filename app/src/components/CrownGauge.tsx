"use client";

import { useEffect, useRef } from "react";
import { CROWN_BAND, CROWN_H, CROWN_MELT_ORDER, CROWN_W, pixelsGone, type Heat } from "@/lib/price";

const FILL: Record<Heat, string> = { gold: "#facc15", ember: "#fb923c", red: "#f87171" };
/** If many pixels are lost at once (a tab left in the background), only this many are shown falling. */
const MAX_FALLING = 12;

/**
 * Drops one pixel from where it sat in the crown to the bottom of the page,
 * over everything else. Purely decorative: it ignores clicks and removes
 * itself when it lands.
 */
function dropPixel(svg: SVGSVGElement, cell: { x: number; y: number }, colour: string, delayMs: number) {
  const box = svg.getBoundingClientRect();
  const size = box.width / CROWN_W;
  const top = box.top + window.scrollY + cell.y * size;
  const left = box.left + window.scrollX + cell.x * size;
  const distance = document.documentElement.scrollHeight - top - size;
  if (distance <= 0) return;
  const el = document.createElement("div");
  el.className = "falling-pixel";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { top: `${top}px`, left: `${left}px`, width: `${size}px`, height: `${size}px`, background: colour });
  document.body.appendChild(el);
  // Accelerates like something dropped: about 1.4s for a 900px fall.
  const duration = 450 * Math.sqrt(distance / 90);
  const fall = el.animate(
    [{ transform: "translateY(0)" }, { transform: `translateY(${distance}px)` }],
    { duration, delay: delayMs, easing: "cubic-bezier(0.55, 0, 1, 0.45)", fill: "both" },
  );
  fall.onfinish = fall.oncancel = () => el.remove();
}

/**
 * The pixel crown as the melt gauge. As the price falls from the last
 * takeover price to the floor, its pixels leave one at a time and fall down
 * the whole page, each leaving a hole where it was. The band (the floor)
 * never loses a pixel. A takeover puts every pixel back.
 */
export function CrownGauge({ fraction, heat, className }: { fraction: number; heat: Heat; className?: string }) {
  const gone = pixelsGone(fraction);
  const svg = useRef<SVGSVGElement>(null);
  const seen = useRef(gone); // pixels already missing when the page opened are not replayed

  useEffect(() => {
    const from = seen.current;
    seen.current = gone;
    if (gone <= from || !svg.current) return; // nothing new, or the crown was refilled
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const lost = CROWN_MELT_ORDER.slice(Math.max(from, gone - MAX_FALLING), gone);
    lost.forEach((cell, i) => dropPixel(svg.current!, cell, FILL[heat], i * 90));
    svg.current.dataset.fallen = String(Number(svg.current.dataset.fallen ?? 0) + lost.length);
  }, [gone, heat]);

  const pct = Math.round(fraction * 100);
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${CROWN_W} ${CROWN_H}`}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      data-gone={gone}
      aria-label={pct === 0 ? "the crown is at its floor price" : `the crown has ${pct}% left to melt`}
      fill={FILL[heat]}
    >
      {CROWN_MELT_ORDER.map((p, i) => (i < gone ? null : <rect key={i} x={p.x} y={p.y} width={1.03} height={1.03} />))}
      {CROWN_BAND.map((p) => <rect key={`b${p.x},${p.y}`} x={p.x} y={p.y} width={1.03} height={1.03} />)}
    </svg>
  );
}
