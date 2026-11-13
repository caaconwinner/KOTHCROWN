import type { Heat } from "@/lib/price";

const pct = (bps: number) => `${+(bps / 100).toFixed(1)}%`;

/** How fast the price melts, shown by the crown's colour. The crown's colour now is lit, the others are faded. */
const rows = (maxBps: number, baseBps: number): { heat: Heat; colour: string; label: string; note: string }[] => {
  const mid = (baseBps + maxBps) / 2;
  return [
    { heat: "gold", colour: "text-gold", label: `gold · under ${pct(mid)} a minute`, note: "trading is steady or rising. the price melts slowly" },
    { heat: "ember", colour: "text-ember", label: `orange · ${pct(mid)} to ${pct(maxBps)} a minute`, note: "trading is slowing down. the price melts faster" },
    { heat: "red", colour: "text-red", label: `red · ${pct(maxBps)} a minute`, note: "trading has dried up. the price melts as fast as it can" },
  ];
};

/**
 * `side`: in the empty space left of the page on wide screens.
 * `below`: under the crown on narrower screens.
 */
export function CrownLegend({ heat, variant, maxBps, baseBps, className = "" }: { heat: Heat; variant: "side" | "below"; maxBps: number; baseBps: number; className?: string }) {
  const side = variant === "side";
  return (
    <ul aria-label="what the crown's colour means" className={`flex flex-col ${side ? "gap-6 text-right" : "gap-3"} ${className}`}>
      {rows(maxBps, baseBps).map((r) => {
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
