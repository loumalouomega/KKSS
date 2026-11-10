# Troubleshooting

Symptom → likely causes → what to do. For what is *not supported*, see [Known limitations](/guide/known-limitations).

## Generate is refused, or Run is disabled

- The environment check failed: open Home ▸ **Check environment**. A missing interpreter or Kratos application disables the Problemtype Run action and guided launches; fix **Settings ▸ Kratos ▸ Python Path** and check again, or use Home's **Install Kratos solver…** to let KKSS build a verified runtime of its own.
- Required fields of the problemtype are empty: the refusal lists them.

## A run reads *uncertain*

KKSS could not confirm the outcome (the launcher died, fewer MPI ranks started than requested, or the app quit mid-launch). It is **never** resubmitted automatically. Inspect the run directory and the solver log, then start a new run deliberately.

## A solve never converges

Exit code 0 does not mean convergence. Open the run review: the convergence monitor shows the solver-published residuals, or says why none are available. Reduce the time step, tighten the mesh, or check boundary conditions.

## Results do not appear

- Output settings in the generated `ProjectParameters.json` decide the format; a missing or unsafe configured output is reported as a finding.
- XDMF/HDF5 output cannot be read back yet (see limitations); switch to VTK or GiD.

## The assistant's Kratos tools are missing

The Kratos server runs through `uvx`. If uv is missing the chat shows a setup banner with an **Install** button; use it, or install uv yourself and press retry. CAD and mesh tools stay available meanwhile.

## A remote host cannot be reached

Run `ssh -o BatchMode=yes <host> true` in a terminal: it must succeed without any prompt. Fix keys or the agent, then retry.

## Reporting a problem

**Help ▸ Export Diagnostics…** writes one zip you choose the location of: app, Electron and Kratos MCP versions, platform, every setting (secrets reduced to *set / not set*), the MCP server statuses, the selected run's receipt, environment report and solver-log tails, and a `manifest.json` listing each file. Home and temporary paths are replaced by placeholders and nothing is sent anywhere; review it, then attach it. Also attach the app version (Help ▸ About), the generated case folder, the solver log and, if the app crashed, the renderer-crash toast text. Home paths in logs may identify you; remove them before sharing. If the app itself crashed, Chromium's crash handler leaves a native dump on this computer (never uploaded; there is no crash-report server). When you export diagnostics and dumps exist, the app asks whether to include the newest few (at most 5 and 20 MB); the default is **Don't include**, because a dump is a memory snapshot that can contain file paths and fragments of open documents. `crash-dumps.json` in the bundle lists them either way.

## Coming from GiD

| GiD | KKSS |
| --- | --- |
| Problemtype | Kratos Problemtype (mesh-mode sidebar) |
| Condition | Boundary condition card bound to a SubModelPart |
| Group / layer | SubModelPart / view layer |
| `.post.bin` | Result file opened in Post-Processing mode |

## A solver or `uv` behaves differently inside the packaged app

KKSS removes variables the packager sets for itself (`LD_LIBRARY_PATH`, `APPDIR`, `APPIMAGE`, `PYTHONHOME`, Electron switches, AppImage `PATH` entries) from the environment of Python, Kratos, uv and the terminal. If a tool still loads the wrong library, run `env` in the terminal panel and include it in your report.
