# Web Deployment (Docker)

KKSS can run "as a web app": the unmodified desktop application runs headless
inside a Docker container (Xvfb virtual display + SwiftShader software
rendering — the same configuration the CI smoke test exercises) and the desktop
is streamed to a browser tab via [noVNC](https://novnc.com/). Nothing in the
app changes; the browser shows the real Electron window.

This is a **single-user / demo** deployment: one container is one session.
Multi-tenant SaaS hosting is out of scope for now (see
[outlook](#saas-outlook) below).

## Three ways to start it

Every release publishes a **linux/amd64 + linux/arm64** image to both
[GitHub Container Registry](https://github.com/loumalouomega/KKSS/pkgs/container/kkss)
(`ghcr.io/loumalouomega/kkss`) and
[Docker Hub](https://hub.docker.com/r/vmataix/kkss) (`vmataix/kkss`). The two
are the same image; use whichever you prefer.

### 1. Prebuilt, one command

```bash
docker run -d --name kkss --restart unless-stopped \
  -p 6080:6080 --shm-size=1g \
  -v /path/to/your/simulations:/workspace \
  ghcr.io/loumalouomega/kkss:latest
```

### 2. Prebuilt, with compose

No checkout needed beyond the one file — download
[`docker-compose.ghcr.yml`](https://github.com/loumalouomega/KKSS/blob/master/docker-compose.ghcr.yml)
and:

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

### 3. Build it yourself

Needs a checkout **with initialized submodules** — the image builds from them:

```bash
git clone https://github.com/loumalouomega/KKSS.git
cd KKSS
git submodule update --init --recursive
docker compose up --build -d
```

The first build takes a while (it downloads Electron, compiles node-pty from
source, and packages the app); later builds reuse cached layers.
`npm run docker:build` / `docker:up` / `docker:down` / `docker:logs` are
shorthands.

**Then, whichever path you took**: open <http://localhost:6080/vnc.html> and
click *Connect*. You should see the KKSS home screen.

Tags are the release version (`1.2.0`, …) plus a `latest` alias. Pin a version
with `KKSS_TAG` (compose) or by using the full tag in `docker run`.

## Where it runs

The image is **multi-stage**: one stage builds and packages the app, and the
final image carries only that packaged output plus the X/VNC stack — no npm, no
source tree, and none of the submodules' build dependencies. That puts it at
about **2 GB** (linux/amd64), down from 5.5 GB before the split. It runs as the
unprivileged `kkss` user (uid 1000), not root, and the app's own files are
root-owned so the running process cannot modify them.

## Environment variables

Container settings — set with `-e` on `docker run`, or in the `environment:`
block of either compose file:

| Variable       | Default     | Meaning                                                                 |
| -------------- | ----------- | ----------------------------------------------------------------------- |
| `DISPLAY_SIZE` | `1920x1080` | Virtual screen geometry, fixed per container start                      |
| `VNC_PASSWORD` | *(unset)*   | Session password; without it the stream is unauthenticated              |
| `OPEN_FILE`    | *(unset)*   | Absolute container path of a file to open at launch (e.g. `/workspace/model.mdpa`) |
| `NOVNC_PORT`   | `6080`      | Port noVNC listens on inside the container                              |

Compose settings — read from your shell (or a `.env` file beside the compose
file), not from the container:

| Variable            | Default                        | Meaning                                     |
| ------------------- | ------------------------------ | ------------------------------------------- |
| `KKSS_PORT`         | `6080`                         | Host port published for noVNC               |
| `KKSS_TAG`          | `latest`                       | Image tag (GHCR compose file only)          |
| `KKSS_WORKSPACE`    | `./mesh/example` / named volume | Host path or named volume mounted at `/workspace` |
| `KKSS_DISPLAY_SIZE` | `1920x1080`                    | Passed through as `DISPLAY_SIZE`            |

To serve on a different host port, for example 8080:

```bash
KKSS_PORT=8080 docker compose -f docker-compose.ghcr.yml up -d
```

```powershell
$env:KKSS_PORT = "8080"
docker compose -f docker-compose.ghcr.yml up -d
```

## Files and volumes

The in-app file dialogs browse the **container** filesystem, not your host.
Mount the data you want to work on at `/workspace`:

```bash
KKSS_WORKSPACE=/path/to/your/simulations docker compose -f docker-compose.ghcr.yml up -d
```

```powershell
$env:KKSS_WORKSPACE = "C:\path\to\your\simulations"
docker compose -f docker-compose.ghcr.yml up -d
```

The same variable also accepts a named volume (a bare word rather than a path),
which is the GHCR file's default since there is no checkout to point at; the
build compose file defaults to the repo's `mesh/example/` so there is something
to open out of the box.

App settings (`state.json` — theme, zoom, LLM provider, …) persist across
restarts through a named volume at `/home/kkss/.config/kkss`.

::: warning Upgrading from 1.1.0 or earlier
The container used to run as root and kept its settings in
`/root/.config/kkss`. It now runs as the unprivileged `kkss` user, so the path
moved. To carry old settings over:

```bash
docker run --rm -v kkss_kkss-userdata:/from -v kkss_kkss-userdata-new:/to \
  alpine sh -c 'cp -a /from/. /to/'
```

then point the volume at the new name — or just let it start fresh, since the
only loss is UI preferences and any stored API key.
:::

## Access from another machine

The compose files publish on all interfaces, so any machine on the same network
can connect once you know the host's IP:

```bash
hostname -I | awk '{print $1}'   # Linux/macOS
```

```powershell
ipconfig     # use the IPv4 Address of your active adapter
```

Then browse to `http://<that-ip>:6080/vnc.html` — using your own address, not
the example. Read the security caveats below first: without `VNC_PASSWORD` the
session (and the embedded terminal) is open to anyone who can reach the port.

## Troubleshooting

- **`docker: command not found` / "the daemon is not running"** — install
  Docker Desktop (or Docker Engine) and make sure it is started.
- **"port is already allocated"** — something else holds 6080; start with
  `KKSS_PORT=8080` and open that port instead.
- **The page loads but stays black, or *Connect* fails** — give it a moment on
  first start; the app boots before the stream is useful. If it persists,
  `docker logs kkss` shows the entrypoint's output, and this reports whether
  the container considers itself healthy:

  ```bash
  docker inspect --format '{{.State.Health.Status}}' kkss
  ```
- **The container keeps restarting** — usually the WebGL renderer crashing
  under software rendering on a constrained host. Check `docker logs`, and try
  a smaller model or a smaller `DISPLAY_SIZE`.
- **Old version keeps running** — `docker compose down` then
  `docker compose -f docker-compose.ghcr.yml pull` before starting again;
  `latest` is only re-pulled explicitly.
- **`/workspace` is empty or read-only** — check the path you mounted exists on
  the host. The container runs as uid 1000; a host directory owned by a
  different uid may need its permissions widened for writes.

## Caveats

- **The embedded terminal is a real shell inside the container.** Anyone who
  can reach the noVNC page can run commands in the container. It is an
  unprivileged shell (uid 1000, and the app's own files are root-owned and not
  writable by it), but it still reads and writes everything under `/workspace`.
  Never expose port 6080 beyond localhost without at least `VNC_PASSWORD`, and
  prefer a reverse proxy with TLS + auth for anything non-local.
- **The chat's Kratos MCP server is unavailable in the container.** It is
  fetched on demand with `uvx`, which the image does not ship; the CAD and mesh
  tool servers are built in and work normally.
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
