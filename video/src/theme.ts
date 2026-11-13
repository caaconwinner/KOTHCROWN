import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// The site's colours (docs/DESIGN.md): gold is the crown, mint is SOL, sky is a person.
export const C = {
  bg: "#1b1d28",
  card: "#2e303a",
  line: "#3a3d4a",
  muted: "#9ca3af",
  white: "#ffffff",
  mint: "#86efac",
  sky: "#93c5fd",
  gold: "#facc15",
  ember: "#fb923c",
  red: "#f87171",
};

export const FONT = "Inter";
export const FPS = 30;

for (const w of ["400", "600", "800"]) {
  loadFont({ family: FONT, url: staticFile(`fonts/inter-latin-${w}-normal.woff2`), weight: w });
}

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
