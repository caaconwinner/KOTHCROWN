import { Easing, interpolate, useCurrentFrame } from "remotion";
import { C, clamp } from "../theme";
import { Frame, Headline, Rise, sol, Sub } from "./common";

const Bar: React.FC<{ at: number; label: string; amount: string; color: string; width: number }> = ({ at, label, amount, color, width }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start", width: 840 }}>
      <div style={{ display: "flex", justifyContent: "space-between", width: "100%", fontSize: 46 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ color, fontWeight: 800 }}>{amount}</span>
      </div>
      <div style={{ height: 28, width: 840, background: C.card, borderRadius: 6, overflow: "hidden" }}>
        <div
          style={{
            height: "100%", background: color,
            width: interpolate(frame, [at, at + 20], [0, width], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          }}
        />
      </div>
    </div>
  );
};

export const Take: React.FC = () => (
  <Frame gap={56}>
    <Rise at={0}><Headline>anyone can take it.</Headline></Rise>
    <Rise at={10}>
      <Sub>pay the price: <span style={{ color: C.mint, fontWeight: 800 }}>{sol(1.2)}</span></Sub>
    </Rise>
    <Rise at={24}><Bar at={30} label="90% to the old king" amount={sol(1.08)} color={C.mint} width={756} /></Rise>
    <Rise at={44}><Bar at={50} label="10% burned" amount={sol(0.12)} color={C.gold} width={84} /></Rise>
  </Frame>
);
