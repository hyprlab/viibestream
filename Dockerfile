FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini openssl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1000 app \
    && useradd  --system --uid 1000 --gid app --create-home --home-dir /home/app app

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x /app/scripts/entrypoint.sh /app/scripts/healthcheck.sh \
    && mkdir -p /app/instance/certs \
    && chown -R app:app /app

USER app

# Both ports are exposed; the entrypoint picks one based on TLS_ENABLE.
EXPOSE 8000 8443

ENV FLASK_APP=run.py \
    PYTHONPATH=/app

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /app/scripts/healthcheck.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
