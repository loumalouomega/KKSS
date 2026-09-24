# Web Deployment (Docker)

KKSS can run "as a web app": the unmodified desktop application runs headless
inside a Docker container (Xvfb virtual display + SwiftShader software
rendering — the same configuration the CI smoke test exercises) and the desktop
is streamed to a browser tab via [noVNC](https://novnc.com/). The browser is
fronted by an authenticated gateway; Caddy handles TLS and WebSocket proxying.
Nothing in the app viewer changes; the browser shows the real Electron window.

The default Compose file is a single-user deployment. For multiple users, the
reference broker in `docker-compose.multi.yml` starts one isolated container,
workspace volume and file-browser companion per authenticated session.

The gateway uses Caddy for the public edge because its
[automatic HTTPS](https://caddyserver.com/docs/automatic-https) and
[WebSocket-capable reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
cover both edge concerns in one component. nginx would require a separate
certificate lifecycle configuration here, while
oauth2-proxy covers OIDC but leaves local accounts, stream tracking and broker
ownership to another service. The direct TLS overlay accepts mounted
`KKSS_TLS_CERT`/`KKSS_TLS_KEY` files or uses `KKSS_PUBLIC_URL` for ACME; the
proxy overlay is for operators who already terminate TLS upstream.

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

**Then, whichever path you took**: open <http://localhost:6080/>. Sign in with
the generated startup credential printed by the container, or with the bcrypt
user file supplied through `KKSS_AUTH_USERS_FILE`. The page reconnects the VNC
stream automatically and provides Files and Sign out links.

For Compose, mount the user file with a small override (the multi-user
reference already does this with a Docker secret):

```yaml
services:
  kkss:
    environment:
      KKSS_AUTH_USERS_FILE: /run/secrets/users
    secrets: [users]
secrets:
  users:
    file: ./users.htpasswd
```

Tags are the release version (`1.2.0`, …) plus a `latest` alias. Pin a version
with `KKSS_TAG` (compose) or by using the full tag in `docker run`.

The default image keeps the desktop image lean and uses app-local `uv` for the
Kratos MCP server when it is available. Releases also publish an amd64-only
`<version>-kratos` variant with Python 3.12, Kratos 10.4.3, the pinned MCP
server, and the five supported application wheels preinstalled. It runs
without package downloads; use it on an x86-64 host when browser sessions need
the solver environment.

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
| `KKSS_AUTH_USERS_FILE` | *(unset)* | Newline-separated `user:bcrypt-hash` entries; mount this as a Docker secret |
| `KKSS_OIDC_ISSUER` | *(unset)* | OIDC issuer; pair with client ID/secret and an email/group allowlist |
| `KKSS_PUBLIC_URL` | `http://localhost:6080` | Public origin used for OIDC callbacks and TLS selection |
| `KKSS_IDLE_TIMEOUT` | `0` | Disconnected idle timeout in seconds; tracked jobs and uploads inhibit it |
| `KKSS_BASE_PATH` | *(empty)* | URL prefix used when a reverse proxy mounts KKSS below a path |
| `KKSS_GPU` | `0` | Set to `1` only with the Intel/AMD `/dev/dri` overlay |
| `KKSS_DISPLAY_BACKEND` | `xvfb` | `tigervnc` enables remote desktop resize after hardware validation; one active viewer is allowed |
| `OPEN_FILE` | *(unset)* | Absolute container path of a file to open at launch (for example `/workspace/model.mdpa`) |
| `NOVNC_PORT` | `6080` | Port noVNC listens on inside the container |

The LLM and application overlay accepts `KKSS_LLM_PROVIDER`,
`KKSS_LLM_MODEL`, `KKSS_LLM_BASE_URL`, `KKSS_LLM_API_KEY_FILE`,
`KKSS_CODEX_EXECUTABLE`, and `KKSS_CLAUDE_CODE_EXECUTABLE`,
`KKSS_PROJECT_ROOT`, `KKSS_RESTORE_SESSION`, `KKSS_THEME` (3D scene), `KKSS_UI_THEME`
(`system`/`dark`/`light`/`hcDark`/`hcLight`), `KKSS_ZOOM`,
`KKSS_META_ENABLED`, `KKSS_META_PORT`, and `KKSS_META_TOKEN_FILE`. Secret files
must be mounted read-only into the container. The gateway never logs their
contents; the application does not write them to `state.json`.

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
restarts through a named volume at `/home/kkss/.config/kkss`. Operator-managed
values such as `KKSS_LLM_API_KEY_FILE`, `KKSS_PROJECT_ROOT`,
`KKSS_RESTORE_SESSION`, `KKSS_THEME`, `KKSS_UI_THEME`, `KKSS_ZOOM`, and `KKSS_META_*` override
the stored value, are shown as “set by the environment” in Settings, and are
never written to that volume. A trusted session user can still inspect runtime
environment values from the embedded terminal; hiding an operator key from an
untrusted user requires an external LLM gateway.

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

The compose files publish on localhost by default. Keep that binding for a
private deployment. To allow another machine on the same network, override the
port mapping in a Compose override (for example `0.0.0.0:${KKSS_PORT:-6080}:6080`)
and put TLS and an operator-managed login in front of it:

```bash
hostname -I | awk '{print $1}'   # Linux/macOS
```

```powershell
ipconfig     # use the IPv4 Address of your active adapter
```

Then browse to `http://<that-ip>:6080/` — using your own address, not the
example. Sign in before opening the desktop; the embedded terminal is available
to authenticated session users.

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
  can reach an authenticated desktop can run commands in the container. It is
  an unprivileged shell (uid 1000, and the app's own files are root-owned and
  not writable by it), but it still reads and writes everything under
  `/workspace`. Keep the default localhost bind for a private deployment, or
  use TLS and an operator-managed local/OIDC login before publishing it.
- **The base image's Kratos MCP server needs a runtime.** It uses the ordinary
  app-local `uv` discovery path and does not download packages during image
  startup. Use the amd64 `-kratos` variant when an offline, preinstalled solver
  environment is required; the CAD and mesh tool servers are built in to both.
- **Chat API keys:** inside the container there is no OS keychain, so
  Electron's `safeStorage` falls back to basic (plaintext-equivalent)
  encryption of the stored key. Treat the userdata volume accordingly.
- **File Browser maintenance:** the pinned v2.63.23 companion is the final
  upstream release, which was archived on 2026-09-01. Keep it behind the KKSS
  gateway, leave command execution disabled, and review or replace the
  companion before exposing file transfer to an untrusted network.
- **Software rendering:** the default viewers run on SwiftShader (no GPU).
  Small and medium models are fine; very large meshes render slowly. On weak
  hosts the WebGL renderer can occasionally crash mid-frame — the Compose
  service restarts on failure; reload the browser tab.
- **Display size:** Xvfb keeps the existing fixed `DISPLAY_SIZE` behavior.
  `docker-compose.gpu.yml` selects the separately validated TigerVNC/EGL path,
  where `resizeSession` can request a new desktop size. Both VNC backends
  reject a second viewer while preserving the first connection. Treat that
  overlay as hardware-dependent until its Intel/AMD runner passes the rendering
  checks.
- **Clipboard** works through the noVNC sidebar panel, not the native
  Ctrl+C/Ctrl+V bridge.

## Licenses

The image additionally distributes x11vnc (GPL-2.0) and noVNC (MPL-2.0),
both compatible with distributing alongside the AGPL-3.0 application.

## Multi-user reference deployment

The reference broker is deliberately operator-facing rather than a hosted
service. Build `docker-compose.multi.yml` with a bcrypt users file and a Docker
socket mount restricted to the broker. It applies one-running-session-per-user
and ten-running-sessions-global defaults, persists session metadata under
`broker-data`, reconciles labeled containers after restart, and never deletes a
workspace when a session is stopped. Each desktop gets a companion File Browser
at `/files/`; execution is disabled and external symlinks are rejected.

For clusters, `docker/web/kubernetes.go` uses the in-cluster service account to
create a Pod, Service, PVCs and Secret with `runAsNonRoot`, dropped capabilities,
resource limits and no service-account token in the user Pod. Apply equivalent
namespace-scoped RBAC and network policy in the operator's cluster before using
that reference backend.

The Kratos image is a separate amd64 build target (`runtime-kratos`). It pins
Kratos 10.4.3 and `kratos-mcp-server` 0.5.0 with a hash-locked wheel set; the
base multi-architecture image remains solver-free. `tools/lock-kratos.sh`
regenerates the lock when these versions change.
