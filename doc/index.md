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
    details: Inspect MDPA models, VTK results, and 32 extended mesh formats via meshio++ (Gmsh, Abaqus, Nastran, UNV, SU2, EnSight Gold, Triangle, …) with combinable field modes (contour, isosurfaces, quivers, deformed shape), quality and mesh-size reports, time-series playback, mesh operations with undo/redo, and MMG remeshing; set up and run Kratos cases via built-in problemtypes, including the Flowgraph node-editor — powered by the VSCode-MDPA-Preview engine (vtk.js + MMG WASM).
  - icon: 🔀
    title: One toggle, two engines
    details: Switch instantly between modes; each keeps its loaded file, camera, and edit history. Both engines are the unmodified VS Code extensions, embedded as git submodules — upstream improvements arrive by bumping a submodule pointer.
  - icon: 🤖
    title: AI assistant
    details: A chat sidebar where an LLM (Anthropic Claude or any OpenAI-compatible backend) drives CAD editing, meshing, case setup, and Kratos simulations through the engines' MCP tool servers and the kratos-mcp-server.
  - icon: 🧰
    title: Built-in workbench
    details: An embedded terminal (node-pty + xterm.js) for launching Kratos runs, a CodeMirror text editor for input files and scripts, and in-app update checks against GitHub Releases.
  - icon: 📦
    title: Cross-platform
    details: Windows, macOS, and Linux installers built and published automatically on every release tag — with in-place auto-update on Windows and the Linux AppImage.
---

## The two modes at a glance

| 🔷 Pre-Processing | 🔶 Post-Processing |
| --- | --- |
| ![CAD mode — STEP model with parts, edits and FE meshing panels](/screenshots/cad-viewer.png) | ![Mesh mode — MDPA model with outline, edit history and mesh modification](/screenshots/mesh-viewer.png) |

## Quick start

1. Grab the installer for your platform and architecture from the [download page](/download) (AppImage/deb, NSIS installer, or dmg).
2. Launch **KKSS** and pick a task on the home screen — **🔷 Pre-Processing** (CAD), **🔶 Post-Processing** (mesh/results), or the text editor. The toolbar switches screens at any time (`Ctrl+0` returns Home).
3. Press `Ctrl+O` (or click **Open…**) and pick a model: CAD files open in Pre-Processing mode, `.mdpa`/VTK files in Post-Processing mode.

See [Getting Started](/guide/getting-started) for a tour of both modes.
