#!/usr/bin/env bash
# 整段复制到 AutoDL 终端执行一次即可：之后每次开机自动拉起 ComfyUI(:8188) + nginx(:6006)。
# 前提：已跑过 bootstrap-paste.sh（nginx 配置已在）。
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/root/ComfyUI}"
mkdir -p /root/comfy-cors-proxy

cat >/root/comfy-cors-proxy/ensure-running.sh <<'EOF'
#!/usr/bin/env bash
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
  local pids
  pids="$(ss -lntp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    kill ${pids} 2>/dev/null || true
    sleep 1
    kill -9 ${pids} 2>/dev/null || true
  fi
}

port_held_by() {
  local port="$1" name="$2"
  ss -lntp "sport = :${port}" 2>/dev/null | grep -q "${name}" && return 0
  return 1
}

echo "==> ensure ComfyUI + nginx CORS proxy"

if ss -lntp "sport = :${PUBLIC_PORT}" 2>/dev/null | grep -q LISTEN; then
  if ! port_held_by "${PUBLIC_PORT}" nginx; then
    echo "==> :${PUBLIC_PORT} held by non-nginx — freeing"
    pkill -f "python.*main.py" 2>/dev/null || true
    free_port "${PUBLIC_PORT}"
    sleep 1
  fi
fi

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

if ! command -v nginx >/dev/null 2>&1; then
  echo "ERROR: nginx not installed — run bootstrap-paste.sh once first"
  exit 1
fi
nginx -t
if pgrep -x nginx >/dev/null 2>&1; then
  if port_held_by "${PUBLIC_PORT}" nginx; then
    nginx -s reload
  else
    free_port "${PUBLIC_PORT}"
    sleep 1
    nginx -s reload || nginx
  fi
else
  free_port "${PUBLIC_PORT}"
  sleep 1
  nginx
fi

ss -lntp | grep -E ":${PUBLIC_PORT}|:${COMFY_PORT}" || true
echo "OK. log: ${LOG}"
EOF
chmod +x /root/comfy-cors-proxy/ensure-running.sh

# systemd unit: wait a bit so AutoDL 自带启动脚本先抢 6006，再由我们接管
cat >/etc/systemd/system/comfy-cors-proxy.service <<EOF
[Unit]
Description=ComfyUI + nginx CORS proxy (seetacloud :8443 -> :6006)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=COMFY_DIR=${COMFY_DIR}
# AutoDL 常先把 Comfy 挂到 6006；延迟后接管
ExecStartPre=/bin/sleep 15
ExecStart=/root/comfy-cors-proxy/ensure-running.sh
ExecStop=/bin/bash -c 'pkill -f "python.*main.py" || true; nginx -s stop || true'
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable comfy-cors-proxy.service

# 立刻跑一次，当前会话也可用
/root/comfy-cors-proxy/ensure-running.sh

# crontab 兜底（部分镜像 systemd enable 后仍偶发不跑）
CRON_LINE="@reboot sleep 20 && COMFY_DIR=${COMFY_DIR} /root/comfy-cors-proxy/ensure-running.sh >>/tmp/comfy-cors-boot.log 2>&1"
(crontab -l 2>/dev/null | grep -v 'comfy-cors-proxy/ensure-running.sh' || true; echo "${CRON_LINE}") | crontab -

echo ""
echo "已安装开机自启："
echo "  systemctl status comfy-cors-proxy"
echo "  日志: /tmp/comfyui-8188.log  /tmp/comfy-cors-boot.log"
echo "下次开机约 15–20 秒后自动接管 :6006（nginx）+ :8188（Comfy）。"
echo "手动立刻修复仍可执行: /root/comfy-cors-proxy/ensure-running.sh"
