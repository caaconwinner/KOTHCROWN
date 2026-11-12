import type { Heat } from "@/lib/price";

/** How fast the price melts, shown by the crown's colour. The colour the crown has now is lit, the others are faded. */
const ROWS: { heat: Heat; swatch: string; label: string; text: string }[] = [
  { heat: "gold", swatch: "bg-gold", label: "gold · under 6%/min", text: "trading is steady or rising" },
  { heat: "ember", swatch: "bg-ember", label: "orange · 6 to 8%/min", text: "trading is slowing down" },
  { heat: "red", swatch: "bg-red", label: "red · 8%/min", text: "trading has dried up. fastest melt" },
];

export function CrownLegend({ heat, className = "" }: { heat: Heat; className?: string }) {
  return (
    <ul aria-label="what the crown's colour means" className={`flex flex-col justify-center gap-3 text-xs ${className}`}>
      {ROWS.map((r) => {
        const on = r.heat === heat;
        return (
          <li
            key={r.heat}
            aria-current={on ? "true" : undefined}
            data-testid={`legend-${r.heat}`}
            className={`flex items-start gap-2 transition-opacity duration-500 ${on ? "opacity-100" : "opacity-40"}`}
          >
            <span aria-hidden className={`mt-0.5 h-2.5 w-2.5 shrink-0 ${r.swatch}`} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-white">{r.label}</span>
              <span className="block leading-snug text-muted">{r.text}</span>
            </span>
            <span aria-hidden className={`shrink-0 text-base leading-none text-white ${on ? "" : "invisible"}`}>→</span>
          </li>
        );
      })}
    </ul>
  );
}
