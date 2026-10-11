#!/usr/bin/env bash
# 整段复制到 AutoDL Jupyter「终端」执行即可（无需先拉取仓库）。
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/root/ComfyUI}"
mkdir -p /root/comfy-cors-proxy /etc/nginx/conf.d

cat >/root/comfy-cors-proxy/nginx-comfy-cors.conf <<'NGINX'
map $http_origin $cors_origin {
    default "";
    "https://infinite-atelier.pages.dev" $http_origin;
    "https://infinite-atelier-web.vercel.app" $http_origin;
    "~^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$" $http_origin;
}

server {
    listen 6006;
    server_name _;
    client_max_body_size 64m;

    location / {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin $cors_origin always;
            add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE, HEAD" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With" always;
            add_header Access-Control-Allow-Credentials "true" always;
            add_header Access-Control-Max-Age 86400 always;
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }

        proxy_pass http://127.0.0.1:8188;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        proxy_hide_header Access-Control-Allow-Headers;

        add_header Access-Control-Allow-Origin $cors_origin always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE, HEAD" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With" always;
        add_header Access-Control-Allow-Credentials "true" always;
    }
}
NGINX

echo "==> install nginx"
command -v nginx >/dev/null 2>&1 || { apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx; }

echo "==> wire config"
# Prefer conf.d (always included). Also disable default site if present.
cp /root/comfy-cors-proxy/nginx-comfy-cors.conf /etc/nginx/conf.d/comfy-cors.conf
# map{} must live in http context — conf.d server-only files sometimes break on map.
# If nginx -t fails on map, wrap into a snippet included from nginx.conf.
if ! nginx -t 2>/tmp/nginx-t.err; then
  if grep -q "map.*directive is not allowed here" /tmp/nginx-t.err; then
    echo "==> moving map+server into /etc/nginx/nginx.conf include style"
    cat >/etc/nginx/conf.d/comfy-cors.conf <<'NGINX2'
# placeholder — real server loaded via /etc/nginx/comfy-cors-http.conf
NGINX2
    # Put full file under /etc/nginx and include from http{} manually if needed.
    cp /root/comfy-cors-proxy/nginx-comfy-cors.conf /etc/nginx/comfy-cors-http.conf
    if ! grep -q 'comfy-cors-http.conf' /etc/nginx/nginx.conf; then
      sed -i '/http {/a\    include /etc/nginx/comfy-cors-http.conf;' /etc/nginx/nginx.conf
    fi
    rm -f /etc/nginx/conf.d/comfy-cors.conf
  else
    cat /tmp/nginx-t.err
    exit 1
  fi
fi

echo "==> stop old Comfy on 6006"
pkill -f "python.*main.py" 2>/dev/null || true
sleep 2
fuser -k 6006/tcp 2>/dev/null || true
fuser -k 8188/tcp 2>/dev/null || true
sleep 1

echo "==> start ComfyUI :8188 (localhost only)"
cd "$COMFY_DIR"
nohup python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header >/tmp/comfyui-8188.log 2>&1 &
echo $! >/tmp/comfyui-8188.pid
sleep 4

echo "==> start/reload nginx"
nginx -t
pgrep -x nginx >/dev/null && nginx -s reload || nginx

echo "==> OPTIONS probe"
curl -sI -X OPTIONS "http://127.0.0.1:6006/system_stats" \
  -H "Origin: https://infinite-atelier.pages.dev" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" | sed -n '1,25p'

echo ""
echo "OK. 公网地址不变，画布 Base URL 仍用原 seetacloud:8443，API 请求方式=浏览器直连"
echo "日志: /tmp/comfyui-8188.log"
