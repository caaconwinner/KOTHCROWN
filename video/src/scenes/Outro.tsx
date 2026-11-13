import { Img, staticFile } from "remotion";
import { C } from "../theme";
import { Frame, Rise } from "./common";

export const Outro: React.FC = () => (
  <Frame gap={56}>
    <Rise at={0}><Img src={staticFile("wordmark.svg")} style={{ width: 760 }} /></Rise>
    <Rise at={12}>
      <div style={{ fontSize: 64, fontWeight: 800, color: C.white }}>takethecrown.fun</div>
    </Rise>
  </Frame>
);
