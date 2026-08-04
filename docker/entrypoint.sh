#!/usr/bin/env bash
# Container entrypoint: virtual display → window manager → VNC → noVNC → KKSS.
#
# It also supervises those processes. Each is tracked, `wait -n` wakes on the
# FIRST one to exit, and the rest are torn down — otherwise a dead Xvfb or
# websockify leaves the container "up" while serving nothing. A TERM/INT trap
# forwards the signal to every child so `docker stop` is prompt instead of
# waiting out the 10-second SIGKILL timeout.
#
# The Electron flag set below must stay in sync with tools/smoke.e2e.mjs /
# tools/e2eShared.mjs (the CI-proven headless configuration), and Electron must
# be launched with ELECTRON_RUN_AS_NODE unset or it runs as plain Node.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${DISPLAY_SIZE:=1920x1080}"
: "${NOVNC_PORT:=6080}"
: "${KKSS_BIN:=/opt/kkss/kkss}"
export DISPLAY

declare -a CHILDREN=()
SHUTTING_DOWN=0
# The window-sizing helper below is a child too, but deliberately NOT in
# CHILDREN: it must not be waited on (it exits by itself) — only killed.
HELPER_PID=""

# Names are parallel to CHILDREN purely so a failure can say what died.
declare -a CHILD_NAMES=()
track() { CHILDREN+=("$1"); CHILD_NAMES+=("$2"); }

shutdown() {
  local signal="${1:-TERM}"
  [ "$SHUTTING_DOWN" = "1" ] && return 0 # a second signal is a no-op
  SHUTTING_DOWN=1
  for pid in "${CHILDREN[@]}" ${HELPER_PID:+"$HELPER_PID"}; do
    kill -"$signal" "$pid" 2>/dev/null || true
  done
}

# Bounded drain. A bare `wait` would block on any still-running child — the
# helper sleeps for up to 30s — and `docker stop` would give up and SIGKILL at
# its 10s timeout instead of exiting cleanly.
drain() {
  local _ pid still
  for _ in $(seq 1 30); do
    still=0
    for pid in "${CHILDREN[@]}"; do
      kill -0 "$pid" 2>/dev/null && still=1
    done
    [ "$still" = "0" ] && return 0
    sleep 0.1
  done
}
trap 'shutdown TERM' TERM
trap 'shutdown INT' INT

Xvfb "$DISPLAY" -screen 0 "${DISPLAY_SIZE}x24" -nolisten tcp &
track $! Xvfb

# Wait for the display to accept connections before starting anything that
# needs it. xdpyinfo comes from x11-utils (installed explicitly in the
# Dockerfile) — without it this loop would silently just be a sleep.
display_ready=0
for _ in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then
    display_ready=1
    break
  fi
  sleep 0.2
done
if [ "$display_ready" != "1" ]; then
  echo "entrypoint: Xvfb did not come up on $DISPLAY within 10s" >&2
  shutdown TERM
  exit 1
fi

# A window manager is required for GTK dialog focus/stacking and maximize.
openbox &
track $! openbox

# VNC stays loopback-only; the browser reaches it through websockify.
VNC_ARGS=(-display "$DISPLAY" -forever -shared -localhost -rfbport 5900 -noxdamage)
if [ -n "${VNC_PASSWORD:-}" ]; then
  VNC_ARGS+=(-passwd "$VNC_PASSWORD")
else
  VNC_ARGS+=(-nopw)
fi
x11vnc "${VNC_ARGS[@]}" &
track $! x11vnc

websockify --web /usr/share/novnc "$NOVNC_PORT" localhost:5900 &
track $! websockify

FILE_ARG=()
[ -n "${OPEN_FILE:-}" ] && FILE_ARG=("$OPEN_FILE")
env -u ELECTRON_RUN_AS_NODE "$KKSS_BIN" \
  --no-sandbox --enable-unsafe-swiftshader --disable-gpu-sandbox \
  --use-gl=angle --use-angle=swiftshader --disable-gpu-compositing \
  --disable-dev-shm-usage \
  ${FILE_ARG[@]+"${FILE_ARG[@]}"} &
track $! KKSS

# Best-effort: size the window to the virtual display once it appears. Not
# tracked — it is a one-shot helper whose exit must not bring the container
# down (the packaged app's WM_CLASS is "kkss", but match the title, which is
# stable across packaged and unpackaged runs).
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
HELPER_PID=$!

# Wake on whichever supervised child exits first. The pid list is explicit
# (bash >= 5.1): a bare `wait -n` would also wake on the one-shot xdotool
# helper above, which finishes on its own within a minute and would take the
# whole container down with it. `set -e` would abort on a non-zero status, so
# the status is captured explicitly.
set +e
wait -n "${CHILDREN[@]}"
status=$?
set -e

if [ "$SHUTTING_DOWN" = "1" ]; then
  # An orderly `docker stop`: children were signalled on purpose.
  shutdown TERM
  drain
  exit 0
fi

# Report which one went, then take the rest with it so the container's exit
# reflects the failure instead of idling on a half-dead stack.
for i in "${!CHILDREN[@]}"; do
  if ! kill -0 "${CHILDREN[$i]}" 2>/dev/null; then
    echo "entrypoint: ${CHILD_NAMES[$i]} exited (status $status) — shutting down" >&2
  fi
done
shutdown TERM
drain
exit "$status"
