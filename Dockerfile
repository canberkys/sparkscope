# sparkscope — live demo container for Hugging Face Spaces (or any Docker host)
# Serves the dashboard in DEMO_MODE with MockCollector (no real SSH).

FROM python:3.11-slim

WORKDIR /app

# System deps (lean — no SSH/build tools needed for demo mode)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Python deps — install directly (avoid uv lock for HF Spaces simplicity)
RUN pip install --no-cache-dir \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.34.0" \
    "asyncssh>=2.19.0" \
    "aiosqlite>=0.21.0" \
    "pyyaml>=6.0" \
    "websockets>=14.0"

COPY . /app

# HF Spaces binds to 7860 by default
ENV DEMO_MODE=1
ENV PORT=7860
EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
