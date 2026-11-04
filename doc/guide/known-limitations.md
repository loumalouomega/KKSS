# Known limitations

What KKSS does not do, or does only partly. Each entry names the reason and, where one exists, the workaround. When a limitation is fixed, its entry is removed or narrowed in the same change.

## Solving and results

- **Convergence is never inferred from process exit.** A solve is reported *succeeded* only with solver-published records; linear solves, unsupported criteria and interrupted runs show an explicit *unavailable* reason instead.
- **XDMF/HDF5 results written by Kratos 10.4.2–10.4.4 cannot be read back yet.** The solver writes a correct index with the documented settings, but the bundled meshio++ rejects Kratos's multi-file temporal layout. Use VTK or GiD output meanwhile.
- **MPI runs are single-node and only stand-in verified.** No live MPI-enabled Kratos run has been recorded; multi-node launches are not supported.
- **Thread counts are machine-specific.** The recorded benchmark is an observation, not evidence that more threads are faster.
- **Region references are matched by name only.** A renamed Part looks like a delete plus an add until CAD emits rename events; the carry-over report is advisory.
- **The Kratos MCP server's background runs differ from the app's runner.** The server drives the analysis class directly, so a case's `MainKratos*.py` `__main__` block and its convergence monitor do not run.

## Formats

- **`.3mf`, `.dae`, `.amf`, USD, VRML and FBX are display-only.** Meshing, measuring, region fit and Mesh Health refuse them by name.
- **SpaceMouse input and the Models activity-bar view are not ported** (a second native module, and no workspace tree).

## Remote sessions and platforms

- **Remote (SSH) flows are verified from a Linux client against a loopback host only.** Windows and macOS clients, and a non-loopback host, are untested. Passwords and passphrases are never prompted (`BatchMode=yes`): use keys or an agent.
- **Unsigned macOS builds** fall back to the releases page for updates; deb and rpm installs do too.
- **The Kratos runtime installer is verified live on Linux only**; Windows and macOS have mocked coverage. The same applies to **Install Kratos solver…**: only x86-64 Linux installs from the hash lock, other platforms install the same pinned versions without hash verification.
- **Headless study runs (`kkss --headless study run`) cover local solves only.** Solves on an ssh host are a GUI-session feature, and the run needs a plan you already persisted in KKSS — it never creates one.
- **The Docker image is a single-viewer streamed desktop**; hardware rendering and TigerVNC resize still need native runners.

See also [Troubleshooting](/guide/troubleshooting).
