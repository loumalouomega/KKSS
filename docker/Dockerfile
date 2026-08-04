# syntax=docker/dockerfile:1
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
# Then: docker compose up --build   →   http://localhost:6080/vnc.html

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
 && mv "$(find release -maxdepth 1 -type d -name 'linux*unpacked' | head -1)" /packaged \
 && test -x /packaged/kkss

# ---------------------------------------------------------------- runtime ---
FROM debian:bookworm-slim AS runtime

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
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
 && apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 \
    libgtk-3-0 libgbm1 libasound2 libxss1 libxcomposite1 libxtst6 \
    libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libuuid1 \
    libx11-xcb1 libxcb-dri3-0 libsecret-1-0 libnotify4 \
    xdg-utils fonts-liberation ca-certificates dbus-x11 \
    xvfb openbox x11vnc novnc websockify x11-utils \
    tini xdotool procps curl \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. uid/gid 1000 matches the first user on most Linux
# hosts, so a bind-mounted /workspace is writable without chown'ing it first.
# The userdata directory is created here (not left to Docker) so a named volume
# mounted over it inherits this ownership instead of root's.
RUN groupadd --gid 1000 kkss \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash kkss \
 && mkdir -p /workspace /home/kkss/.config/kkss \
 && chown -R kkss:kkss /workspace /home/kkss

# The packaged app stays root-owned and read-only to the runtime user — it
# never writes into its own directory, and a non-root process that cannot
# modify its own binaries is the point of running non-root at all.
COPY --from=builder /packaged /opt/kkss
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# User simulation files are mounted here (the in-app GTK dialogs browse the
# container filesystem, not the host's).
VOLUME /workspace

USER kkss
# C.UTF-8 is built into glibc (no `locales` package needed). Without it the
# X window title round-trips through ANSI_X3.4-1968 and mangles the app's
# non-ASCII characters.
ENV LANG=C.UTF-8 \
    DISPLAY=:99 \
    DISPLAY_SIZE=1920x1080 \
    NOVNC_PORT=6080 \
    KKSS_BIN=/opt/kkss/kkss
EXPOSE 6080

# Feature-level probe, not just "the port answers": noVNC has to serve, the X
# display has to exist, and the app process has to be alive — otherwise a
# crashed viewer looks healthy while streaming a black screen.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s \
  CMD curl -fsS "http://localhost:${NOVNC_PORT}/" >/dev/null \
      && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 \
      && pgrep -f "$KKSS_BIN" >/dev/null || exit 1

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
