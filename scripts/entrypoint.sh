#!/usr/bin/env bash
# Container entrypoint. Generates a self-signed TLS cert on first run if
# TLS_ENABLE=1 (so getUserMedia works from non-localhost origins) and
# hands off to gunicorn. The cert lives in /app/instance/certs so it
# persists across container restarts via the named volume.

set -euo pipefail

CERT_DIR="${TLS_CERT_DIR:-/app/instance/certs}"
CERT_FILE="${CERT_DIR}/server.crt"
KEY_FILE="${CERT_DIR}/server.key"

ensure_cert() {
  mkdir -p "${CERT_DIR}"

  if [[ -s "${CERT_FILE}" && -s "${KEY_FILE}" ]]; then
    return 0
  fi

  echo "[entrypoint] No TLS cert in ${CERT_DIR} — generating self-signed cert."
  local hosts="${TLS_HOSTS:-localhost,127.0.0.1}"
  local san=""
  local h ip_re='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'

  IFS=',' read -ra parts <<< "${hosts}"
  for h in "${parts[@]}"; do
    # shellcheck disable=SC2001
    h="$(echo "$h" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$h" ]] && continue
    [[ -n "$san" ]] && san+=", "
    if [[ "$h" =~ $ip_re ]]; then
      san+="IP:$h"
    else
      san+="DNS:$h"
    fi
  done
  [[ -z "$san" ]] && san="DNS:localhost"

  echo "[entrypoint] SAN: ${san}"
  openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
    -keyout "${KEY_FILE}" \
    -out   "${CERT_FILE}" \
    -subj  "/CN=Viibestream/O=Viibestream (self-signed)" \
    -addext "subjectAltName=${san}" \
    >/dev/null 2>&1
  chmod 600 "${KEY_FILE}"
  chmod 644 "${CERT_FILE}"
}

if [[ "${TLS_ENABLE:-0}" == "1" ]]; then
  ensure_cert
  echo "[entrypoint] Starting gunicorn (HTTPS) on :8443"
  exec gunicorn \
    --worker-class eventlet -w 1 \
    -b 0.0.0.0:8443 \
    --certfile="${CERT_FILE}" --keyfile="${KEY_FILE}" \
    --access-logfile - --error-logfile - \
    run:app
else
  echo "[entrypoint] Starting gunicorn (HTTP) on :8000"
  exec gunicorn \
    --worker-class eventlet -w 1 \
    -b 0.0.0.0:8000 \
    --access-logfile - --error-logfile - \
    run:app
fi
