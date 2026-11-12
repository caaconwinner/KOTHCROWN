import type { Heat } from "@/lib/price";

/** How fast the price melts, shown by the crown's colour. The crown's colour now is lit, the others are faded. */
const ROWS: { heat: Heat; colour: string; label: string; note: string }[] = [
  { heat: "gold", colour: "text-gold", label: "gold · under 6% a minute", note: "trading is steady or rising. the price melts slowly" },
  { heat: "ember", colour: "text-ember", label: "orange · 6 to 8% a minute", note: "trading is slowing down. the price melts faster" },
  { heat: "red", colour: "text-red", label: "red · 8% a minute", note: "trading has dried up. the price melts as fast as it can" },
];

/** A hand-drawn swoosh ending in an arrowhead, pointing right (or up). */
function Arrow({ className, up = false }: { className: string; up?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 72 32" className={`${className} ${up ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10 C 22 2, 42 6, 64 20" />
      <path d="M50 22 L 64 20 L 60 7" />
    </svg>
  );
}

/**
 * `side`: in the empty space left of the page on wide screens, one arrow per colour pointing at the crown.
 * `below`: under the crown on narrower screens, arrows pointing up at it.
 */
export function CrownLegend({ heat, variant, className = "" }: { heat: Heat; variant: "side" | "below"; className?: string }) {
  const side = variant === "side";
  return (
    <ul aria-label="what the crown's colour means" className={`flex flex-col ${side ? "gap-6" : "gap-3"} ${className}`}>
      {ROWS.map((r) => {
        const on = r.heat === heat;
        return (
          <li
            key={r.heat}
            aria-current={on ? "true" : undefined}
            data-testid={`legend-${variant}-${r.heat}`}
            className={`flex items-center gap-3 transition-opacity duration-500 ${on ? "opacity-100" : "opacity-30"} ${side ? "" : "flex-row-reverse"}`}
          >
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-bold ${r.colour}`}>{r.label}</span>
              <span className="block text-xs leading-snug text-muted">{r.note}</span>
            </span>
            <Arrow up={!side} className={`shrink-0 ${side ? "h-8 w-16" : "h-6 w-6"} ${r.colour}`} />
          </li>
        );
      })}
    </ul>
  );
}
