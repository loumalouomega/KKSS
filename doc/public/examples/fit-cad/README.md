# Mesh → CAD (Fit to CAD)

A worked mesh → analytic-CAD example for KKSS, generated live by the app's own
pipeline (nothing here is hand-edited):

| File | What it is |
| --- | --- |
| `large-sphere.stl` | The source: a 100,000-triangle STL skin of a sphere (the CAD Preview fixture, renamed). Open it in CAD mode and run the Mesh Health panel's **Fit to CAD…**, or call the assistant's `fit_mesh_to_cad`. |
| `large-sphere.step` | `fit_mesh_to_cad`'s output: a valid AP214 STEP solid whose **one face is one exact sphere** — 100,000 triangles replaced by a single analytic surface. Validated by OpenCASCADE's own B-rep check (`valid: true`), volume ratio 1.0002 vs the source skin's enclosed volume, Hausdorff deviation 0.2964 (model units, the STL's own `mm`). |
| `large-sphere.cad.json` | The solid's B-rep side channel (the optional `cadJsonPath` output): one trimmed rational NURBS face of degree 2 with [7, 5] knot spans and 35 control points — the file the IGA tools read. Open it with `load_model` like any format; `iga_sample` reports the inventory and re-samples every face (288 `quad9` cells at its automatic density). |
| `large-sphere-refined.cad.json` | `iga_refine` on the `.cad.json` with `subdivisions: 2`: knot spans refined to [10, 7] and 35 → 70 control points, the geometry provably unchanged — the exact representation growth a fine isogeometric analysis or a denser sampling needs. |

Reproduce inside the app: open `large-sphere.stl` in Pre-Processing, click
**Check Healability** (the skin is clean), then **Fit to CAD…**, save the STEP,
and ask the assistant to `iga_refine`/`iga_sample` the written `.cad.json`.

Regenerate from a checkout with the bundled servers
(`node tools/…` not needed — any MCP client works):

```text
fit_mesh_to_cad  { "path": ".../large-sphere.stl", "outputPath": ".../large-sphere.step",
                   "cadJsonPath": ".../large-sphere.cad.json" }
iga_refine       { "path": ".../large-sphere.cad.json",
                   "outputPath": ".../large-sphere-refined.cad.json", "subdivisions": 2 }
```

Licensing: KKSS's GPL-3.0 applies; see `LICENSE`. The source STL is the
CAD-Preview project's own `examples/STL/large-sphere-100k.stl`.
