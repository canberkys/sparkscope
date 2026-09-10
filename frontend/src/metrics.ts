import type { Device, Service } from "./types";

export type MetricDefinition = {
  key: string;
  label: string;
  unit: string;
  digits: number;
  percent?: boolean;
  scale?: number;
};
const define = (
  key: string,
  label: string,
  unit: string,
  digits = 1,
): MetricDefinition => ({ key, label, unit, digits, percent: unit === "%" });

export const systemMetrics: MetricDefinition[] = [
  define("gpu.util_pct", "GPU utilization", "%"),
  define("cpu.usage_pct", "CPU utilization", "%"),
  define("memory.used_pct", "Memory used", "%"),
  define("gpu.temp_c", "GPU temperature", "°C"),
  define("cpu.temp_max_c", "CPU temperature", "°C"),
  define("gpu.power_draw_w", "GPU power", "W"),
  define("disk.root_used_pct", "Root disk used", "%"),
  define("cpu.load_1m", "Load average · 1 minute", "", 2),
  define("cpu.load_5m", "Load average · 5 minutes", "", 2),
  define("cpu.load_15m", "Load average · 15 minutes", "", 2),
  define("disk.read_mbps", "Disk read throughput", "MB/s"),
  define("disk.write_mbps", "Disk write throughput", "MB/s"),
  define("disk.read_iops", "Disk read operations", "IOPS"),
  define("disk.write_iops", "Disk write operations", "IOPS"),
];
export const smartMetrics = [
  define("nvme.temp_c", "NVMe temperature", "°C"),
  { ...define("nvme.used_pct", "NVMe endurance used", "%"), percent: false },
  define("nvme.media_errors", "NVMe media errors", "errors", 0),
];
export const runtimeMetrics = [
  define("gen_tokens_per_s", "Generation throughput", "tok/s"),
  define("prompt_tokens_per_s", "Prompt throughput", "tok/s"),
  define("requests_running", "Running requests", "requests"),
  define("requests_waiting", "Waiting requests", "requests"),
  define("kv_cache_pct", "KV cache used", "%"),
  define("prefix_cache_hit_pct", "Prefix cache hit rate", "%"),
  define("generation_tokens_total", "Generated tokens · counter", "tokens", 0),
  define("prompt_tokens_total", "Prompt tokens · counter", "tokens", 0),
];

export function metricDefinition(key: string): MetricDefinition {
  const found = [...systemMetrics, ...smartMetrics, ...runtimeMetrics].find(
    (m) => m.key === key,
  );
  if (found) return found;
  const words = key.replaceAll("_", " ").replaceAll(".", " · ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  if (key.endsWith("_kb"))
    return {
      ...define(key, label.replace(/ kb$/, ""), "GiB", 2),
      scale: 1 / 1048576,
    };
  if (key.endsWith("_mb")) return define(key, label.replace(/ mb$/, ""), "MiB");
  if (key.endsWith("_bytes"))
    return {
      ...define(key, label.replace(/ bytes$/, ""), "GiB", 2),
      scale: 1 / 1073741824,
    };
  if (key.endsWith("_pct")) return define(key, label.replace(/ pct$/, ""), "%");
  if (key.endsWith("_c")) return define(key, label.replace(/ c$/, ""), "°C");
  if (key.endsWith("_w")) return define(key, label.replace(/ w$/, ""), "W");
  if (key.endsWith("_mhz"))
    return define(key, label.replace(/ mhz$/, ""), "MHz", 0);
  if (key.endsWith("_mbps"))
    return define(
      key,
      label.replace(/ mbps$/, ""),
      key.startsWith("network.") ? "Mbit/s" : "MB/s",
    );
  if (key.endsWith("_iops"))
    return define(key, label.replace(/ iops$/, ""), "IOPS");
  if (key.endsWith("_seconds"))
    return {
      ...define(key, label.replace(/ seconds$/, ""), "hours", 1),
      scale: 1 / 3600,
    };
  if (key.endsWith("_rx_errors") || key.endsWith("_tx_errors"))
    return define(key, label, "errors/s");
  return define(key, label, "", 0);
}

export function serviceMetrics(service: Service): MetricDefinition[] {
  if (service.provider === "ollama") return [];
  const names = new Set(
    service.supported_metrics ?? Object.keys(service.metrics || {}),
  );
  if (names.has("generation_tokens_total")) names.add("gen_tokens_per_s");
  if (names.has("prompt_tokens_total")) names.add("prompt_tokens_per_s");
  return runtimeMetrics.filter((m) => names.has(m.key));
}

export function sourceMetrics(
  device: Device,
  source: string,
): MetricDefinition[] {
  if (source !== "system" && source !== "smart") {
    const service = device.services?.find((s) => s.id === source);
    return service ? serviceMetrics(service) : [];
  }
  const base = source === "system" ? systemMetrics : smartMetrics;
  const keys = new Set(
    base
      .filter(
        (m) =>
          !m.key.startsWith("gpu.") ||
          (device.info?.capabilities?.gpu !== false &&
            (device.info?.gpu_count || 0) <= 1 &&
            !device.info?.gpus?.length),
      )
      .map((m) => m.key),
  );
  if (source === "system") {
    for (const gpu of device.info?.gpus || []) {
      for (const suffix of [
        "util_pct",
        "temp_c",
        "power_draw_w",
        "mem_used_mb",
        "mem_total_mb",
      ])
        keys.add(`gpu.${gpu.id}.${suffix}`);
    }
  }
  // Include additional GPU, per-interface and per-disk measurements without raw-key labels.
  Object.keys(device.metrics)
    .filter((k) =>
      source === "smart" ? k.startsWith("nvme.") : !k.startsWith("nvme."),
    )
    .forEach((k) => keys.add(k));
  return [...keys].map((key) => {
    const m = metricDefinition(key);
    const match = key.match(/^gpu\.([^.]+)\.(.+)$/);
    if (!match) return m;
    const gpu = device.info?.gpus?.find((g) => g.id === match[1]);
    const base = metricDefinition("gpu." + match[2]);
    return {
      ...m,
      label: gpu
        ? `${gpu.name} · GPU ${gpu.index}${gpu.present === false ? " · Not currently present" : ""} · ${base.label.replace(/^GPU /, "")}`
        : `Legacy GPU data · ${match[1]} · ${base.label.replace(/^GPU /, "")}`,
    };
  });
}
