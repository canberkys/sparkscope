# Hugging Face Space README template

When you create a new HF Space, **use this as the `README.md`** in your Space repo (NOT the GitHub repo). The YAML frontmatter is required by HF to detect configuration.

Copy everything below the `---DIVIDER---` line into your Space's `README.md`:

---DIVIDER---

---
title: sparkscope — GB10 Cluster Dashboard
emoji: ⚡
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Live demo of sparkscope monitoring dashboard for NVIDIA DGX Spark / Dell GB10 clusters.
---

# sparkscope (Live Demo)

Real-time monitoring dashboard for NVIDIA DGX Spark / Dell Pro Max GB10 clusters.

This Space runs the dashboard in **demo mode** — all metrics are synthetic, no real hardware is connected. Use it to explore the UI, time-range selector, alert timeline, and vLLM integration.

**GitHub (full source + docs):** https://github.com/canberkys/sparkscope

## What you see

- 2 simulated GB10 nodes (Neo + Trinity) polling every 2 seconds
- Live CPU/GPU/memory/disk/network sparklines
- vLLM inference metrics on Neo (token throughput, KV cache, requests)
- Time range selector: Live, 5m, 15m, 1h, 6h, 24h
- Alert timeline with Gantt view
- Click into widgets to expand/collapse

## Install on your own cluster

See [installation instructions on GitHub](https://github.com/canberkys/sparkscope#quick-start).

## License

MIT
