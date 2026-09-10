import type { Device, Point, Service } from "./types";
import { sourceMetrics } from "./metrics";

// Reproducible synthetic samples: every band/average is calculated from samples,
// never a decorative envelope. Source capabilities match the UI catalogue.
export function demoHistory(
  device: Device,
  services: Service[],
  params: URLSearchParams,
  mode = "mixed",
): Point[] {
  const source = params.get("source") || "system";
  const key = params.get("metric") || "";
  const definition = sourceMetrics({ ...device, services }, source).find(
    (m) => m.key === key,
  );
  if (!definition || mode === "empty") return [];
  const start = Number(params.get("from_ts"));
  const end = Number(params.get("to_ts"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return [];
  const cadence = source === "smart" ? 60 : 5;
  const bucket = Math.max(cadence, Math.ceil((end - start) / 180));
  const seed = [...`${device.id}/${source}/${key}`].reduce(
    (n, c) => (n * 31 + c.charCodeAt(0)) >>> 0,
    7,
  );
  const random = (ts: number) => {
    const n = Math.sin(Math.floor(ts / cadence) * 12.9898 + seed) * 43758.5453;
    return n - Math.floor(n);
  };
  const sample = (ts: number) => {
    if (mode === "zero") return 0;
    const noise = random(ts);
    const phase = (Math.floor(ts / 150) + (seed % 11)) % 12;
    const busy = phase >= 3 && phase <= 8;
    const utilization = busy ? 58 + noise * 32 : 8 + noise * 12;
    if (key === "requests_waiting")
      return phase === 5 || phase === 6 ? Math.floor(noise * 12) : 0;
    if (key === "requests_running") return busy ? Math.floor(noise * 5) + 1 : 0;
    if (key.endsWith("_total"))
      return Math.floor((mode === "reset" ? ts % 1800 : ts % 864000) * 50);
    if (key === "gen_tokens_per_s" || key === "prompt_tokens_per_s")
      return busy ? 25 + noise * 55 : 0;
    if (key.endsWith("_c")) return 40 + utilization * 0.35;
    if (key.endsWith("_w")) return 35 + utilization * 0.9;
    if (key === "nvme.used_pct") return 2;
    if (
      key === "nvme.media_errors" ||
      key.includes("errors") ||
      key.includes("ecc")
    )
      return 0;
    if (key === "gpu.throttle_active") return 0;
    if (key === "gpu.persistence_mode") return 1;
    if (key.endsWith("_pct"))
      return key.startsWith("memory.")
        ? 48 + utilization * 0.3
        : key.startsWith("disk.")
          ? 35 + noise
          : utilization;
    if (key.endsWith("_kb"))
      return key.includes("total")
        ? 128 * 1048576
        : (40 + utilization / 3) * 1048576;
    if (key.endsWith("_mb")) return (40 + utilization / 3) * 1024;
    if (key.endsWith("_bytes"))
      return (key.includes("total") ? 1024 : 350) * 1073741824;
    if (key.endsWith("_seconds")) return 86400 * 8 + (ts % 86400);
    if (key.endsWith("_mbps"))
      return busy ? noise * (key.startsWith("network.") ? 600 : 80) : noise;
    if (key.endsWith("_iops")) return busy ? noise * 1200 : noise * 20;
    if (key.includes("load_")) return busy ? 3 + noise * 5 : noise;
    if (key.endsWith("_mhz")) return busy ? 1200 + noise * 100 : 300;
    return Math.floor(noise * 20);
  };
  const points: Point[] = [];
  for (let ts = start; ts < end; ts += bucket) {
    const fraction = (ts - start) / (end - start);
    if (mode === "gap" && fraction > 0.3 && fraction < 0.7) continue;
    if (
      (device.stale || mode === "stale") &&
      ts + bucket > end - Math.max(180, (end - start) * 0.15)
    )
      continue;
    if (mode === "single" && points.length) break;
    const duration = Math.min(bucket, end - ts);
    const count =
      mode === "single"
        ? 1
        : Math.max(1, Math.min(24, Math.floor(duration / cadence)));
    const samples = Array.from({ length: count }, (_, i) =>
      sample(ts + (i * duration) / count),
    );
    points.push({
      ts,
      value: samples.reduce((a, b) => a + b, 0) / count,
      min: Math.min(...samples),
      max: Math.max(...samples),
      count,
      bucket_seconds: bucket,
      last_sample_ts: ts + ((count - 1) * duration) / count,
    });
  }
  return points;
}
