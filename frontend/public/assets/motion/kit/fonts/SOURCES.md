# The sketch fonts

The fonts the Excalidraw sketch look (kit/sketch.ts) and imported Excalidraw drawings (kit/excalidraw.ts) use,
copied unchanged from the npm package `@excalidraw/excalidraw` 0.18.0 (`dist/dev/fonts/`). Only the Latin
subsets are kept; the unicode ranges each file serves are written in kit/sketch.ts (FONT_FILES), as Excalidraw
declares them. The player registers them in the page with the FontFace API, only when a scene uses the sketch
look or a drawing.

| File | Font | Excalidraw fontFamily | Licence |
|------|------|-----------------------|---------|
| Virgil-Regular.woff2 | Virgil, Excalidraw's first hand font | 1 | SIL Open Font License 1.1 (OFL.txt) |
| Excalifont-Latin.woff2, Excalifont-LatinExt.woff2 | Excalifont, Excalidraw's hand font since 2024 | 5 | SIL Open Font License 1.1 (OFL.txt) |
| CascadiaCode-Regular.woff2 | Cascadia Code (Microsoft) | 3 | SIL Open Font License 1.1 (OFL.txt) |
| Nunito-Latin.woff2 | Nunito (weight 500) | 6 | SIL Open Font License 1.1 (OFL.txt) |
| LilitaOne-Latin.woff2 | Lilita One | 7 | SIL Open Font License 1.1 (OFL.txt) |
| ComicShanns-Latin.woff2 | Comic Shanns | 8 | MIT License |
| LiberationSans-Regular.woff2 | Liberation Sans | 9 | SIL Open Font License 1.1 (OFL.txt) |

Helvetica (fontFamily 2) is the system's own font, as in Excalidraw.

The drawing itself is done by two npm packages pinned in frontend/package.json, each shipping its licence:
rough.js 4.6.6 (MIT, the strokes and fills) and perfect-freehand 1.2.2 (MIT, the freehand strokes).

The fonts are only used, never renamed or sold on their own; the OFL lets them be bundled with software and
used in the videos the software makes.
