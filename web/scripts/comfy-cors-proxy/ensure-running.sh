#!/usr/bin/env bash
# Idempotent: free :6006 for nginx, keep ComfyUI on 127.0.0.1:8188.
# Safe to run on every boot / manually after reboot.
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/root/ComfyUI}"
COMFY_PORT=8188
PUBLIC_PORT=6006
LOG=/tmp/comfyui-8188.log

free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
    return
  fi
  # AutoDL often lacks psmisc/fuser — fall back to ss + kill.
  local pids
  pids="$(ss -lntp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
}

port_held_by() {
  local port="$1" name="$2"
  ss -lntp "sport = :${port}" 2>/dev/null | grep -q "${name}" && return 0
  return 1
}

echo "==> ensure ComfyUI + nginx CORS proxy"

# If :6006 is not nginx (e.g. AutoDL default Comfy grabbed it), clear it.
if ss -lntp "sport = :${PUBLIC_PORT}" 2>/dev/null | grep -q LISTEN; then
  if ! port_held_by "${PUBLIC_PORT}" nginx; then
    echo "==> :${PUBLIC_PORT} held by non-nginx — freeing"
    pkill -f "python.*main.py" 2>/dev/null || true
    free_port "${PUBLIC_PORT}"
    sleep 1
  fi
fi

# Comfy must listen only on localhost :8188
if ! ss -lntp "sport = :${COMFY_PORT}" 2>/dev/null | grep -q "127.0.0.1:${COMFY_PORT}"; then
  echo "==> starting ComfyUI on 127.0.0.1:${COMFY_PORT}"
  pkill -f "python.*main.py" 2>/dev/null || true
  free_port "${COMFY_PORT}"
  sleep 1
  if [[ ! -d "${COMFY_DIR}" ]]; then
    echo "ERROR: ComfyUI not found at ${COMFY_DIR}"
    exit 1
  fi
  cd "${COMFY_DIR}"
  nohup python main.py --listen 127.0.0.1 --port "${COMFY_PORT}" --enable-cors-header \
    >"${LOG}" 2>&1 &
  echo $! >/tmp/comfyui-8188.pid
  sleep 3
else
  echo "==> ComfyUI already on :${COMFY_PORT}"
fi

# nginx on :6006
if ! command -v nginx >/dev/null 2>&1; then
  echo "ERROR: nginx not installed — run bootstrap-paste.sh once first"
  exit 1
fi
nginx -t
if pgrep -x nginx >/dev/null 2>&1; then
  if port_held_by "${PUBLIC_PORT}" nginx; then
    nginx -s reload
    echo "==> nginx reloaded on :${PUBLIC_PORT}"
  else
    free_port "${PUBLIC_PORT}"
    sleep 1
    nginx -s reload || nginx
  fi
else
  free_port "${PUBLIC_PORT}"
  sleep 1
  nginx
  echo "==> nginx started on :${PUBLIC_PORT}"
fi

echo "==> listening:"
ss -lntp | grep -E ":${PUBLIC_PORT}|:${COMFY_PORT}" || true
echo "OK. log: ${LOG}"
