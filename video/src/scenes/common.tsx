import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { C, clamp, FONT } from "../theme";

/** Dark background, content centred, safe area kept. */
export const Frame: React.FC<{ children: React.ReactNode; gap?: number }> = ({ children, gap = 48 }) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg, fontFamily: FONT, color: C.white,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "100px 80px", gap, textAlign: "center",
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Fades and lifts in from `at` frames. */
export const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, children, style }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        opacity: interpolate(frame, [at, at + 12], [0, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        translate: interpolate(frame, [at, at + 12], ["0px 30px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Headline: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 92, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.02 }}>{children}</div>
);

export const Sub: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = C.muted }) => (
  <div style={{ fontSize: 46, fontWeight: 400, color, lineHeight: 1.25 }}>{children}</div>
);

export const sol = (v: number, d = 2) => `${v.toFixed(d)} SOL`;
