# OpenSCAD, with No Install

OpenSCAD models are code: a `.scad` file describes a solid in a small
functional language, and something has to *evaluate* it before there is
geometry to view. KKSS evaluates `.scad` with a **bundled OpenSCAD build**
(WebAssembly, Manifold backend) — since the 3.26.0 engine update there is
nothing to install. A user-installed `openscad` binary stays as the fallback
for the few constructs the bundled build declines. This walkthrough opens the
downloadable example, drives it from the Customizer panel, meshes it, and
shows where the fallback still matters.

The example file lives in [`/examples/openscad/`](/examples/openscad/README.md):

| File | What it is |
| --- | --- |
| [`bracket.scad`](/examples/openscad/bracket.scad) | Source — a parametric L-bracket: base footprint, upright height, wall thickness, one mounting-hole diameter |

Copy `bracket.scad` into a scratch folder and follow along.

## 1. Open the model — nothing to install

Open `bracket.scad` in CAD mode — the file routes to the 🔷 Pre-Processing tab.
The status line evaluates it in well under a second and the viewer shows a
solid L-bracket, exactly as if an installed OpenSCAD had produced it: the
bundled build emits the same `.csg` bytes the binary path produces, so
opening, edits, BOM/hole-table/clash/health/measure, meshing and export all
behave identically.

![The bracket evaluated by the bundled OpenSCAD build](/screenshots/openscad-source.png)

*`bracket.scad` at its defaults: 60 × 40 mm base, 40 mm upright, 6 mm walls, an 8 mm hole.*

Behind the scenes the conversion is **WASM-first with binary fallback**:
the bundled build tries every `.scad` first, and only a model it *declines* —
an `import()`/`surface()` of a local mesh, a missing include, more than 20
staged files or 1 MB of staged source — falls back to your installed binary
(**Settings ▸ Open Settings… ▸ CAD Viewer ▸ OpenSCAD Binary**, or `openscad`
on `PATH`). Any other failure (a syntax error, an empty model) is a genuine
conversion failure and is reported, not retried.

## 2. Drive it from the Customizer

Fold open the **Customizer** panel (`scad-panel`): it lists the file's five
parameters with their defaults and ranges, parsed from the source text alone —
no evaluation needed. Set **hole_d** to 12 and press **Apply**. The panel
persists the validated overrides to `bracket.scad-params.json` beside the
source and replays them as `-D` defines on every later conversion: the hole
grows, and reopening, every edit's re-tessellation, BOM, measuring, meshing
and export all see the applied value. The `.scad` file itself is never
written.

![The Customizer with an applied hole diameter](/screenshots/openscad-customizer.png)

*`hole_d = 12` applied: the override lives in `bracket.scad-params.json`, replayed as `-D hole_d=12`.*

Out-of-range numbers apply with a note (OpenSCAD itself does not clamp);
unknown names and wrong types are dropped with a warning.

## 3. Mesh and export it like any solid

The evaluated bracket is a first-class solid: pick Parts, measure exact
distances against the true geometry, and under **FE Mesh** generate like any
STEP model. **File ▸ Export…** writes STEP/IGES/BREP or any mesh target —
never back to `.csg` (both OpenSCAD formats are import-only).

## 4. The same thing through the assistant

The viewer and the `cad__*` tools share the conversion. Prompt:

```text
List the Customizer parameters of /path/to/bracket.scad, then re-evaluate
it with hole_d=12 into /path/to/bracket-12.csg without touching the source.
```

`list_scad_parameters` reads the parameters from text alone;
`convert_scad` re-evaluates with `-D` overrides, the configured backend and
extra library folders, writing a new `.csg`. Both are WASM-first like the
viewer, so neither needs an install.

## 5. When the fallback still matters

Two cases still want a real binary on `PATH`:

- **Mesh imports.** A model calling `import("gear.stl")` or `surface()` keeps
  the node for the binary path to resolve — the bundled build declines it in
  milliseconds and the binary takes over transparently.
- **Missing or out-of-tree includes.** A `use`/`include` the staging cannot
  resolve (absent file, quoted include outside the source directory) declines
  the same way. **OpenSCAD Library Folders** prepends to `OPENSCADPATH` for
  both paths, so a `use <BOSL2/std.scad>` resolves without copying libraries
  beside every model.

Without *either* path, opening a `.scad` reports that rather than failing
silently. A large boolean tree is also worth knowing about: the bundled
build's Manifold engine evaluates one far faster than the old CGAL default.
