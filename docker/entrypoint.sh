#!/usr/bin/env bash
# Container entrypoint: virtual display → window manager → VNC → noVNC → KKSS.
# The Electron flag set below must stay in sync with tools/smoke.e2e.mjs /
# tools/e2eShared.mjs (the CI-proven headless configuration), and Electron must
# be launched with ELECTRON_RUN_AS_NODE unset or it runs as plain Node.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${DISPLAY_SIZE:=1920x1080}"
: "${NOVNC_PORT:=6080}"
export DISPLAY

Xvfb "$DISPLAY" -screen 0 "${DISPLAY_SIZE}x24" -nolisten tcp &
for _ in $(seq 1 50); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.2
done

# A window manager is required for GTK dialog focus/stacking and maximize.
openbox &

# VNC stays loopback-only; the browser reaches it through websockify.
VNC_ARGS=(-display "$DISPLAY" -forever -shared -localhost -rfbport 5900 -noxdamage)
if [ -n "${VNC_PASSWORD:-}" ]; then
  VNC_ARGS+=(-passwd "$VNC_PASSWORD")
else
  VNC_ARGS+=(-nopw)
fi
x11vnc "${VNC_ARGS[@]}" &

websockify --web /usr/share/novnc "$NOVNC_PORT" localhost:5900 &

cd /kkss
FILE_ARG=()
[ -n "${OPEN_FILE:-}" ] && FILE_ARG=("$OPEN_FILE")
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
  --no-sandbox --enable-unsafe-swiftshader --disable-gpu-sandbox \
  --use-gl=angle --use-angle=swiftshader --disable-gpu-compositing \
  --disable-dev-shm-usage \
  ${FILE_ARG[@]+"${FILE_ARG[@]}"} &
APP_PID=$!

# Best-effort: size the window to the virtual display once it appears
# (unpackaged Electron's WM_CLASS is "electron", so match the title instead).
(
  for _ in $(seq 1 60); do
    WIN=$(xdotool search --onlyvisible --name "KKSS" 2>/dev/null | head -1) || true
    if [ -n "${WIN:-}" ]; then
      xdotool windowsize "$WIN" 100% 100%
      break
    fi
    sleep 0.5
  done
) &

wait "$APP_PID"
