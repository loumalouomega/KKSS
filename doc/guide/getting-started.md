# Getting Started

KKSS (Keep Kratos Simple Stupid) is a desktop application for preparing and inspecting
[Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos) simulation models.
It bundles two proven viewers — the
[CAD-Preview](https://github.com/loumalouomega/CAD-Preview) and
[VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview)
VS Code extensions — into one window with a mode toggle.

## Installation

Grab the installer for your platform from the
[releases page](https://github.com/loumalouomega/KKSS/releases):

| Platform | Artifact |
| --- | --- |
| Linux | `.AppImage` (portable) or `.deb` |
| Windows | NSIS `.exe` installer |
| macOS | `.dmg` / `.zip` |

::: tip macOS Gatekeeper
Release builds are currently unsigned. On macOS, right-click the app and choose
**Open** the first time to bypass Gatekeeper.
:::

## The two modes

The toolbar at the top of the window holds the mode toggle:

![The shell toolbar: mode toggle, Open button, and the current file](/screenshots/shell-toolbar.png)

- **🔷 Pre-Processing** — CAD geometry and model preparation
  ([details](/guide/cad-mode)). Opens STEP, IGES, BREP, STL, OBJ, PLY, and glTF.
- **🔶 Post-Processing** — mesh inspection, modification, and result
  visualization ([details](/guide/mesh-mode)). Opens MDPA, VTK (legacy + XML),
  STL, OBJ, and PLY.

Both mode views stay alive when you switch: the loaded file, the camera, and
your undo history are all preserved.

| 🔷 Pre-Processing | 🔶 Post-Processing |
| --- | --- |
| ![CAD mode](/screenshots/cad-viewer.png) | ![Mesh mode](/screenshots/mesh-viewer.png) |

## Opening files

- **Open… button** or `Ctrl+O` — opens a file in the current mode.
- **File ▸ Open** in the in-viewer File menu — same thing.
- Formats supported by both modes (`.stl`, `.obj`, `.ply`) open in whichever
  mode is currently active.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file in the active mode |
| `Ctrl+S` | Save (CAD: flush sidecars · Mesh: overwrite the source file) |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+E` | Export |
| `Ctrl+1` / `Ctrl+2` | Switch to Pre-Processing / Post-Processing |
| `Ctrl+F` | Find entity by ID (mesh mode) |

On macOS use `Cmd` instead of `Ctrl`.
