import { interpolate, useCurrentFrame } from "remotion";
import { BODY_PIXELS, PixelCrown } from "../PixelCrown";
import { C, clamp } from "../theme";
import { Frame, Headline, Rise, sol, Sub } from "./common";

// 0-30: the price jumps 1.20 -> 1.74. 30-200: it melts down to the 0.1 SOL minimum.
const JUMP_END = 30;
const MELT_END = 200;

export const Melt: React.FC = () => {
  const frame = useCurrentFrame();
  const price = frame < JUMP_END
    ? interpolate(frame, [8, JUMP_END], [1.2, 1.74], clamp)
    : interpolate(frame, [JUMP_END, MELT_END], [1.74, 0.1], clamp);
  // Colour follows how fast it melts: gold, then orange, then red.
  const color = frame < 90 ? C.gold : frame < 140 ? C.ember : C.red;
  const label = frame < 90
    ? "gold · melting slowly (high volume)"
    : frame < 140
      ? "orange · melting faster (volume dropping)"
      : "red · melting fastest (low volume)";
  return (
    <Frame gap={44}>
      <Rise at={0}><Headline>then it melts.</Headline></Rise>
      <div style={{ fontSize: 120, fontWeight: 800, color: C.mint, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>
        {sol(price, 4)}
      </div>
      <PixelCrown
        size={340}
        color={color}
        gone={(f) => interpolate(f, [JUMP_END, MELT_END], [0, BODY_PIXELS], clamp)}
      />
      <Rise at={JUMP_END}>
        <Sub color={color}>{label}</Sub>
      </Rise>
      <Rise at={150}>
        <Sub>never below <span style={{ color: C.white, fontWeight: 600 }}>0.1 SOL</span></Sub>
      </Rise>
    </Frame>
  );
};
