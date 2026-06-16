#!/usr/bin/env bash
# Docker HEALTHCHECK shim — picks the right URL based on TLS_ENABLE.
set -e
if [[ "${TLS_ENABLE:-0}" == "1" ]]; then
  exec curl -fsSk https://127.0.0.1:8443/healthz
else
  exec curl -fsS  http://127.0.0.1:8000/healthz
fi
