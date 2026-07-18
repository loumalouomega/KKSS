# Web Deployment (Docker)

KKSS can run "as a web app": the unmodified desktop application runs headless
inside a Docker container (Xvfb virtual display + SwiftShader software
rendering — the same configuration the CI smoke test exercises) and the desktop
is streamed to a browser tab via [noVNC](https://novnc.com/). Nothing in the
app changes; the browser shows the real Electron window.

This is a **single-user / demo** deployment: one container is one session.
Multi-tenant SaaS hosting is out of scope for now (see
[outlook](#saas-outlook) below).

## Quickstart (prebuilt image)

Releases publish the image to Docker Hub as
[`vmataix/kkss`](https://hub.docker.com/r/vmataix/kkss)
(linux/amd64), so all you need is Docker:

```bash
docker run -d -p 6080:6080 --shm-size=1g \
  -v /path/to/your/simulations:/workspace \
  vmataix/kkss:latest
```

Then open <http://localhost:6080/vnc.html> and click *Connect*. Tags: every
release from v1.0.5 onward is available as its version number (`1.0.5`, …)
plus a `latest` alias.

## Building the image yourself

Prerequisites: Docker (Desktop or Engine with the compose plugin) and a
checkout with initialized submodules:

```bash
git clone https://github.com/loumalouomega/KKSS.git
cd KKSS
git submodule update --init --recursive
docker compose up --build
```

The first build takes a while (it downloads Electron and compiles node-pty
from source) and produces a large image (several GB) — subsequent builds
reuse cached layers.

`npm run docker:build` / `npm run docker:up` are shorthands for
`docker compose build` / `docker compose up`.

## Environment variables

Set these in `docker-compose.yml` (or `-e` with `docker run`):

| Variable       | Default     | Meaning                                                                 |
| -------------- | ----------- | ----------------------------------------------------------------------- |
| `DISPLAY_SIZE` | `1920x1080` | Virtual screen geometry, fixed per container start                      |
| `VNC_PASSWORD` | *(unset)*   | Session password; without it the stream is unauthenticated              |
| `OPEN_FILE`    | *(unset)*   | Absolute container path of a file to open at launch (e.g. `/workspace/model.mdpa`) |
| `NOVNC_PORT`   | `6080`      | Port noVNC listens on inside the container                              |

## Files and volumes

The in-app file dialogs browse the **container** filesystem, not your host.
Mount the data you want to work on into `/workspace` — the default compose
file mounts the repo's `mesh/example/` there so there is something to open out
of the box:

```yaml
volumes:
  - /path/to/your/simulations:/workspace
```

App settings (`state.json` — theme, zoom, LLM provider, …) persist across
container restarts through the named volume mapped to `/root/.config/kkss`.

## Caveats

- **The embedded terminal is a real shell inside the container.** Anyone who
  can reach the noVNC page can run commands in the container. Never expose
  port 6080 beyond localhost without at least `VNC_PASSWORD`, and prefer a
  reverse proxy with TLS + auth for anything non-local.
- **Chat API keys:** inside the container there is no OS keychain, so
  Electron's `safeStorage` falls back to basic (plaintext-equivalent)
  encryption of the stored key. Treat the userdata volume accordingly.
- **Software rendering:** the viewers run on SwiftShader (no GPU). Small and
  medium models are fine; very large meshes render slowly. On weak hosts the
  WebGL renderer can occasionally crash mid-frame — the container restarts
  automatically (`restart: unless-stopped`); reload the browser tab.
- **Fixed display size:** x11vnc streams the virtual display at the geometry
  set by `DISPLAY_SIZE`; the browser scales it but cannot resize it. Restart
  the container with a different `DISPLAY_SIZE` to change resolution.
- **Clipboard** works through the noVNC sidebar panel, not the native
  Ctrl+C/Ctrl+V bridge.

## Licenses

The image additionally distributes x11vnc (GPL-2.0) and noVNC (MPL-2.0),
both compatible with distributing alongside the AGPL-3.0 application.

## SaaS outlook

A true multi-tenant deployment would spawn **one container per user session**
behind an authenticating front (e.g. [Kasm Workspaces](https://kasmweb.com/),
or Traefik/OAuth2-proxy plus a small session orchestrator), with per-user
`/workspace` volumes. The container built here is the unit such an
orchestrator would launch, but the orchestration and auth layer are
deliberately out of scope for this single-user setup.
