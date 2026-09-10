FROM node:22-bookworm-slim AS ui
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev
COPY sparkscope/ sparkscope/
COPY migrations/ migrations/
COPY app.py commands.py ./
COPY frontend/public/ frontend/public/
COPY --from=ui /build/dist/ frontend/dist/
RUN useradd --uid 10001 --create-home sparkscope && mkdir -p /data /var/lib/sparkscope-secrets && chown -R sparkscope:sparkscope /data /var/lib/sparkscope-secrets
USER sparkscope
ENV SPARKSCOPE_DATA_DIR=/data SPARKSCOPE_KEY_FILE=/var/lib/sparkscope-secrets/master.secret
EXPOSE 8010
CMD ["/app/.venv/bin/uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1", "--no-access-log"]
