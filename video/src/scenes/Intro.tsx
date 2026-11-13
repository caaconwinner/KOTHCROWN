import { Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { clamp } from "../theme";
import { Frame, Rise, Sub } from "./common";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Frame gap={64}>
      <Img
        src={staticFile("wordmark.svg")}
        style={{
          width: 760,
          scale: interpolate(frame, [0, 18], [0.85, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          opacity: interpolate(frame, [0, 10], [0, 1], clamp),
        }}
      />
      <Rise at={20}>
        <Sub color="#ffffff">the crown gets cheaper every minute.</Sub>
      </Rise>
    </Frame>
  );
};
