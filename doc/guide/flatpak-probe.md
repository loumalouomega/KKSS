# Flatpak feasibility probe

Run `npm run build:app && npm run flatpak:probe` on a Linux host with Flatpak installed. The probe checks that the unpacked `out/` tree contains Electron's workers and WASM, confirms the native `node-pty` module, and prints the sandbox permissions that still need to be narrowed.

KKSS currently ships `asar: false` because its worker threads and WASM loaders read files beside the main bundle. A Flatpak would need to preserve that layout and provide a reproducible node-pty build. Solver launchers such as `uv`, Kratos and OpenFOAM also need an explicit host or sandbox boundary. Until those contracts are tested in a real runtime, Flatpak remains an evaluation item and no Flatpak artifact is published.
