# Sunday Run Club brand art

## App icon (`icon.png`, declared as `icon.image` in `dapp.json`)

The tile is a cream running shoe in motion in front of a yellow rising
sun, on a black tile. One bold flat mark, no text, readable at 32 pt.
It follows the Homeroom brand framework (one simple mark on a rounded
tile, brand pairings) rather than the platform's default
Lucide-on-gradient style: the group chose this artwork in request #4.

| Element | Colour | Hex |
| --- | --- | --- |
| Tile background (full bleed) | Black | `#000000` |
| Sun (half disc on the horizon, behind the shoe, up and right) | Yellow | `#FFEE6F` |
| Shoe (side view, toe right, flat silhouette) | Cream | `#FFFEEA` |
| Sole stripe (cut-out line across the shoe) | Black | `#000000` |
| Motion lines (three rounded bars behind the heel) | Cream | `#FFFEEA` |

Pairings used: Black + Yellow, Cream + Black. The mark is drawn on a
unit grid (see `icon.svg`) rendered at scale 9.5 into 1024 × 1024, and
kept inside the central ~76% of the canvas so the platform's rounded
tile never clips it.

## Featured illustration (`featured-light.png`, `featured-dark.png`)

The same shoe, sun and motion lines, laid out wider (same unit grid at
scale 14, horizon on the ground-strip top) at 1920 × 1080 for the app's
featured spot in the Homeroom directory. `dapp.json` has no field for
featured artwork, so these files are committed here for whoever sets up
the directory entry; nothing references them yet.

| Element | Light | Dark |
| --- | --- | --- |
| Background | Cream `#FFFEEA` | Black `#000000` |
| Sun | Yellow `#FFEE6F` with a Black `#000000` outline (holds on cream) | Yellow `#FFEE6F` |
| Shoe | Black `#000000` | Cream `#FFFEEA` |
| Sole stripe (cut-out) | Cream `#FFFEEA` | Black `#000000` |
| Motion lines | Black `#000000` | Cream `#FFFEEA` |
| Ground strip (bottom 250 px) | Green `#A9CF97` with a Black `#000000` horizon line | Green `#A9CF97` |

Only brand colours are used: Black, Cream, Yellow, Green (the only
other colours are blended pixels along the smoothed edges).

## Rendering

Sources are the SVGs in this folder; the PNGs are flat renders of them.
No dependencies or scripts were added to the repo. Rendered with the
sandbox's global Playwright/Chromium (deviceScaleFactor 1, exact
viewport, opaque background), from a throwaway script outside the repo.
`rsvg-convert` works too:

```sh
rsvg-convert -w 1024 -h 1024 brand/icon.svg -o brand/icon.png
rsvg-convert -w 1920 -h 1080 brand/featured-light.svg -o brand/featured-light.png
rsvg-convert -w 1920 -h 1080 brand/featured-dark.svg -o brand/featured-dark.png
```

`icon.png` must stay under 256 KB (platform limit for `icon.image`);
the flat art renders at ~16 KB. The `icon.emoji` (👟) stays in
`dapp.json` as the fallback if the image ever fails validation.