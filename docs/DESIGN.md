# Design: early-memecoin "King of the Hill" look

The site should feel like the 2024-era memecoin launchpad homepages, where a "king of the hill" coin sat at the top of a dark, low-fi page. Inspired by that era. **Do not copy any platform's logo, wordmark, name or exact assets.** Our own name, our own crown mark.

## What the original looked like (research notes)

Measured from an archived June 2024 snapshot of that homepage:
- Page background: `#1b1d28` (rgb 27, 29, 40), measured.
- Font: Inter, measured.
- Text links written in square brackets: `[twitter] [support] [telegram]` top-left, and a big centered `[start a new coin]`.
- Search field filled with pale mint green (about `#a6e9b0`), dark text, with a separate green `search` button.
- Loading skeleton blocks in slate gray (about `#2e303a`).
- The "king of the hill" coin sat centered at the top: coin image on the left, details on the right (name, ticker, created by, market cap, replies).

From memory of the era (not measured, confirm with screenshots if possible):
- Market cap text in green, "created by" usernames in a light blue.
- New activity made a coin card shake and flash yellow (the "bump" animation).
- Very plain, almost unstyled: no gradients, no shadows, small rounded corners, lots of dark space.

## Our palette

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#1b1d28` | Page |
| `--card` | `#2e303a` | Cards, skeletons |
| `--text` | `#ffffff` | Main text |
| `--muted` | `#9ca3af` | Secondary text |
| `--mint` | `#86efac` | Prices, fee speed, primary button |
| `--mint-soft` | `#a6e9b0` | Inputs |
| `--sky` | `#93c5fd` | Wallet addresses / usernames |
| `--gold` | `#facc15` | Crown, takeover flash |
| `--red` | `#f87171` | Melt bar, "dying" state |

Font: Inter (via `next/font`). Numbers use tabular figures so the ticking price doesn't jiggle.

## Layout: the throne page `/`

```
[twitter] [telegram] [how it works]                     [connect wallet]

                         [take the crown]

        ┌──────────── king of the hill ────────────┐
        │  [crown img]   king: 7xKp…Q2a            │
        │                reigning: 4m 12s          │
        │                earned this reign: 1.82 SOL│
        │                crown price: 3.41 SOL ↓   │
        │                ██████████░░░ melt 4%/min │
        │                floor: 1.40 SOL           │
        │                fees: 0.14 SOL/min        │
        └──────────────────────────────────────────┘

   takeovers ──────────────────────────────────────────
   [card] 7xKp… took it from FiR2… for 4.2 SOL · 0.42 burned · 2m ago
   [card] FiR2… took it from 9aBc… for 2.9 SOL · 0.29 burned · 9m ago
   ...

   [hall of kings]
```

## Motion

- **Bump:** when a `CrownTaken` event arrives, the king card shakes (CSS `transform: translateX` keyframes, ~400ms) and flashes `--gold` background for ~600ms. The new feed card slides in at the top with the same flash.
- **Ticking price:** updates every second from the local melt calculation.
- **Melt bar:** shrinks toward the floor; turns `--red` when melt ≥ 6%/min.
- Respect `prefers-reduced-motion`: no shake, just the color flash.

## Copy style

Lowercase, short, bracketed actions: `[take the crown]`, `[how it works]`, `[hall of kings]`. Numbers always with units ("3.41 SOL").
