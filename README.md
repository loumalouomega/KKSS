# KKSS — Keep Kratos Simple Stupid

A cross-platform desktop application for **pre- and post-processing
[Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos)
simulations**, built with Electron on top of two proven VS Code extensions,
embedded as git submodules and reused **without modification**:

| Mode | Engine (submodule) | What it does |
| --- | --- | --- |
| 🔷 **Pre-Processing** | [CAD-Preview](https://github.com/loumalouomega/CAD-Preview) (`cad/`) | STEP/IGES/BREP + STL/OBJ/PLY/glTF viewing, part definition, parametric geometry editing, Gmsh FE meshing, MDPA export |
| 🔶 **Post-Processing** | [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview) (`mesh/`) | MDPA/VTK inspection, field & time-series visualization, mesh quality, mesh operations with undo/redo, MMG remeshing |

A toolbar toggle switches between the modes; both stay alive, keeping their
loaded file, camera, and history.

**Documentation:** <https://loumalouomega.github.io/KKSS/> ·
**Downloads:** [GitHub Releases](https://github.com/loumalouomega/KKSS/releases)

## How it works

Both extensions already separate a browser-side viewer bundle (whose only
VS Code touchpoint is `acquireVsCodeApi()`) from thin vscode-coupled glue.
KKSS loads the built viewer bundles unchanged behind a tiny shim and provides
Electron equivalents of the glue: native dialogs, a `vscode` module shim for
the reused mesh host code, custom `kkss://`/`kkss-file://` schemes in place of
`asWebviewUri`, and worker threads for the heavy WASM kernels (OpenCascade,
Gmsh, MMG). Upstream extension improvements are inherited by bumping a
submodule pointer. See the
[architecture guide](https://loumalouomega.github.io/KKSS/guide/development)
for details.

## Building from source

```bash
git clone --recurse-submodules https://github.com/loumalouomega/KKSS.git
cd KKSS
npm ci
npm run submodules:install
npm start          # build everything and launch
npm run dist       # package installers into release/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, testing,
and the submodule update procedure.

## Licensing

KKSS is licensed **GPL-3.0** (see [LICENSE](LICENSE)). It bundles the
GPL-2.0-or-later licensed CAD-Preview engine — whose shipped WASM statically
links [Gmsh](https://gmsh.info) and OpenCASCADE — and the MIT-licensed
VSCode-MDPA-Preview engine; GPL-3.0 is the compatible license for the
combined distribution.
