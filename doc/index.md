---
layout: home

hero:
  name: KKSS
  text: Keep Kratos Simple Stupid
  tagline: A cross-platform desktop app for pre- and post-processing Kratos Multiphysics simulations — CAD preparation and mesh/result inspection in one window.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Download
      link: /download
    - theme: alt
      text: View on GitHub
      link: https://github.com/loumalouomega/KKSS

features:
  - icon: 🔷
    title: Pre-Processing mode
    details: Open STEP/IGES/BREP and STL/OBJ/PLY/glTF models, define parts, apply parametric edits, and generate finite-element meshes with Gmsh — powered by the CAD-Preview engine (Three.js + OpenCascade WASM).
  - icon: 🔶
    title: Post-Processing mode
    details: Inspect MDPA models and VTK results with fields, isosurfaces, quality reports, time-series playback, mesh operations with undo/redo, and MMG remeshing — powered by the VSCode-MDPA-Preview engine (vtk.js + MMG WASM).
  - icon: 🔀
    title: One toggle, two engines
    details: Switch instantly between modes; each keeps its loaded file, camera, and edit history. Both engines are the unmodified VS Code extensions, embedded as git submodules — upstream improvements arrive by bumping a submodule pointer.
  - icon: 📦
    title: Cross-platform
    details: Windows, macOS, and Linux installers built and published automatically on every release tag.
---

## The two modes at a glance

| 🔷 Pre-Processing | 🔶 Post-Processing |
| --- | --- |
| ![CAD mode — STEP model with parts, edits and FE meshing panels](/screenshots/cad-viewer.png) | ![Mesh mode — MDPA model with outline, edit history and mesh modification](/screenshots/mesh-viewer.png) |

## Quick start

1. Grab the installer for your platform and architecture from the [download page](/download) (AppImage/deb, NSIS installer, or dmg).
2. Launch **KKSS**. The toolbar toggle switches between **🔷 Pre-Processing** (CAD) and **🔶 Post-Processing** (mesh/results).
3. Press `Ctrl+O` (or click **Open…**) and pick a model: CAD files open in Pre-Processing mode, `.mdpa`/VTK files in Post-Processing mode.

See [Getting Started](/guide/getting-started) for a tour of both modes.
