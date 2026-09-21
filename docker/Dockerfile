# syntax=docker/dockerfile:1
ARG KKSS_VARIANT=base

FROM golang:1.27.1-bookworm AS web-builder
WORKDIR /web
COPY docker/web/go.mod docker/web/go.sum ./
RUN go mod download
COPY docker/web/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /kkss-web .

FROM caddy:2.11.4 AS caddy-binary
FROM ghcr.io/astral-sh/uv:0.12.10 AS uv-binary
#
# KKSS streamed-desktop image: the unmodified Electron app runs headless under
# Xvfb with SwiftShader software rendering (the same setup the CI smoke test
# proves) and is streamed to the browser via x11vnc + noVNC on port 6080.
#
# Two stages. The builder compiles the app and packages it with the project's
# own electron-builder config; the runtime carries ONLY that packaged output
# plus the X/VNC stack — no Node, no npm, no source tree, and none of the
# ~730 MB of cad/ + mesh/ build-only node_modules.
#
# Build context is the repo root and REQUIRES initialized submodules:
#   git submodule update --init --recursive
# Then: docker compose up --build   →   http://localhost:6080/

# ---------------------------------------------------------------- builder ---
FROM node:20-bookworm AS builder

WORKDIR /kkss

# Dependency layer — cached unless a lockfile changes. COPY overlays (never
# deletes), so the installed node_modules trees survive the later `COPY . .`
# (.dockerignore excludes the host's node_modules).
COPY package.json package-lock.json ./
COPY cad/package.json cad/package-lock.json ./cad/
COPY mesh/package.json mesh/package-lock.json ./mesh/
# The trailing install.js run forces the Electron binary download into
# node_modules/electron/dist at build time — npm ci alone can leave it out, and
# electron-builder needs it to assemble the packaged app below.
RUN --mount=type=cache,target=/root/.npm \
    npm ci && npm run submodules:install \
 && node node_modules/electron/install.js \
 && test -x node_modules/electron/dist/electron

COPY . .
# `dist:dir` = build + `electron-builder --dir`: the same packaging path a
# release uses, minus the installer targets, producing release/linux-unpacked.
# Packaging (rather than copying out/ by hand) means electron-builder.yml's
# `files` rules stay the single source of truth for what the app needs at
# runtime — no second, drifting list here.
# electron-builder suffixes the output directory with the architecture on
# anything but x64 (`linux-unpacked` vs `linux-arm64-unpacked`), so normalize
# the name — the runtime stage below copies from one fixed path on both. The
# staging path is OUTSIDE the work tree on purpose: /kkss/app is the repo's own
# source directory, and `mv` would move the package *into* it.
RUN --mount=type=cache,target=/root/.cache/electron-builder \
    npm run dist:dir \
 && mv "$(find release -maxdepth 1 -type d -name 'linux*unpacked' -print -quit)" /packaged \
 && test -x /packaged/kkss

# ---------------------------------------------------------------- runtime ---
FROM debian:bookworm-slim AS runtime-base

# Same Debian release as the builder, so node-pty's compiled binary keeps its
# glibc ABI.
LABEL org.opencontainers.image.title="KKSS" \
      org.opencontainers.image.description="Keep Kratos Simple Stupid — pre- and post-processing for Kratos Multiphysics, streamed to the browser" \
      org.opencontainers.image.source="https://github.com/loumalouomega/KKSS" \
      org.opencontainers.image.documentation="https://loumalouomega.github.io/KKSS/guide/web-deployment" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Electron/Chromium runtime libs + display/streaming stack + glue. x11-utils
# supplies xdpyinfo, which entrypoint.sh polls to know the display is up (and
# the healthcheck uses) — nothing else pulls it in, so it must be explicit.
#
# `apt-get upgrade` runs before the explicit installs, not just alongside
# them: this whole RUN is one BuildKit layer, cached by instruction text plus
# upstream state (docker.yml's `cache-from: type=gha`) — `debian:bookworm-slim`
# is a rolling tag, so an unchanged Dockerfile can keep hitting a stale cached
# layer indefinitely even as Debian ships security point-releases for
# already-resolved packages (libaom3, libssh2-1, …, pulled in transitively by
# the libs above / curl). The scan step only gates a *tag* push
# (docker.yml's `exit-code`), so that staleness is invisible on every ordinary
# branch push and only surfaces as a release-time failure. Upgrading first
# fixes already-installed packages too, and — just as importantly — changing
# this RUN's own text is what busts its cache on the next build.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
 && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 \
    libgtk-3-0 libgbm1 libasound2 libxss1 libxcomposite1 libxtst6 \
    libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libuuid1 \
    libx11-xcb1 libxcb-dri3-0 libsecret-1-0 libnotify4 \
    xdg-utils fonts-liberation ca-certificates dbus-x11 \
    xvfb openbox x11vnc novnc websockify x11-utils \
    tini xdotool procps curl openssl tigervnc-standalone-server tigervnc-tools mesa-utils libegl1 libgl1-mesa-dri \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. uid/gid 1000 matches the first user on most Linux
