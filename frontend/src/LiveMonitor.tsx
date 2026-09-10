import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Monitor,
  Plus,
  Palette,
  Network,
  ExternalLink,
  X,
} from "lucide-react";
import { api, DEMO } from "./api";
import { SavedViews, CompareFleet, takePendingView } from "./FleetViews";
import type { ViewConfig } from "./FleetViews";
import type { Device, Metrics, Point, Service } from "./types";
import {
  useFleet,
  value,
  age,
  Badge,
  Empty,
  Modal,
  ErrorBox,
  useQuery,
} from "./ui";
import { HistoryChart } from "./HistoryChart";
import Onboarding from "./Onboarding";
import "./live-monitor.css";

type Reading = { ts: number; values: Metrics };
type MonitorMetric = {
  key: string;
  label: string;
  unit: string;
  color: string;
  percent?: boolean;
  read: (m: Metrics) => number | null | undefined;
};
const sumInterfaces = (metrics: Metrics, suffix: string) => {
  const readings = Object.entries(metrics)
    .filter(
      ([key, v]) =>
        key.startsWith("network.") && key.endsWith(suffix) && v != null,
    )
    .map(([, v]) => v!);
  return readings.length ? readings.reduce((a, b) => a + b, 0) : null;
};
const charts: MonitorMetric[] = [
  {
    key: "cpu",
    label: "CPU",
    unit: "%",
    color: "#22d3ee",
    percent: true,
    read: (m) => m["cpu.usage_pct"],
  },
  {
    key: "gpu",
    label: "GPU",
    unit: "%",
    color: "#a78bfa",
    percent: true,
    read: (m) => m["gpu.util_pct"],
  },
  {
    key: "memory",
    label: "System memory used",
    unit: "%",
    color: "#34d399",
    percent: true,
    read: (m) => m["memory.used_pct"],
  },
  {
    key: "temperature",
    label: "GPU temperature",
    unit: "°C",
    color: "#fb923c",
    read: (m) => m["gpu.temp_c"],
  },
  {
    key: "disk-read",
    label: "Disk read",
    unit: "MB/s",
    color: "#fbbf24",
    read: (m) => m["disk.read_mbps"],
  },
  {
    key: "disk-write",
    label: "Disk write",
    unit: "MB/s",
    color: "#f472b6",
    read: (m) => m["disk.write_mbps"],
  },
  {
    key: "network-rx",
    label: "Network receive · all interfaces",
    unit: "Mbit/s",
    color: "#60a5fa",
    read: (m) => sumInterfaces(m, "_rx_mbps"),
  },
  {
    key: "network-tx",
    label: "Network send · all interfaces",
    unit: "Mbit/s",
    color: "#c4b5fd",
    read: (m) => sumInterfaces(m, "_tx_mbps"),
  },
];
// Never substitute system RAM for dedicated GPU memory or invent GPU samples.
function deviceCharts(d: Device): MonitorMetric[] {
  const indices = [
    ...new Set(
      Object.keys(d.metrics).flatMap((k) => {
        const match = k.match(/^gpu\.([^.]+)\./);
        return match ? [match[1]] : [];
      }),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const multi = indices.length > 0;
  const available = charts.filter((m) => {
    if (m.key !== "gpu" && m.key !== "temperature") return true;
    return !multi && d.info?.capabilities?.gpu !== false;
  });
  if (multi)
    for (const index of indices) {
      for (const [base, suffix] of [
        [charts[1], "util_pct"],
        [charts[3], "temp_c"],
      ] as const) {
        available.push({
          ...base,
          key: `${base.key}-${index}`,
          label: `GPU ${d.info?.gpus?.find((g) => g.id === index)?.index ?? index} ${suffix === "util_pct" ? "utilization" : "temperature"}`,
          read: (m) => m[`gpu.${index}.${suffix}`],
        });
      }
    }
  return available;
}
function heroCharts(d: Device): MonitorMetric[] {
  if (
    d.info?.capabilities?.gpu === false ||
    (d.info?.gpu_count || 0) > 1 ||
    Object.keys(d.metrics).some((k) => k.startsWith("gpu.1."))
  )
    return [
      charts[0],
      charts[2],
      {
        ...charts[3],
        label: "CPU temperature",
        read: (m) => m["cpu.temp_max_c"],
      },
      {
        ...charts[4],
        label: "Root disk used",
        unit: "%",
        read: (m) => m["disk.root_used_pct"],
      },
    ];
  const gpu = d.info?.gpus?.find((g) => g.present !== false);
  return charts.slice(0, 4).map((m) =>
    gpu && (m.key === "gpu" || m.key === "temperature")
      ? {
          ...m,
          read: (values: Metrics) =>
            values[`gpu.${gpu.id}.${m.key === "gpu" ? "util_pct" : "temp_c"}`],
        }
      : m,
  );
}
const fresh = (d: Device, now: number) =>
  !d.paused &&
  !d.stale &&
  d.status !== "offline" &&
  d.last_seen != null &&
  now - d.last_seen <= 20;
const paletteKey = "sparkscope.chart-colors.v1";
function storedColors(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(paletteKey) || "{}");
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([key, v]) =>
          charts.some((c) => c.key === key) &&
          typeof v === "string" &&
          /^#[0-9a-f]{6}$/i.test(v),
      ) as [string, string][],
    );
  } catch {
    return {};
  }
}
function MiniChart({
  metric,
  readings,
  now,
  color,
  short = false,
  windowSeconds = 300,
}: {
  metric: MonitorMetric;
  readings: Reading[];
  now: number;
  color: string;
  short?: boolean;
  windowSeconds?: number;
}) {
  const points: Point[] = readings
    .filter((r) => r.ts >= now - windowSeconds)
    .flatMap((r) => {
      const n = metric.read(r.values);
      return n == null || !Number.isFinite(n)
        ? []
        : [
            {
              ts: r.ts,
              value: n,
              min: n,
              max: n,
              count: 1,
              bucket_seconds: 5,
              last_sample_ts: r.ts,
            },
          ];
    });
  return (
    <div className="monitor-mini">
      {points.length ? (
        <HistoryChart
          points={points}
          start={Math.max(
            now - windowSeconds,
            Math.min(points[0].ts, now - 15),
          )}
          end={now}
          label={metric.label}
          unit={metric.unit}
          percent={metric.percent}
          compact
          compactHeight={short ? 110 : 140}
          color={color}
        />
      ) : (
        <div className="monitor-mini-empty">
          <strong style={{ color }}>{metric.label}</strong>
          <span>No samples yet</span>
          <small>{metric.unit} · unavailable values stay empty</small>
        </div>
      )}
    </div>
  );
}
function ExpandedDetails({
  id,
  services,
}: {
  id: string;
  services: Service[];
}) {
  const { data: d, error } = useQuery<Device>("/devices/" + id, 5000);
  return (
    <div className="monitor-extra">
      <ErrorBox message={error} />
      {d ? (
        <>
          <dl className="monitor-hardware">
            <div>
              <dt>Host / OS / GPU</dt>
              <dd>
                {d.info?.hostname || "N/A"}
                <small>{d.info?.os || "OS unavailable"}</small>
                <small>{d.info?.gpu || "GPU telemetry unavailable"}</small>
              </dd>
            </div>
            <div>
              <dt>System memory</dt>
              <dd>
                {value(
                  d.metrics["memory.total_kb"] == null
                    ? null
                    : d.metrics["memory.total_kb"]! / 1048576,
                  " GiB",
                )}
                <small>
                  {value(
                    d.metrics["memory.available_kb"] == null
                      ? null
                      : d.metrics["memory.available_kb"]! / 1048576,
                    " GiB",
                    1,
                  )}{" "}
                  available
                </small>
              </dd>
            </div>
            {Object.entries(d.metrics)
              .filter(
                ([k, v]) =>
                  /^gpu(?:\.[^.]+)?\.mem_total_mb$/.test(k) &&
                  v != null &&
                  (!k.startsWith("gpu.mem") ||
                    !Object.keys(d.metrics).some((key) =>
                      /^gpu\.[^.]+\.mem_total_mb$/.test(key),
                    )),
              )
              .map(([key, total]) => (
                <div key={key}>
                  <dt>
                    {key.split(".").length === 3
                      ? `GPU ${d.info?.gpus?.find((g) => g.id === key.split(".")[1])?.index ?? key.split(".")[1]}`
                      : "GPU"}{" "}
                    reported memory
                  </dt>
                  <dd>
                    {value(total, " MiB")}
                    <small>
                      {value(
                        d.metrics[key.replace("mem_total_mb", "mem_used_mb")],
                        " MiB",
                      )}{" "}
                      used ·{" "}
                      {d.info?.memory_model === "unified"
                        ? "shared with system RAM"
                        : "separate from system RAM"}
                    </small>
                  </dd>
                </div>
              ))}
            <div>
              <dt>Root disk / SMART</dt>
              <dd>
                {value(d.metrics["disk.root_used_pct"], "% used")}
                <small>
                  {value(d.metrics["nvme.temp_c"], "°C")} ·{" "}
                  {d.smart?.ts ? age(d.smart.ts) : "SMART not available"}
                </small>
              </dd>
            </div>
            <div>
              <dt>GPU power / uptime</dt>
              <dd>
                {value(d.metrics["gpu.power_draw_w"], " W")}
                <small>
                  {value(
                    d.metrics["system.uptime_seconds"] == null
                      ? null
                      : d.metrics["system.uptime_seconds"]! / 3600,
                    " hours",
                    1,
                  )}{" "}
                  uptime
                </small>
              </dd>
            </div>
          </dl>
          {d.smart?.error && (
            <p className="monitor-inline-warning">SMART: {d.smart.error}</p>
          )}
          <div className="monitor-service-list">
            <h4>Models & services</h4>
            {services.length ? (
              services.map((s) => (
                <div key={s.id}>
                  <strong>
                    {s.provider} :{s.port}
                  </strong>
                  <span>
                    {s.models
                      ?.map((m) => `${m.name} (${m.state})`)
                      .join(", ") || "No model metadata"}
                  </span>
                  <small>
                    {s.status} · {age(s.last_seen)}
                    {s.provider !== "ollama"
                      ? ` · ${value(s.metrics?.gen_tokens_per_s, " tok/s", 1)}`
                      : " · metadata only"}
                  </small>
                </div>
              ))
            ) : (
              <p>No services discovered.</p>
            )}
          </div>
          <div className="monitor-processes">
            <h4>Top processes</h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Process</th>
                    <th>CPU</th>
                    <th>Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {d.top_procs?.slice(0, 5).map((p) => (
                    <tr key={p.pid}>
                      <td>
                        {p.command}
                        <small>
                          PID {p.pid} · {p.user}
                        </small>
                      </td>
                      <td>{value(p.cpu_pct, "%", 1)}</td>
                      <td>{value(p.mem_pct, "%", 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!d.top_procs?.length && <p>Process data unavailable.</p>}
          </div>
        </>
      ) : (
        !error && <p role="status">Loading hardware details…</p>
      )}
    </div>
  );
}

export default function LiveMonitor() {
  const { devices, services, alerts, user, connected, navigate } = useFleet();
  const [now, setNow] = useState(Date.now() / 1000);
  const [history, setHistory] = useState<Record<string, Reading[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initialized = useRef(false);
  const [search, setSearch] = useState("");
  const [cluster, setCluster] = useState("");
  const [group, setGroup] = useState("");
  const [view, setView] = useState("devices");
  const [page, setPage] = useState(0);
  const [tv, setTv] = useState(
    new URLSearchParams(location.search).get("mode") === "tv",
  );
  const [rotate, setRotate] = useState(true);
  const [rotationSeconds, setRotationSeconds] = useState(20);
  const [tvPageSize, setTvPageSize] = useState(6);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [metricKeys, setMetricKeys] = useState<string[]>([]);
  const [summaryWidgets, setSummaryWidgets] = useState([
    "reporting",
    "incidents",
    "power",
    "clusters",
  ]);
  const [liveWindow, setLiveWindow] = useState(300);
  const [saved, setSaved] = useState(false);
  const [compare, setCompare] = useState(false);
  const [viewError, setViewError] = useState("");
  const [add, setAdd] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [colors, setColors] = useState(storedColors);
  const applyView = (c: ViewConfig) => {
    setSearch(c.search || "");
    setGroup(c.group || "");
    setCluster(c.cluster || "");
    setView(c.view === "clusters" ? "clusters" : "devices");
    setTv(Boolean(c.tv));
    setTvPageSize(c.page_size === 4 ? 4 : 6);
    setRotationSeconds(
      [10, 20, 30, 60].includes(c.rotation_seconds) ? c.rotation_seconds : 20,
    );
    setRotate(c.rotation_seconds !== 0);
    setDeviceIds(c.device_ids || []);
    setMetricKeys(c.metric_keys || []);
    setColors(c.colors || {});
    setSummaryWidgets(
      c.summary_widgets ?? ["reporting", "incidents", "power", "clusters"],
    );
    setLiveWindow(
      [60, 180, 300].includes(c.live_window_seconds || 0)
        ? c.live_window_seconds!
        : 300,
    );
  };
  const viewConfig: ViewConfig = {
    search,
    group,
    cluster,
    view,
    tv,
    page_size: tvPageSize,
    rotation_seconds: rotate ? rotationSeconds : 0,
    device_ids: deviceIds,
    metric_keys: metricKeys,
    colors,
    summary_widgets: summaryWidgets,
    live_window_seconds: liveWindow,
  };
  useEffect(() => {
    const pending = takePendingView();
    if (pending) {
      applyView(pending);
      return;
    }
    const id = new URLSearchParams(location.search).get("view");
    if (!id) return;
    let alive = true;
    void api<{ id: string; config: ViewConfig }[]>("/views")
      .then((rows) => {
        if (alive) {
          const row = rows.find((v) => v.id === id);
          if (row) applyView(row.config);
          else setViewError("Saved view is unavailable or no longer shared.");
        }
      })
      .catch((e) => {
        if (alive) setViewError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);
  const selectedCharts = (d: Device) =>
    deviceCharts(d).filter(
      (m) =>
        !metricKeys.length ||
        metricKeys.includes(m.key) ||
        metricKeys.includes(m.key.split("-")[0]),
    );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const time = Date.now() / 1000;
    setHistory((previous) => {
      const next: Record<string, Reading[]> = {};
      for (const d of devices) {
        const samples = (previous[d.id] || []).filter(
          (r) => r.ts >= time - 300,
        );
        if (
          fresh(d, time) &&
          (!samples.length || d.last_seen! > samples.at(-1)!.ts)
        )
          samples.push({ ts: d.last_seen!, values: { ...d.metrics } });
        next[d.id] = samples.slice(-180);
      }
      return next;
    });
    if (devices.length && !initialized.current) {
      if (devices.length <= 2) setExpanded(new Set(devices.map((d) => d.id)));
      initialized.current = true;
    }
  }, [devices]);
  useEffect(() => {
    try {
      localStorage.setItem(paletteKey, JSON.stringify(colors));
    } catch {
      /* Browser privacy settings may disable persistence. */
    }
  }, [colors]);
  useEffect(() => {
    document.body.classList.toggle("monitor-tv", tv);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTv(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.classList.remove("monitor-tv");
      window.removeEventListener("keydown", escape);
    };
  }, [tv]);
  useEffect(() => setPage(0), [search, cluster, group, view, tv]);
  const active = alerts.filter((a) => !a.resolved_at);
  const severity = (d: Device) =>
    active.some((a) => a.device_id === d.id && a.severity === "critical")
      ? "critical"
      : active.some((a) => a.device_id === d.id)
        ? "warning"
        : !fresh(d, now)
          ? d.paused
            ? "paused"
            : "offline"
          : "online";
  const filtered = devices.filter(
    (d) =>
      (!search ||
        `${d.name} ${d.address} ${d.tags.join(" ")} ${d.info?.hostname || ""} ${d.info?.gpu || ""} ${d.info?.gpus?.map((g) => g.name).join(" ") || ""}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!cluster ||
        (cluster === "__standalone"
          ? !d.cluster_name
          : d.cluster_name === cluster)) &&
      (!group || d.group === group) &&
      (!deviceIds.length || deviceIds.includes(d.id)),
  );
  const pageSize = tv ? tvPageSize : 12;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  useEffect(() => {
    if (!tv || !rotate || pages <= 1) return;
    const timer = setInterval(
      () => setPage((p) => (p + 1) % pages),
      rotationSeconds * 1000,
    );
    return () => clearInterval(timer);
  }, [tv, rotate, pages, rotationSeconds]);
  const clusters = [
    ...new Set(
      devices
        .map((d) => d.cluster_name)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const reporting = devices.filter((d) => fresh(d, now));
  const power = reporting
    .flatMap((d) => {
      const indexed = Object.entries(d.metrics)
        .filter(([k, v]) => /^gpu\.[^.]+\.power_draw_w$/.test(k) && v != null)
        .map(([, v]) => v);
      return indexed.length ? indexed : [d.metrics["gpu.power_draw_w"]];
    })
    .filter((n): n is number => n != null);
  const blocks =
    view === "clusters"
      ? [...new Set(visible.map((d) => d.cluster_name || ""))].map((name) => ({
          name,
          devices: visible.filter((d) => (d.cluster_name || "") === name),
        }))
      : [{ name: null, devices: visible }];
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className={`live-monitor ${tv && tvPageSize === 4 ? "tv-four" : ""}`}>
      <ErrorBox message={viewError} />
      <div className="monitor-title-row">
        <div>
          <div className="eyebrow">LIVE FLEET MONITOR</div>
          <h1>{tv ? "SparkScope · Live TV" : "Overview"}</h1>
          <p>
            {DEMO
              ? "Synthetic telemetry · no real devices connected."
              : "Live device telemetry. Expand a device to inspect its hardware."}
          </p>
        </div>
        <div className="monitor-actions">
          <span
            className={`monitor-live-status ${connected && reporting.length ? "on" : ""}`}
          >
            <i />
            {!connected
              ? "Reconnecting"
              : reporting.length
                ? "LIVE"
                : "Waiting for samples"}
            <time>{new Date(now * 1000).toLocaleTimeString("en-GB")}</time>
          </span>
          {!tv && (
            <button onClick={() => setCustomize(true)}>
              <Palette size={15} />
              Chart colors
            </button>
          )}
          <button onClick={() => setTv((v) => !v)}>
            <Monitor size={16} />
            {tv ? "Exit TV" : "TV mode"}
          </button>
          {!tv && (
            <>
              <button onClick={() => setSaved(true)}>Saved views</button>
              <button onClick={() => setCompare(true)}>Compare</button>
            </>
          )}
          {!tv && user.role === "admin" && (
            <button className="primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              Add device
            </button>
          )}
        </div>
      </div>
      <div
        className="monitor-summary"
        style={
          {
            display: summaryWidgets.length ? undefined : "none",
            "--summary-columns":
              summaryWidgets.length === 4
                ? "1.5fr 1fr 1fr 1fr"
                : `repeat(${Math.max(1, summaryWidgets.length)}, minmax(0, 1fr))`,
          } as CSSProperties
        }
      >
        {summaryWidgets.includes("reporting") && (
          <div className="monitor-fleet-health">
            <Activity size={28} />
            <strong>
              {reporting.length}
              <span> / {devices.length}</span>
            </strong>
            <span>
              devices reporting<small>Fresh within 20 seconds</small>
            </span>
          </div>
        )}
        {summaryWidgets.includes("incidents") && (
          <button onClick={() => navigate("alerts")}>
            <strong
              className={
                active.some((a) => a.severity === "critical") ? "red" : ""
              }
            >
              {active.length}
            </strong>
            <span>active incidents</span>
          </button>
        )}
        {summaryWidgets.includes("power") && (
          <div>
            <strong>
              {value(
                power.length ? power.reduce((a, b) => a + b, 0) : null,
                " W",
              )}
            </strong>
            <span>GPU power · {power.length} GPU readings</span>
          </div>
        )}
        {summaryWidgets.includes("clusters") && (
          <button onClick={() => setView("clusters")}>
            <strong>{clusters.length}</strong>
            <span>configured clusters</span>
          </button>
        )}
      </div>
      <div className="monitor-toolbar">
        <div className="segmented">
          <button
            className={view === "devices" ? "selected" : ""}
            onClick={() => setView("devices")}
          >
            Device view
          </button>
          <button
            className={view === "clusters" ? "selected" : ""}
            onClick={() => setView("clusters")}
          >
            <Network size={14} />
            Cluster view
          </button>
        </div>
        <input
          type="search"
          aria-label="Search monitored devices"
          placeholder="Search name, IP, tag or GPU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Monitor group"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">All groups</option>
          {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select
          aria-label="Monitor cluster"
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
        >
          <option value="">All clusters & standalone</option>
          {clusters.map((c) => (
            <option key={c}>{c}</option>
          ))}
          <option value="__standalone">Standalone devices</option>
        </select>
        {DEMO && !tv && (
          <select
            aria-label="Demo device count"
            value={devices.length}
            onChange={(e) => {
              const u = new URL(location.href);
              u.searchParams.set("hosts", e.target.value);
              u.searchParams.delete("scenario");
              location.href = u.toString();
            }}
          >
            {[...new Set([devices.length, 2, 10, 50])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option value={n} key={n}>
                  {n} demo devices
                </option>
              ))}
          </select>
        )}
        {tv ? (
          <label className="monitor-rotate">
            <input
              type="checkbox"
              checked={rotate}
              onChange={(e) => setRotate(e.target.checked)}
            />
            Rotate pages every {rotationSeconds}s
          </label>
        ) : (
          <span className="monitor-window">
            Live charts · up to {liveWindow / 60} minute
            {liveWindow > 60 ? "s" : ""} in this browser
          </span>
        )}
      </div>
      {view === "clusters" && (
        <p className="monitor-cluster-note">
          Configured membership only. Member telemetry does not verify cluster
          links, distributed inference or combined memory.
        </p>
      )}
      {!devices.length ? (
        <Empty
          title="A clear view of every device"
          text="Connect your first device to start live monitoring."
          action={
            user.role === "admin" ? (
              <button className="primary" onClick={() => setAdd(true)}>
                Add your first device
              </button>
            ) : undefined
          }
        />
      ) : !filtered.length ? (
        <Empty
          title="No matching devices"
          text="Adjust your search, group or cluster filter."
        />
      ) : (
        blocks.map((block) => (
          <section key={block.name ?? "all"} className="monitor-block">
            {block.name !== null && (
              <div className="monitor-cluster-heading">
                <Network size={19} />
                <h2>{block.name || "Standalone devices"}</h2>
                <span>
                  {
                    filtered
                      .filter((d) => (d.cluster_name || "") === block.name)
                      .filter((d) => fresh(d, now)).length
                  }{" "}
                  /{" "}
                  {
                    filtered.filter(
                      (d) => (d.cluster_name || "") === block.name,
                    ).length
                  }{" "}
                  reporting{pages > 1 ? " · visible page below" : ""}
                </span>
                <span>
                  {
                    services.filter((s) =>
                      filtered.some(
                        (d) =>
                          d.id === s.device_id &&
                          (d.cluster_name || "") === block.name,
                      ),
                    ).length
                  }{" "}
                  services (
                  {
                    services.filter(
                      (s) =>
                        s.status === "online" &&
                        filtered.some(
                          (d) =>
                            d.id === s.device_id &&
                            (d.cluster_name || "") === block.name &&
                            fresh(d, now),
                        ),
                    ).length
                  }{" "}
                  online) ·{" "}
                  {
                    active.filter((a) =>
                      filtered.some(
                        (d) =>
                          d.id === a.device_id &&
                          (d.cluster_name || "") === block.name,
                      ),
                    ).length
                  }{" "}
                  incidents ·{" "}
                  {filtered
                    .filter((d) => (d.cluster_name || "") === block.name)
                    .reduce(
                      (n, d) =>
                        n + (d.info?.gpus?.length || d.info?.gpu_count || 0),
                      0,
                    )}{" "}
                  GPUs
                </span>
                <span>
                  {Object.entries(
                    filtered
                      .filter((d) => (d.cluster_name || "") === block.name)
                      .flatMap((d) =>
                        d.info?.gpus?.length
                          ? d.info.gpus
                              .filter((g) => g.present !== false)
                              .map((g) => g.name)
                          : d.info?.gpu
                            ? [d.info.gpu]
                            : [],
                      )
                      .reduce<Record<string, number>>(
                        (counts, name) => ({
                          ...counts,
                          [name]: (counts[name] || 0) + 1,
                        }),
                        {},
                      ),
                  )
                    .map(([name, count]) => `${count} × ${name}`)
                    .join(" · ") || "No GPU inventory"}
                </span>
              </div>
            )}
            <div className="monitor-grid">
              {block.devices.map((d) => {
                const isExpanded = expanded.has(d.id) && !tv;
                const live = fresh(d, now);
                const deviceServices = services.filter(
                  (s) => s.device_id === d.id,
                );
                const incident = active
                  .filter((a) => a.device_id === d.id)
                  .sort(
                    (a, b) =>
                      (a.severity === "critical" ? 0 : 1) -
                      (b.severity === "critical" ? 0 : 1),
                  )[0];
                return (
                  <article
                    className={`monitor-device ${severity(d)} ${!live ? "stale" : ""}`}
                    key={d.id}
                  >
                    <div className="monitor-device-header">
                      <img src={DEMO ? "./device.svg" : "/device.svg"} alt="" />
                      <div>
                        <h3>{d.name}</h3>
                        <span className="mono">
                          {d.address}:{d.port}
                        </span>
                      </div>
                      <Badge status={severity(d)} />
                      <button
                        className="icon-button"
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${d.name}`}
                        aria-expanded={isExpanded}
                        aria-controls={`monitor-${d.id}`}
                        onClick={() => toggle(d.id)}
                        disabled={tv}
                      >
                        {isExpanded ? (
                          <ChevronDown size={18} />
                        ) : (
                          <ChevronRight size={18} />
                        )}
                      </button>
                    </div>
                    <div className="monitor-device-meta">
                      <span>
                        {d.group}
                        {d.cluster_name
                          ? ` · ${d.cluster_name}`
                          : " · Standalone"}
                      </span>
                      <span>
                        {live ? "Updated" : "Last sample"} {age(d.last_seen)}
                      </span>
                    </div>
                    <div className="monitor-status-slot">
                      {incident ? (
                        <button
                          className={`monitor-incident ${incident.severity}`}
                          title={incident.message}
                          onClick={() => navigate("devices/" + d.id)}
                        >
                          <span>{incident.message}</span>
                        </button>
                      ) : (
                        <div className="monitor-incident quiet">
                          <span>No active incidents</span>
                        </div>
                      )}
                      <p
                        className={`monitor-sample-state ${live ? "" : "old"}`}
                      >
                        {live
                          ? "Live samples"
                          : d.paused
                            ? "Monitoring paused · last recorded values"
                            : "No fresh telemetry · last recorded values"}
                      </p>
                    </div>
                    <div className="monitor-hero-metrics">
                      {heroCharts(d).map((m) => (
                        <div key={m.key}>
                          <span
                            style={{
                              color:
                                colors[m.key] ||
                                colors[
                                  m.key.startsWith("gpu-")
                                    ? "gpu"
                                    : m.key.startsWith("temperature-")
                                      ? "temperature"
                                      : m.key
                                ] ||
                                m.color,
                            }}
                          >
                            {m.key === "memory" ? "Memory used" : m.label}
                          </span>
                          <strong>{value(m.read(d.metrics), m.unit, 1)}</strong>
                        </div>
                      ))}
                    </div>
                    {tv && (
                      <div className="monitor-tv-charts">
                        {(metricKeys.length ? selectedCharts(d) : heroCharts(d))
                          .slice(0, 2)
                          .map((m) => (
                            <MiniChart
                              key={m.key}
                              short
                              metric={m}
                              readings={history[d.id] || []}
                              now={now}
                              windowSeconds={liveWindow}
                              color={
                                colors[m.key] ||
                                colors[
                                  m.key.startsWith("gpu-")
                                    ? "gpu"
                                    : m.key.startsWith("temperature-")
                                      ? "temperature"
                                      : m.key
                                ] ||
                                m.color
                              }
                            />
                          ))}
                      </div>
                    )}
                    {isExpanded && (
                      <div className="monitor-expanded" id={`monitor-${d.id}`}>
                        <div className="monitor-chart-grid">
                          {selectedCharts(d).map((m) => (
                            <MiniChart
                              key={m.key}
                              metric={m}
                              readings={history[d.id] || []}
                              now={now}
                              windowSeconds={liveWindow}
                              color={
                                colors[m.key] ||
                                colors[
                                  m.key.startsWith("gpu-")
                                    ? "gpu"
                                    : m.key.startsWith("temperature-")
                                      ? "temperature"
                                      : m.key
                                ] ||
                                m.color
                              }
                            />
                          ))}
                        </div>
                        <ExpandedDetails id={d.id} services={deviceServices} />
                      </div>
                    )}
                    <div className="monitor-card-footer">
                      <span>
                        {deviceServices.length} service
                        {deviceServices.length === 1 ? "" : "s"} ·{" "}
                        {deviceServices.flatMap((s) => s.models || []).length}{" "}
                        {deviceServices.flatMap((s) => s.models || [])
                          .length === 1
                          ? "model"
                          : "models"}
                      </span>
                      <button onClick={() => navigate("devices/" + d.id)}>
                        History & details
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      )}
      {filtered.length > 0 && (
        <div className="monitor-pagination">
          <span>
            {filtered.length} devices · page {currentPage + 1} of {pages}
            {tv ? " · Esc to exit TV" : ""}
          </span>
          <div>
            <button
              aria-label="Previous monitor page"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <button
              aria-label="Next monitor page"
              disabled={currentPage >= pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {saved && (
        <SavedViews
          config={viewConfig}
          apply={applyView}
          onClose={() => setSaved(false)}
        />
      )}
      {compare && <CompareFleet onClose={() => setCompare(false)} />}
      {add && <Onboarding onClose={() => setAdd(false)} />}
      {customize && (
        <Modal title="Chart colors" onClose={() => setCustomize(false)}>
          <p>
            Choose a consistent color for each measurement. Saved in this
            browser; alert severity colors stay unchanged.
          </p>
          <div className="monitor-palette">
            {charts.map((m) => (
              <label key={m.key}>
                {m.label}
                <input
                  type="color"
                  aria-label={`${m.label} chart color`}
                  value={
                    colors[m.key] ||
                    colors[
                      m.key.startsWith("gpu-")
                        ? "gpu"
                        : m.key.startsWith("temperature-")
                          ? "temperature"
                          : m.key
                    ] ||
                    m.color
                  }
                  onChange={(e) =>
                    setColors((previous) => ({
                      ...previous,
                      [m.key]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button onClick={() => setColors({})}>Reset colors</button>
            <button className="primary" onClick={() => setCustomize(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
