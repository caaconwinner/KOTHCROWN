import type { Heat } from "@/lib/price";

/** How fast the price melts, shown by the crown's colour. The crown's colour now is lit, the others are faded. */
const ROWS: { heat: Heat; colour: string; label: string; note: string }[] = [
  { heat: "gold", colour: "text-gold", label: "gold · under 6% a minute", note: "trading is steady or rising. the price melts slowly" },
  { heat: "ember", colour: "text-ember", label: "orange · 6 to 8% a minute", note: "trading is slowing down. the price melts faster" },
  { heat: "red", colour: "text-red", label: "red · 8% a minute", note: "trading has dried up. the price melts as fast as it can" },
];

/**
 * `side`: in the empty space left of the page on wide screens.
 * `below`: under the crown on narrower screens.
 */
export function CrownLegend({ heat, variant, className = "" }: { heat: Heat; variant: "side" | "below"; className?: string }) {
  const side = variant === "side";
  return (
    <ul aria-label="what the crown's colour means" className={`flex flex-col ${side ? "gap-6 text-right" : "gap-3"} ${className}`}>
      {ROWS.map((r) => {
        const on = r.heat === heat;
        return (
          <li
            key={r.heat}
            aria-current={on ? "true" : undefined}
            data-testid={`legend-${variant}-${r.heat}`}
            className={`transition-opacity duration-500 ${on ? "opacity-100" : "opacity-30"}`}
          >
            <span>
              <span className={`block text-sm font-bold ${r.colour}`}>{r.label}</span>
              <span className="block text-xs leading-snug text-muted">{r.note}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
