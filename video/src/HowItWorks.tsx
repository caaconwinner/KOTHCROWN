import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Earn } from "./scenes/Earn";
import { Intro } from "./scenes/Intro";
import { Melt } from "./scenes/Melt";
import { Outro } from "./scenes/Outro";
import { Take } from "./scenes/Take";
import { TwoWays } from "./scenes/TwoWays";

export const FADE = 10;

export const HowItWorks: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="Intro" durationInFrames={90}><Intro /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
    <TransitionSeries.Sequence name="Earn" durationInFrames={150}><Earn /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
    <TransitionSeries.Sequence name="Take" durationInFrames={150}><Take /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
    <TransitionSeries.Sequence name="Melt" durationInFrames={230}><Melt /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
    <TransitionSeries.Sequence name="TwoWays" durationInFrames={150}><TwoWays /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
    <TransitionSeries.Sequence name="Outro" durationInFrames={120}><Outro /></TransitionSeries.Sequence>
  </TransitionSeries>
);
