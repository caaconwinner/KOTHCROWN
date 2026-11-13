import { interpolate, useCurrentFrame } from "remotion";
import { PixelCrown } from "../PixelCrown";
import { C, clamp } from "../theme";
import { Frame, Headline, Rise, sol, Sub } from "./common";

export const Earn: React.FC = () => {
  const frame = useCurrentFrame();
  const earned = interpolate(frame, [30, 120], [0, 1.82], clamp);
  return (
    <Frame>
      <Rise at={0}><Headline>one crown.</Headline></Rise>
      <Rise at={8}><PixelCrown size={360} color={C.gold} /></Rise>
      <Rise at={18}>
        <Sub>king <span style={{ color: C.sky }}>7xKp…Q2aa</span></Sub>
      </Rise>
      <Rise at={28}>
        <Sub color={C.white}>
          earns <span style={{ color: C.gold, fontWeight: 800 }}>85%</span> of the fees
        </Sub>
        <div style={{ fontSize: 72, fontWeight: 800, color: C.mint, marginTop: 16, fontVariantNumeric: "tabular-nums" }}>
          +{sol(earned)}
        </div>
      </Rise>
    </Frame>
  );
};
