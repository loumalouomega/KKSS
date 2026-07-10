# Icon sources

TikZ-drawn icons for KKSS, sharing the visual language and build pipeline of
the two submodules' `icons/` directories ([cad/icons](../cad/icons),
[mesh/icons](../mesh/icons)) — `open.tex` is copied verbatim from mesh, and
`preMode.tex` reuses the isometric-cube technique of cad's `addBox`/`volume`
icons, so all three projects look like one family.

Two independent sets:

| Set | Sources | Output | Use |
| --- | --- | --- | --- |
| Shell toolbar icons | `tikz-ui/*.tex` | `svg-ui/*.svg` → generated `../app/renderer/shell/shellIcons.ts` | Mode-toggle + Open buttons (monochrome, `currentColor`, theme-adaptive) |
| Application icon | `tikz-app/kkss.tex` | `app/icon-1024.png`, `app/icon.png` (512), `app/icon-256.png` | electron-builder installers (`electron-builder.yml`) + Linux window icon (`out/icon.png`) |

All `tikz-ui` sources use the shared `tikzpicture` options (`line width=1.3pt,
line cap=round, line join=round, >=Stealth, x=1mm,y=1mm`), canvas coordinates
roughly −13..13, default/black strokes, and `fill=gray!N` only for shaded
faces (the codegen turns those into proportional `fill-opacity`).
`tikz-app/kkss.tex` is the one **colored** drawing — the "split cube" logo
(solid blue CAD half, orange wireframe-mesh half) — and never goes through
the `currentColor` codegen.

## Pipeline

```bash
cd icons
make ui     # tikz-ui/*.tex → svg-ui/*.svg          (needs pdflatex + pdftocairo)
make ts     # ui + regenerate shellIcons.ts          (Node only if svg-ui is fresh)
make app    # tikz-app/kkss.tex → app/icon*.png      (needs pdflatex + pdftocairo)
make        # everything (= ts + app)
make clean
```

Or from the repo root: `npm run build:icons`.

**Committed:** `.tex` sources, `svg-ui/*.svg`, `app/*.png`, and the generated
`app/renderer/shell/shellIcons.ts` (never hand-edit it). **Ignored:** the
`build-ui/`/`build-app/` PDF scratch dirs.

To change an icon: edit its `.tex`, run `make` (or `npm run build:icons`),
and commit the regenerated artifacts together with the source.
