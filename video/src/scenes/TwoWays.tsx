import { C } from "../theme";
import { Frame, Headline, Rise, Sub } from "./common";

const Point: React.FC<{ n: string; text: string }> = ({ n, text }) => (
  <div style={{ display: "flex", gap: 28, alignItems: "baseline", fontSize: 54, textAlign: "left" }}>
    <span style={{ color: C.gold, fontWeight: 800 }}>{n}</span>
    <span>{text}</span>
  </div>
);

export const TwoWays: React.FC = () => (
  <Frame gap={56}>
    <Rise at={0}><Headline>you win two ways.</Headline></Rise>
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <Rise at={14}><Point n="1." text="earn fees while you hold it" /></Rise>
      <Rise at={30}><Point n="2." text="get paid when someone takes it" /></Rise>
    </div>
    <Rise at={60}><Sub>you can lose money too. play small.</Sub></Rise>
  </Frame>
);
