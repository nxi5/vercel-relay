#!/bin/bash
# boot.sh — Install & configure Hermes Agent inside a Daytona sandbox.
# Runs ON THE SANDBOX, streamed over SSH by /api/provision.
# Env (exported before this runs):
#   RELAY_BASE  e.g. https://vercel-relay-steel-nine-15.vercel.app
#   CF_ACCT     Cloudflare account id
#   CF_TOKEN    Cloudflare AI inference token
#   MODEL       e.g. @cf/zai-org/glm-5.3-flash
# Progress logged to /opt/boot.log (JSON lines, parsed by /api/provision).
set -u
LOG=/opt/boot.log
log() { echo "{\"s\":\"$1\",\"m\":\"$2\"}" >> "$LOG"; }

log start "installer begins"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || log warn "apt update failed (continuing)"
apt-get install -y -qq curl git ca-certificates python3 python3-pip python3-venv build-essential >/dev/null 2>&1 \
  || { log error "apt install failed"; exit 1; }
log deps "apt packages installed"

python3 -m pip install --quiet --break-system-packages uv >/dev/null 2>&1 \
  || python3 -m pip install --quiet uv >/dev/null 2>&1 \
  || { log error "uv install failed"; exit 1; }
log uv "uv available"

# astral.sh is DPI-blocked, but uv pulls managed CPython from GitHub (whitelisted)
if ! /usr/local/bin/uv python install 3.12 >> "$LOG" 2>&1; then
  log warn "uv managed python failed, falling back to system python"
fi
if ! /usr/local/bin/uv venv /opt/hv --python 3.12 >> "$LOG" 2>&1; then
  /usr/local/bin/uv venv /opt/hv >> "$LOG" 2>&1 \
    || { log error "venv creation failed"; exit 1; }
fi
log venv "venv ready at /opt/hv"

/usr/local/bin/uv pip install --python /opt/hv/bin/python hermes-agent >> "$LOG" 2>&1 \
  || { log error "hermes-agent install failed"; exit 1; }
log hermes "hermes-agent installed"

ln -sf /opt/hv/bin/hermes /usr/local/bin/hermes
log path "hermes symlinked to /usr/local/bin"

# OSC-11 fix: Daytona's gateway never sets SSH_CONNECTION, so hermes' terminal
# background-color query leaks rgb:... into the prompt. Pre-set the var so the
# built-in guard engages.
grep -q "SSH_CONNECTION" /root/.bashrc 2>/dev/null \
  || echo 'export SSH_CONNECTION="${SSH_CONNECTION:-local}"' >> /root/.bashrc
log osc11 "bashrc guard added"

mkdir -p /root/.hermes
cat > /root/.hermes/config.yaml << EOF
model:
  provider: custom
  name: "${MODEL}"
  base_url: "${RELAY_BASE}/client/v4/accounts/${CF_ACCT}/ai/v1"
  api_key: "${CF_TOKEN}"
EOF
log config "hermes config written"

hermes --version > /dev/null 2>&1 \
  || { log error "hermes not runnable"; exit 1; }
log done "hermes $(hermes --version 2>/dev/null | head -1)"
echo "BOOT-DONE"
