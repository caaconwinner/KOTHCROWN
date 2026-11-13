# How it works video

Remotion project for the 28-second square explainer (1080x1080, the site's colours and font).

```bash
cd video
npm i
npx remotion studio          # preview and edit
npx remotion render HowItWorks out/how-it-works.mp4
```

Scenes are in `src/scenes/`, one file each; timing is in `src/HowItWorks.tsx` and `src/Root.tsx`.
