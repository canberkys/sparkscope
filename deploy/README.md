# Deploying the Live Demo

sparkscope ships a **demo mode** that replaces SSH/vLLM polling with synthetic data (`mock_collector.py`). This lets you share a hosted, interactive demo without exposing any real infrastructure.

Two ingredients flip demo mode on:
- **`DEMO_MODE=1`** environment variable, **or**
- **`demo_mode: true`** in `config.yaml` / use `config.demo.yaml`

The bundled `Dockerfile` sets `DEMO_MODE=1` and binds to port `7860` — ready for Hugging Face Spaces, Railway, Render, Fly.io, or any Docker host.

---

## Option A — Hugging Face Spaces (recommended, free, persistent URL)

1. **Create a Space**: go to https://huggingface.co/new-space, choose **Docker** as the SDK, public, free CPU tier.
2. **Clone the space repo** locally (HF gives you a git URL):
   ```bash
   git clone https://huggingface.co/spaces/<your-username>/<space-name>
   cd <space-name>
   ```
3. **Copy sparkscope** into it (or add sparkscope as a git remote and merge). Minimum files needed:
   ```
   app.py  commands.py  db.py  ssh_collector.py  vllm_collector.py
   mock_collector.py  config.demo.yaml  Dockerfile
   static/
   ```
4. **Add HF metadata** to `README.md` (required by Spaces — see `huggingface_readme.md` in this folder).
5. **Push**:
   ```bash
   git add . && git commit -m "Deploy sparkscope demo"
   git push
   ```
6. HF builds the container and publishes at `https://huggingface.co/spaces/<you>/<name>`.

> HF Spaces free tier sleeps after 48h of inactivity but wakes on next request (10-30s cold start).

---

## Option B — Railway (one-click from GitHub)

1. Go to https://railway.app/new and connect your GitHub account.
2. **Deploy from GitHub repo** → pick `canberkys/sparkscope`.
3. Railway auto-detects the `Dockerfile`. Add an env var:
   ```
   DEMO_MODE=1
   ```
4. Deploy. Railway gives a public URL like `sparkscope.up.railway.app`.

> Free tier: 500 hours/month, sleeps after inactivity.

---

## Option C — Render

1. https://dashboard.render.com/ → New → Web Service → connect repo.
2. Render picks up the Dockerfile automatically.
3. Env vars:
   ```
   DEMO_MODE=1
   PORT=7860
   ```
4. Deploy. Public URL like `sparkscope.onrender.com`.

> Free tier: 512MB RAM, sleeps after 15 minutes of inactivity, ~30s cold start.

---

## Option D — Local Docker (anywhere)

```bash
docker build -t sparkscope .
docker run -p 8000:7860 sparkscope
# open http://localhost:8000
```

---

## What the demo shows

- **2 simulated GB10 hosts** — Neo (Upper) + Trinity (Lower)
- **Sinusoidal CPU/GPU load patterns** with occasional inference bursts
- **Live vLLM metrics on Neo** — token throughput, active requests, KV cache
- **Realistic thermals** correlated with load
- **Full UI functionality** — time range selector, alert timeline, historical charts
- Commands execute against mock collector (no real effects)
- **No SSH, no network access to third-party hosts needed**

---

## After deploying

Add a "Live Demo" badge to the main README:

```markdown
[![Live Demo](https://img.shields.io/badge/🤗%20Live%20Demo-sparkscope-yellow)](https://huggingface.co/spaces/YOUR-USER/sparkscope)
```
