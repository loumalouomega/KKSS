# Getting Started

KKSS (Keep Kratos Simple Stupid) is a desktop application for preparing and inspecting
[Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos) simulation models.
It bundles two proven viewers — the
[CAD-Preview](https://github.com/loumalouomega/CAD-Preview) and
[VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview)
VS Code extensions — into one window with a mode toggle.

## Installation

Grab the installer for your platform and architecture from the
[download page](/download) (built for every release tag by CI):

| Platform | Architectures | Artifact |
| --- | --- | --- |
| Linux | x86-64, ARM 64 | `.AppImage` (portable) or `.deb` |
| Windows | x86-64, ARM 64 | NSIS `.exe` installer |
| macOS | Apple Silicon (ARM 64) | `.dmg` / `.zip` |

::: tip macOS Gatekeeper
Release builds are currently unsigned. On macOS, right-click the app and choose
**Open** the first time to bypass Gatekeeper.
:::

## The home screen

KKSS opens on a main menu with one button per task — **Pre-Processing**,
**Post-Processing**, and **Help**. Pick a mode to enter it; the **Home**
button in the toolbar (or `Ctrl+0` / **View ▸ Home**) brings the menu back at
any time without losing what's loaded in either mode.

![The home screen](/screenshots/home-screen.png)

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

## About & updates

**Help** on the home screen (or **Help ▸ About KKSS…**) shows the app
version and checks GitHub for a newer release. When an update exists,
**Update now** downloads and installs it in place on Windows and on the Linux
AppImage — restart when prompted. `.deb` and macOS installs instead get a
button to the releases page (those package types can't self-update; macOS
builds are unsigned). No network? The dialog still shows your version and
offers a Retry.

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
| `Ctrl+0` | Back to the home screen (main menu) |
| `Ctrl+1` / `Ctrl+2` | Switch to Pre-Processing / Post-Processing |
| `Ctrl+F` | Find entity by ID (mesh mode) |

On macOS use `Cmd` instead of `Ctrl`.
