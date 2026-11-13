import { Composition, Folder } from "remotion";
import { HowItWorks } from "./HowItWorks";
import { Earn } from "./scenes/Earn";
import { Intro } from "./scenes/Intro";
import { Melt } from "./scenes/Melt";
import { Outro } from "./scenes/Outro";
import { Take } from "./scenes/Take";
import { TwoWays } from "./scenes/TwoWays";
import { FPS } from "./theme";

const SIZE = { width: 1080, height: 1080, fps: FPS };

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="HowItWorks-Scenes">
      <Composition id="Intro" component={Intro} durationInFrames={90} {...SIZE} />
      <Composition id="Earn" component={Earn} durationInFrames={150} {...SIZE} />
      <Composition id="Take" component={Take} durationInFrames={150} {...SIZE} />
      <Composition id="Melt" component={Melt} durationInFrames={230} {...SIZE} />
      <Composition id="TwoWays" component={TwoWays} durationInFrames={150} {...SIZE} />
      <Composition id="Outro" component={Outro} durationInFrames={120} {...SIZE} />
    </Folder>
    {/* 890 frames of scenes minus 5 fades of 10 = 840 frames, 28 s */}
    <Composition id="HowItWorks" component={HowItWorks} durationInFrames={840} {...SIZE} />
  </>
);