# hosts, so a bind-mounted /workspace is writable without chown'ing it first.
# The userdata directory is created here (not left to Docker) so a named volume
# mounted over it inherits this ownership instead of root's.
#
# /tmp/.X11-unix is created here too, root-owned with the standard 1777 mode.
# Left to Xvfb itself at container start it is created by a non-root process
# (entrypoint.sh runs Xvfb as uid 1000), and xtrans's _XSERVTransmkdir refuses
# that on principle (the directory must be root-owned for the X11 socket to
# be trustworthy), logging "_XSERVTransmkdir: ERROR: euid != 0" and leaving
# Xvfb without its usual listener. Observed once on v1.10.0's arm64 boot check
# (openbox/x11vnc failing to open :99, container exiting before noVNC came
# up) while the identical image built from the identical commit passed
# moments earlier on the master-branch build — i.e. an intermittent race, not
# a deterministic break. Pre-creating the directory at build time, while
# still root, removes the race rather than relying on winning it.
RUN groupadd --gid 1000 kkss \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash kkss \
 && mkdir -p /workspace /home/kkss/.config/kkss /home/kkss/.config/caddy /home/kkss/.local/share/caddy /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R kkss:kkss /workspace /home/kkss

# The packaged app stays root-owned and read-only to the runtime user — it
# never writes into its own directory, and a non-root process that cannot
# modify its own binaries is the point of running non-root at all.
COPY --from=builder /packaged /opt/kkss
COPY --from=web-builder /kkss-web /opt/kkss-web
COPY --from=caddy-binary /usr/bin/caddy /usr/bin/caddy
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# User simulation files are mounted here (the in-app GTK dialogs browse the
# container filesystem, not the host's).
VOLUME /workspace

# Numeric rather than `kkss` so a runtime that has to resolve the id without
# reading /etc/passwd (Kubernetes' runAsNonRoot, for one) still sees a non-root
# user. Same account created above.
USER 1000:1000
# C.UTF-8 is built into glibc (no `locales` package needed). Without it the
# X window title round-trips through ANSI_X3.4-1968 and mangles the app's
# non-ASCII characters.
ENV LANG=C.UTF-8 \
    DISPLAY=:99 \
    DISPLAY_SIZE=1920x1080 \
    NOVNC_PORT=6080 \
    KKSS_BIN=/opt/kkss/kkss
EXPOSE 6080 6443

# Feature-level probe, not just "the port answers": noVNC has to serve, the X
# display has to exist, and the app process has to be alive — otherwise a
# crashed viewer looks healthy while streaming a black screen.
# Exec form with an explicit shell (rather than the shell form) so the JSON
# notation is unambiguous; the env vars are still expanded, just by this shell
# at run time. The last command's status is the health verdict — no `|| exit 1`
# needed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s \
  CMD ["/bin/sh", "-c", "if [ \"${KKSS_TLS_TERMINATED:-0}\" != 1 ] && echo \"${KKSS_PUBLIC_URL:-}\" | grep -q '^https://'; then host=\"${KKSS_PUBLIC_URL#https://}\"; host=\"${host%%/*}\"; host=\"${host%%:*}\"; curl -kfsS --resolve \"$host:6443:127.0.0.1\" \"https://$host:6443/healthz\" >/dev/null; else curl -fsS \"http://127.0.0.1:${NOVNC_PORT}/healthz\" >/dev/null; fi && xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && pgrep -f \"$KKSS_BIN\" >/dev/null"]

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]


FROM runtime-base AS runtime-kratos
ARG TARGETARCH
USER root
COPY --from=uv-binary /uv /uvx /opt/uv/
COPY docker/kratos/requirements.lock /opt/kratos-requirements.lock
RUN test "$TARGETARCH" = amd64 \
 && UV_PYTHON_INSTALL_DIR=/opt/python /opt/uv/uv python install 3.12 \
 && UV_PYTHON_INSTALL_DIR=/opt/python /opt/uv/uv venv --python 3.12 /opt/kkss-kratos \
 && /opt/uv/uv pip install --python /opt/kkss-kratos/bin/python --require-hashes --only-binary :all: -r /opt/kratos-requirements.lock \
 && /opt/kkss-kratos/bin/python -c "import KratosMultiphysics; import KratosMultiphysics.StructuralMechanicsApplication; import KratosMultiphysics.FluidDynamicsApplication; import KratosMultiphysics.ConvectionDiffusionApplication; import KratosMultiphysics.CompressiblePotentialFlowApplication; import KratosMultiphysics.ShallowWaterApplication" \
 && chmod -R a+rX /opt/python /opt/kkss-kratos
COPY docker/kratos/check-licenses.py /opt/check-kratos-licenses.py
RUN /opt/kkss-kratos/bin/python /opt/check-kratos-licenses.py > /opt/kratos-licenses.json
USER 1000:1000

# The runtime stage is intentionally selected by the build variant (base or
# kratos); both names are defined above in this Dockerfile.
# hadolint ignore=DL3006
FROM runtime-${KKSS_VARIANT} AS runtime
