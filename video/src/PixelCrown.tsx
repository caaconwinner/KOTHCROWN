import { interpolate, useCurrentFrame } from "remotion";

// The logo's crown, 11 x 6, drawn from 3 x 3 small pixels like on the site.
const CROWN = ["X....X....X", "X....X....X", "XX..XXX..XX", "XXXXXXXXXXX", "XXXXXXXXXXX", "XXXXXXXXXXX"];
const S = 3;
const BAND_ROWS = 3 * S; // the bottom three logo rows (the floor) never melt

type Cell = { x: number; y: number; band: boolean };
const CELLS: Cell[] = [];
CROWN.forEach((row, ly) => [...row].forEach((c, lx) => {
  if (c !== "X") return;
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
    const y = ly * S + dy;
    CELLS.push({ x: lx * S + dx, y, band: y >= CROWN.length * S - BAND_ROWS });
  }
}));
// Deterministic scatter, leaning toward the top, like the site's melt order.
const BODY = CELLS.filter((c) => !c.band)
  .map((c, i) => ({ c, k: ((i * 2654435761) % 1000) / 1000 + c.y * 0.04 }))
  .sort((a, b) => a.k - b.k)
  .map((e) => e.c);
const ORDER = new Map(BODY.map((c, i) => [c, i]));

/**
 * `gone`: how many body pixels have left (0 to all). Pixels that left in the
 * last `fallFrames` frames are drawn falling down; older ones are holes.
 */
export const PixelCrown: React.FC<{ size: number; color: string; gone?: (frame: number) => number; fallFrames?: number }> = ({
  size, color, gone = () => 0, fallFrames = 40,
}) => {
  const frame = useCurrentFrame();
  const px = size / (11 * S);
  const now = Math.floor(gone(frame));
  const leftAt = (i: number) => {
    // First frame at which pixel i had gone (search back a little).
    for (let f = frame; f > frame - fallFrames; f--) if (Math.floor(gone(f - 1)) <= i) return f;
    return -Infinity;
  };
  return (
    <div style={{ position: "relative", width: size, height: px * CROWN.length * S }}>
      {CELLS.map((c, idx) => {
        const order = c.band ? -1 : ORDER.get(c)!;
        const isGone = order >= 0 && order < now;
        let dy = 0;
        let opacity = 1;
        if (isGone) {
          const t = frame - leftAt(order);
          if (t >= fallFrames) return null;
          dy = interpolate(t, [0, fallFrames], [0, 700], { extrapolateRight: "clamp", easing: (v) => v * v });
          opacity = interpolate(t, [fallFrames * 0.6, fallFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        }
        return (
          <div
            key={idx}
            style={{ position: "absolute", left: c.x * px, top: c.y * px + dy, width: px + 0.5, height: px + 0.5, background: color, opacity }}
          />
        );
      })}
    </div>
  );
};

export const BODY_PIXELS = BODY.length;
