# Changelog

All notable changes to KKSS are documented in this file. Dates are UTC and
match the GitHub release timestamps. See the
[GitHub Releases](https://github.com/loumalouomega/KKSS/releases) page for
full auto-generated compare links.

## [1.0.6] - 2026-07-18

- feat: bump the mesh submodule to meshio++ 6.6.1, adding read support for
  EnSight Gold (`.case`/`.geo`) and Triangle (`.poly`) meshes and export to
  the write-only SVG/TikZ figure formats (a new "Figures" export menu group)
- docs: format counts and lists updated across README.md, doc/, CLAUDE.md,
  and the AI chat sidebar's system prompt to reflect the 32 read / 29 write
  meshio++ formats

## [1.0.5] - 2026-07-18

- ci: publish the streamed-desktop Docker image to Docker Hub as
  [`vmataix/kkss`](https://hub.docker.com/r/vmataix/kkss) (`X.Y.Z` +
  `latest`, linux/amd64) on release tags, gated on the boot healthcheck (#22)
- docs: the web-deployment guide and README now lead with the prebuilt-image
  quickstart (`docker run vmataix/kkss:latest`)

## [1.0.4] - 2026-07-18

- feat: run KKSS in the browser via Docker — the unmodified desktop app runs
  headless (Xvfb + SwiftShader) and is streamed with x11vnc + noVNC on port
  6080 (`docker/Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`,
  `npm run docker:build` / `docker:up`); single-user/demo scope
- ci: add a Docker workflow that builds the image and boot-checks it (noVNC
  answering + Electron process alive)
- docs: new web-deployment guide (`doc/guide/web-deployment.md`) covering
  quickstart, volumes, environment variables, and security caveats

## [1.0.3] - 2026-07-18

- ci: fix the smoke test's CAD case spuriously failing Playwright's own
  `electron.launch()` timeout — it was hardcoded to 60s, shorter than the
  case's own 90s deadline, so the heavier OCCT+WebGL boot could never use
  its full budget

## [1.0.2] - 2026-07-17

- ci: make the smoke test robust to the headless-GPU render crash

## [1.0.1] - 2026-07-17

- Version bump only; no functional changes since 1.0.0.

## [1.0.0] - 2026-07-17

- Sync cad/mesh submodules (v1.0.3 / v2.1.0) and add an interface-scale
  control (zoom presets, `Ctrl +`/`Ctrl -`/`Ctrl+Shift+0`) (#21)
- ci: force software WebGL (ANGLE+SwiftShader) for the smoke test and retry
  mesh smoke cases

## [0.9.1] - 2026-07-16

- chore: add Dependabot configuration and apply its first batch of dependency
  bumps (GitHub Actions, `@xterm/xterm`, `@xterm/addon-fit`, `chokidar`,
  TypeScript, `@types/node`) (#7-#17)

## [0.9.0] - 2026-07-16

- feat: add support for 25+ extended mesh formats via meshio++ integration
  (#18)
- chore: sync cad/mesh submodule references

## [0.8.0] - 2026-07-16

- chore: bump dependencies for the 0.8.0 release
- Add Ko-fi username for funding support

## [0.7.0] - 2026-07-14

- feat: introduce `McpHub` for shared MCP server management, and add an
  optional HTTP meta MCP server for external LLM clients
- feat: add OS glyphs for the download page; refactor and clarify
  documentation

## [0.6.0] - 2026-07-14

- feat: integrate the Flowgraph node-editor problemtype (#6)
- chore: relicense the project from GPL to AGPL-3.0-only (required by the
  AGPL-3.0 Flowgraph dependency)
- docs: add the end-to-end verification skill for the KKSS Electron app

## [0.5.0] - 2026-07-13

- feat: implement one-way sync of mesh exports from CAD/pre mode into post
  mode (#5)
- feat: add a `gmsh-wasm` alias for the CJS build to support top-level await
  in the ESM entry point

## [0.4.0] - 2026-07-13

- Add tests for chat services and update dependencies (#4)

## [0.3.3] - 2026-07-12

- fix: use system `fpm` for arm64 `.deb` packaging

## [0.3.2] - 2026-07-12

- fix: disable hard-link copying in the package installers step

## [0.3.1] - 2026-07-12

- feat: clean the release directory before packaging installers

## [0.3.0] - 2026-07-12

- feat: add an embedded terminal using node-pty and xterm.js, with a hide
  option
- feat: add a text editor with CodeMirror integration, and "open current file
  in text editor" support
- feat: add a config-driven home screen menu
- feat: add VS Code tasks for building and installing KKSS locally on Windows
- docs: enhance documentation, update icons, add logo and license/copyright
  information (#3)

## [0.2.0] - 2026-07-10

- feat: enhance the release workflow and documentation for multi-architecture
  support

## [0.1.0] - 2026-07-10

- Initial public release: CAD-Preview and VSCode-MDPA-Preview embedded as git
  submodules, icon assets, and base build scripts

[1.0.5]: https://github.com/loumalouomega/KKSS/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/loumalouomega/KKSS/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/loumalouomega/KKSS/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/loumalouomega/KKSS/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/KKSS/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/KKSS/compare/v0.9.1...v1.0.0
[0.9.1]: https://github.com/loumalouomega/KKSS/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/loumalouomega/KKSS/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/loumalouomega/KKSS/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/loumalouomega/KKSS/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/loumalouomega/KKSS/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/loumalouomega/KKSS/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/loumalouomega/KKSS/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/loumalouomega/KKSS/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/loumalouomega/KKSS/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/loumalouomega/KKSS/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/loumalouomega/KKSS/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/loumalouomega/KKSS/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loumalouomega/KKSS/commits/v0.1.0
