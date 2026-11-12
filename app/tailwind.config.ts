import type { Config } from "tailwindcss";

// Colours from docs/DESIGN.md. One job each: gold is the crown, mint is SOL,
// sky is a person.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#1b1d28",
        card: "#2e303a",
        line: "#3a3d4a",
        muted: "#9ca3af",
        mint: "#86efac",
        "mint-soft": "#a6e9b0",
        sky: "#93c5fd",
        gold: "#facc15",
        ember: "#fb923c",
        red: "#f87171",
      },
      fontFamily: { sans: ["var(--font-inter)", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
