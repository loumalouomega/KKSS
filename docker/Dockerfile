# KKSS streamed-desktop image: the unmodified Electron app runs headless under
# Xvfb with SwiftShader software rendering (the same setup the CI smoke test
# proves) and is streamed to the browser via x11vnc + noVNC on port 6080.
#
# Build context is the repo root and REQUIRES initialized submodules:
#   git submodule update --init --recursive
# Then: docker compose up --build   →   http://localhost:6080/vnc.html
FROM node:20-bookworm

# Electron/Chromium runtime libs + display/streaming stack + glue.
# node:20-bookworm already ships python3/gcc/make for node-pty's source build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libgtk-3-0 libgbm1 libasound2 libxss1 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
    libx11-xcb1 libxcb-dri3-0 libsecret-1-0 libnotify4 \
    xdg-utils fonts-liberation ca-certificates dbus-x11 \
    xvfb openbox x11vnc novnc websockify \
    tini xdotool procps curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /kkss

# Dependency layer — cached unless a lockfile changes. COPY overlays (never
# deletes), so the installed node_modules trees survive the later `COPY . .`
# (.dockerignore excludes the host's node_modules).
COPY package.json package-lock.json ./
COPY cad/package.json cad/package-lock.json ./cad/
COPY mesh/package.json mesh/package-lock.json ./mesh/
# The trailing install.js run forces the Electron binary download into
# node_modules/electron/dist at build time — npm ci alone can leave it out,
# and without it every fresh container re-downloads Electron on first start.
RUN npm ci && npm run submodules:install \
 && node node_modules/electron/install.js \
 && test -x node_modules/electron/dist/electron

COPY . .
RUN npm run build

# User simulation files are mounted here (the in-app GTK dialogs browse the
# container filesystem, not the host's).
RUN mkdir -p /workspace
VOLUME /workspace

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISPLAY=:99 \
    DISPLAY_SIZE=1920x1080 \
    NOVNC_PORT=6080
EXPOSE 6080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://localhost:${NOVNC_PORT}/" >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
