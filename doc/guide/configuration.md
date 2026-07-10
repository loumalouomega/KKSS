# Configuration

KKSS deliberately keeps configuration minimal ("Keep Kratos Simple Stupid").

## Scene theme

The mesh viewer's theme selector (Auto / Dark / Light / Scientific, in the
Post-Processing toolbar) persists across sessions.

## Where state lives

| State | Location |
| --- | --- |
| App state (theme, one-time warnings) | `state.json` in the platform's user-data dir (`~/.config/KKSS` on Linux, `%APPDATA%/KKSS` on Windows, `~/Library/Application Support/KKSS` on macOS) |
| CAD parts / edits / mesh options | JSON sidecars next to the opened model — see [Pre-Processing mode](/guide/cad-mode#sidecar-files) |
| Mesh operation recipes | Saved explicitly via the Edit sidebar's Save/Load buttons |

## Command-line

`kkss <file>` opens the given model on startup in the mode the file's
extension implies.
