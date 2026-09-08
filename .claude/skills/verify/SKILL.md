---
name: verify
description: Drive the real KKSS Electron app end-to-end (Playwright-Electron) to verify a change, instead of relying on build/typecheck/test alone.
---

# Verifying KKSS end-to-end

KKSS is a GUI (Electron). "It builds and the tests pass" is not verification —
drive the actual app and observe pixels/DOM/process behavior.

## Build first

```bash
npm run submodules:install   # only if a submodule's deps changed
npm run build                # submodule bundles → app bundles → HTML gen → theme guard
```

## Launching under this environment

`xvfb-run` is **not installed** here. This box is WSL2 with **WSLg**, which
already exposes a real X display — use it directly instead of xvfb:

```bash
env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node tools/smoke.e2e.mjs
```

(`ELECTRON_RUN_AS_NODE` must be unset — some dev shells export it, which
turns the `electron` binary into plain Node.) If `DISPLAY=:0` doesn't work in
a given session, check `ls /tmp/.X11-unix/` and `xdpyinfo` first before
falling back to installing `xvfb`/`Xvfb`.

## Driving a specific UI flow (not just the smoke test)

`tools/smoke.e2e.mjs` only asserts the host↔webview handshake. To exercise a
specific feature (e.g. a new sidebar control), write a throwaway script using
the same helpers it uses, from **`tools/e2eShared.mjs`**:

```js
import { launchApp, waitForMarkers, appWindow, sleep } from "/home/vicente/src/KKSS/tools/e2eShared.mjs";

const { app, output } = await launchApp("mesh/example/MDPA/double_arch.mdpa");
const deadline = Date.now() + 60_000;
await waitForMarkers(output, ["[mesh] host → webview: model", "[mesh] host → webview: opState"], deadline);
const page = await appWindow(app, "/renderer/mesh/", deadline);
await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
// ...drive `page` with normal Playwright calls (click, selectOption, waitForSelector, $eval)...
await app.close();
```

- `launchApp(file)` opens KKSS with a file via the CLI arg (same path a real
  user takes) and returns `{ app, output }` — `output()` is the combined
  stdout/stderr, which includes the `KKSS_E2E=1` host↔webview message trace
  (`[cad]`/`[mesh] host → webview: <type>` lines) — useful as a readiness
  signal before touching the DOM.
- `appWindow(app, urlPart, deadline)` finds the `WebContentsView` page by URL
  substring (`/renderer/cad/`, `/renderer/mesh/`).
- Register `page.on("console", ...)` / `page.on("pageerror", ...)` **before**
  driving — CSP violations and shim errors show up there, not as thrown
  exceptions.
- For iframe-embedded content (e.g. the Flowgraph pane), use
  `(await page.$("#some-iframe")).contentFrame()` to reach into it; a
  cross-origin iframe still exposes `.title()`/`.url()`/simple `$eval`s.
- To check for orphaned child processes (forked servers, workers): `ps aux |
  grep <name> | grep -v grep` before and after `await app.close()`.

Example files that exist in the repo for driving real flows: `cad/examples/
STP/bull.stp`, `mesh/example/MDPA/double_arch.mdpa`, `mesh/example/VTK/
Main_0_6.vtk`.

## Gotcha discovered verifying the Flowgraph pane

The pane has two distinct "hide" concepts — don't conflate them when
asserting DOM state:
- `#flowgraph-hide` button → **collapses** (`viewport.classList` gains
  `flowgraph-collapsed`, pane visually hidden, restore chip shown) but
  **keeps the server/iframe alive** (`flowgraph-open` stays `true`).
- Actually switching the Problemtype dropdown away from `flowgraph` calls
  `hideFlowgraphPane()` — this is what drops `flowgraph-open`, unloads the
  iframe, and posts `flowgraphStop` (releasing the shared, ref-counted
  `FlowgraphController`, which kills the forked `flowgraphServer.js` child
  process once no consumer remains).

## Gotcha: native `dialog.showMessageBox` prompts hang a script forever

A flow that reaches a **native** Electron dialog (a `Cancel`/`OK`-style
`window.showWarningMessage` in the vscode shim, the tab-close dirty prompt,
the mesh export's one-time overwrite warning, …) is a *separate OS window*
Playwright-Electron cannot see or click — `page`/`app.evaluate()` only reach
`WebContentsView` pages, not native `dialog.showMessageBox` calls. A script
that triggers one and then `await`s the promise chain behind it (e.g. `File ▸
Save`'s `saveCustomDocument`) will sit there until its own timeout, with the
Electron app itself alive and using CPU — not crashed, not deadlocked, just
correctly blocked on a click that will never come. Two ways to keep verifying
past it without fighting the dialog:
- **Assert the block itself, don't wait past it** — e.g. "closing a dirty tab
  does NOT immediately remove it" is a real, useful assertion; `sleep()` a
  beat after triggering and check the thing that *should* still be there
  still is.
- **Bypass a one-time gate** if the flow's own state has one — mesh's export
  overwrite warning is gated by the `meshExportOverwriteWarned` stateStore key
  (unprefixed, real app profile at `~/.config/kkss/state.json` unless
  `--user-data-dir` isolates the run); back the file up, seed the key `true`,
  run the script, then restore the backup and `git checkout --` any example
  file the now-unblocked save actually wrote to.

`Menu.getApplicationMenu()` via `app.evaluate(({ Menu }) => ...)` is the
reliable way to test **native menu items** — both their presence (walk
`.items`/`.submenu.items` by `.label`) and their effect (call `item.click()`
directly, which invokes the exact same handler a real click would, without
depending on Electron's accelerator system). Prefer this over
`page.keyboard.press("Control+S")`: a synthetic CDP key sent to one
`WebContentsView`'s page is not guaranteed to reach a *global* menu
accelerator the way a real OS keypress does, so a `keyboard.press` "failure"
may just be that gap rather than the feature not working — `MenuItem.click()`
sidesteps the question entirely.
