#!/usr/bin/env bash
# The display stays alive until Electron has saved documents and drained uploads.
set -euo pipefail
: "${DISPLAY:=:99}" "${DISPLAY_SIZE:=1920x1080}" "${NOVNC_PORT:=6080}" "${KKSS_BIN:=/opt/kkss/kkss}"
export DISPLAY KKSS_HEADLESS=1
export KKSS_PROJECT_ROOT="${KKSS_PROJECT_ROOT:-/workspace}"
export KKSS_CONTROL_TOKEN="$(openssl rand -hex 32)"
export KKSS_VNC_PASSWORD_FILE=/tmp/kkss-vnc-password
umask 077
VNC_PASSWORD="$(openssl rand -hex 4)"
printf '%s\n' "$VNC_PASSWORD" > "$KKSS_VNC_PASSWORD_FILE"
X11VNC_PASSWORD_FILE=/tmp/kkss-x11vnc-password
if ! x11vnc -storepasswd "$VNC_PASSWORD" "$X11VNC_PASSWORD_FILE" >/dev/null 2>&1; then
  echo 'Could not create the internal VNC password file' >&2
  exit 1
fi
mkdir -p /tmp/kkss-runtime
export XDG_RUNTIME_DIR=/tmp/kkss-runtime
if [ -x /opt/kkss-kratos/bin/python ]; then
  export KKSS_KRATOS_PYTHON=/opt/kkss-kratos/bin/python
  export PATH="/opt/kkss-kratos/bin:$PATH"
  export VIRTUAL_ENV=/opt/kkss-kratos UV_OFFLINE=1
fi
declare -a CHILDREN=() NAMES=()
APP_PID="" HELPER_PID="" STOPPING=0
track() { CHILDREN+=("$1"); NAMES+=("$2"); }
stop_app() {
  [ "$STOPPING" = 1 ] && return 0
  STOPPING=1
  if [ -n "$APP_PID" ]; then kill -TERM "$APP_PID" 2>/dev/null || true; fi
}
trap stop_app TERM INT
cleanup() {
  for pid in "${CHILDREN[@]}" ${HELPER_PID:+"$HELPER_PID"}; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do
    local alive=0
    for pid in "${CHILDREN[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && break
    sleep .1
  done
  for pid in "${CHILDREN[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
if [ "${KKSS_DISPLAY_BACKEND:-xvfb}" = tigervnc ]; then
  # TigerVNC reads its own encrypted password file, never a command-line password.
  vncpasswd -f < "$KKSS_VNC_PASSWORD_FILE" > /tmp/kkss-vnc-auth
  Xvnc "$DISPLAY" -geometry "$DISPLAY_SIZE" -depth 24 -localhost -rfbport 5900 -SecurityTypes VncAuth -PasswordFile /tmp/kkss-vnc-auth -AcceptSetDesktopSize=1 -nolisten tcp &
  track $! Xvnc
elif [ "${KKSS_DISPLAY_BACKEND:-xvfb}" = xvfb ]; then
  Xvfb "$DISPLAY" -screen 0 "${DISPLAY_SIZE}x24" -nolisten tcp -noreset &
  track $! Xvfb
else echo 'Unknown KKSS_DISPLAY_BACKEND' >&2; exit 1; fi
ready=0
for _ in $(seq 1 50); do if xdpyinfo >/dev/null 2>&1; then ready=1; break; fi; sleep .2; done
[ "$ready" = 1 ] || { echo 'Display failed to start' >&2; exit 1; }
openbox &
track $! openbox
if [ "${KKSS_DISPLAY_BACKEND:-xvfb}" = xvfb ]; then
  x11vnc -display "$DISPLAY" -forever -shared -localhost -rfbport 5900 -noxdamage -passwdfile "$X11VNC_PASSWORD_FILE" &
  track $! x11vnc
fi
websockify --web /usr/share/novnc 127.0.0.1:6081 localhost:5900 &
track $! websockify
/opt/kkss-web caddy-config > /tmp/kkss-caddy.json
/opt/kkss-web &
track $! gateway
caddy run --config /tmp/kkss-caddy.json &
track $! caddy
# Software flags match tools/e2eShared.mjs. GPU is a separate opt-in profile.
FLAGS=(--no-sandbox --enable-unsafe-swiftshader --disable-gpu-sandbox --use-gl=angle --use-angle=swiftshader --disable-gpu-compositing --disable-dev-shm-usage)
if [ "${KKSS_GPU:-0}" = 1 ]; then
  compgen -G '/dev/dri/renderD*' >/dev/null || { echo 'KKSS_GPU requires a /dev/dri render device' >&2; exit 1; }
  # Validate hardware EGL before claiming acceleration; renderer identity is logged for diagnostics.
  EGL_PLATFORM=surfaceless eglinfo -B > /tmp/kkss-egl.txt 2>&1 || { echo 'Hardware EGL probe failed' >&2; exit 1; }
  if ! grep -Eq 'iris|radeonsi|crocus' /tmp/kkss-egl.txt; then echo 'No supported Intel/AMD EGL driver initialized' >&2; exit 1; fi
  FLAGS=(--no-sandbox --disable-gpu-sandbox --use-gl=angle --use-angle=gl-egl --disable-dev-shm-usage)
fi
FILE_ARG=(); [ -n "${OPEN_FILE:-}" ] && FILE_ARG=("$OPEN_FILE")
env -u ELECTRON_RUN_AS_NODE "$KKSS_BIN" "${FLAGS[@]}" "${FILE_ARG[@]}" &
APP_PID=$!; track "$APP_PID" KKSS
(
  for _ in $(seq 1 60); do
    WIN=$(xdotool search --onlyvisible --name KKSS 2>/dev/null | head -1) || true
    if [ -n "${WIN:-}" ]; then xdotool windowsize "$WIN" 100% 100%; break; fi
    sleep .5
  done
) &
HELPER_PID=$!
echo "KKSS: ${KKSS_PUBLIC_URL:-http://localhost:6080}${KKSS_BASE_PATH:-}/"
set +e
wait -n -p EXITED "${CHILDREN[@]}"
status=$?
set -e
if [ "$STOPPING" = 1 ] || [ "${EXITED:-}" != "$APP_PID" ]; then
  stop_app
  for _ in $(seq 1 300); do kill -0 "$APP_PID" 2>/dev/null || break; sleep .1; done
  if kill -0 "$APP_PID" 2>/dev/null; then echo 'Electron failed to shut down within 30 seconds' >&2; exit 1; fi
  set +e
  wait "$APP_PID"
  app_status=$?
  set -e
  # A non-app child exiting unexpectedly must not become a successful stop.
  if [ -n "${EXITED:-}" ]; then [ "$status" != 0 ] || status=1; else status=$app_status; fi
fi
exit "$status"
