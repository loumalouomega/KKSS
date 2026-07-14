# Icon sources

TikZ-drawn icons for KKSS, sharing the visual language and build pipeline of
the two submodules' `icons/` directories ([cad/icons](../cad/icons),
[mesh/icons](../mesh/icons)) — `open.tex` and `edit.tex` are copied verbatim
from mesh, and `preMode.tex` reuses the isometric-cube technique of cad's
`addBox`/`volume` icons, so all three projects look like one family.
(`home.tex` is deliberately a house, not cad's same-named hamburger — that
glyph means "File menu" there, while KKSS's Home returns to the main menu.)

No `pdflatex`? [Tectonic](https://tectonic-typesetting.github.io) is a
verified drop-in for the `.tex → .pdf` step (byte-identical path output apart
from float noise the codegen normalizes away). No `pdftocairo`?
[`dvisvgm`](https://dvisvgm.de) (ships with TeX Live) converts a PDF straight to
SVG — `dvisvgm --pdf --no-fonts <file>.pdf` — a verified drop-in for the SVG
sets. Both `pdftocairo` and the Tectonic route install user-space via
micromamba/conda-forge.

Three independent sets:

| Set | Sources | Output | Use |
| --- | --- | --- | --- |
| Shell toolbar icons | `tikz-ui/*.tex` | `svg-ui/*.svg` → generated `../app/renderer/shell/shellIcons.ts` | Toolbar buttons (Home / mode toggle / Open / Edit / Terminal) + the home-screen menu buttons (monochrome, `currentColor`, theme-adaptive) |
| Application icon | `tikz-app/kkss.tex` | `app/icon-1024.png`, `app/icon.png` (512), `app/icon-256.png` | electron-builder installers (`electron-builder.yml`) + Linux window icon (`out/icon.png`) |
| Docs OS glyphs | `tikz-os/*.tex` | `../doc/public/os/*.svg` | The download page's platform column (colored badges — a generic penguin, four-pane window, and whole apple; **generic drawings, not brand logos**) |

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
make os     # tikz-os/*.tex → ../doc/public/os/*.svg (needs pdflatex + pdftocairo)
make        # everything (= ts + app; run `make os` separately for doc glyphs)
make clean
```

Or from the repo root: `npm run build:icons`.

**Committed:** `.tex` sources, `svg-ui/*.svg`, `app/*.png`,
`../doc/public/os/*.svg`, and the generated
`app/renderer/shell/shellIcons.ts` (never hand-edit it). **Ignored:** the
`build-ui/`/`build-app/`/`build-os/` PDF scratch dirs.

To change an icon: edit its `.tex`, run `make` (or `npm run build:icons`),
and commit the regenerated artifacts together with the source.
