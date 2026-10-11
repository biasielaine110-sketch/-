#!/usr/bin/env bash
# Run inside AutoDL / seetacloud Jupyter Terminal (as root).
# Moves ComfyUI to :8188 and puts nginx+CORS on :6006 (public :8443).
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/root/ComfyUI}"
CONF_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-comfy-cors.conf"
CONF_DST="/etc/nginx/sites-available/comfy-cors"
COMFY_PORT_INTERNAL=8188
PUBLIC_PORT=6006

echo "==> 1) Install nginx if needed"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
fi

echo "==> 2) Install CORS nginx site"
# map{} must be in http{} context — include a dedicated file from nginx.conf when needed.
cp "$CONF_SRC" /etc/nginx/comfy-cors-http.conf
if ! grep -q 'comfy-cors-http.conf' /etc/nginx/nginx.conf; then
  sed -i '/http {/a\    include /etc/nginx/comfy-cors-http.conf;' /etc/nginx/nginx.conf
fi
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
rm -f /etc/nginx/conf.d/comfy-cors.conf 2>/dev/null || true

echo "==> 3) Stop anything on :${PUBLIC_PORT} and :${COMFY_PORT_INTERNAL}"
# Prefer graceful kill of ComfyUI main.py
if pgrep -f "python.*main.py" >/dev/null 2>&1; then
  pkill -f "python.*main.py" || true
  sleep 2
fi
fuser -k "${PUBLIC_PORT}/tcp" 2>/dev/null || true
fuser -k "${COMFY_PORT_INTERNAL}/tcp" 2>/dev/null || true
sleep 1

echo "==> 4) Start ComfyUI on 127.0.0.1:${COMFY_PORT_INTERNAL}"
if [[ ! -d "$COMFY_DIR" ]]; then
  echo "ERROR: ComfyUI not found at $COMFY_DIR — set COMFY_DIR=..."
  exit 1
fi
cd "$COMFY_DIR"
# Listen only on localhost so public traffic must go through nginx CORS layer.
nohup python main.py --listen 127.0.0.1 --port "${COMFY_PORT_INTERNAL}" --enable-cors-header \
  >/tmp/comfyui-8188.log 2>&1 &
echo $! >/tmp/comfyui-8188.pid
sleep 3
if ! curl -sf "http://127.0.0.1:${COMFY_PORT_INTERNAL}/system_stats" >/dev/null 2>&1; then
  echo "WARN: ComfyUI /system_stats not ready yet — check /tmp/comfyui-8188.log"
  echo "      (Login may return 401; that still means the process is up.)"
fi

echo "==> 5) Test nginx config and reload"
nginx -t
# Prefer reload; if nginx not running, start it
if pgrep -x nginx >/dev/null 2>&1; then
  nginx -s reload
else
  nginx
fi

echo "==> 6) Smoke-test CORS preflight on :${PUBLIC_PORT}"
curl -sI -X OPTIONS "http://127.0.0.1:${PUBLIC_PORT}/system_stats" \
  -H "Origin: https://infinite-atelier.pages.dev" \
  -H "Access-Control-Request-Method: GET" | sed -n '1,20p'

echo ""
echo "DONE."
echo "Public URL stays: https://<your-id>.westd.seetacloud.com:8443"
echo "Canvas: Base URL = that URL; API transport = 浏览器直连"
echo "Comfy log: /tmp/comfyui-8188.log"
echo "Stop later: pkill -f 'python.*main.py'; nginx -s stop"
