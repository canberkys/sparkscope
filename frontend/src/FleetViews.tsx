import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal, ErrorBox, Field, Panel, useFleet, useQuery } from "./ui";
import type { Device, Point } from "./types";
import { HistoryChart } from "./HistoryChart";
import { metricDefinition } from "./metrics";
export type ViewConfig = {
  search: string;
  group: string;
  cluster: string;
  view: string;
  tv: boolean;
  page_size: number;
  rotation_seconds: number;
  device_ids: string[];
  metric_keys: string[];
  colors: Record<string, string>;
  summary_widgets?: string[];
  live_window_seconds?: number;
};
export const defaultViewConfig: ViewConfig = {
  search: "",
  group: "",
  cluster: "",
  view: "devices",
  tv: false,
  page_size: 6,
  rotation_seconds: 20,
  device_ids: [],
  metric_keys: [],
  colors: {},
  summary_widgets: ["reporting", "incidents", "power", "clusters"],
  live_window_seconds: 300,
};
let pendingView: ViewConfig | null = null;
export function takePendingView() {
  const value = pendingView;
  pendingView = null;
  return value;
}
export function MonitoringViewSettings() {
  const [open, setOpen] = useState(false);
  const { navigate } = useFleet();
  return (
    <Panel title="Monitoring views">
      <p>
        Configure Overview cards, filters, chart colors and Live TV. Save
        personal views or shared workspace views, then open a view to use it.
      </p>
      <button className="primary" onClick={() => setOpen(true)}>
        Configure monitoring views
      </button>
      {open && (
        <SavedViews
          config={defaultViewConfig}
          onClose={() => setOpen(false)}
          apply={(config) => {
            pendingView = config;
            const url = new URL(location.href);
            url.searchParams.delete("view");
            window.history.replaceState(null, "", url);
            navigate("overview");
          }}
        />
      )}
    </Panel>
  );
}
const viewPalette = {
  cpu: "#22d3ee",
  gpu: "#a78bfa",
  memory: "#34d399",
  temperature: "#fb923c",
  "disk-read": "#fbbf24",
  "disk-write": "#f472b6",
  "network-rx": "#60a5fa",
  "network-tx": "#c4b5fd",
};
type SavedView = {
  id: string;
  name: string;
  shared: boolean;
  owner_id: string;
  config: ViewConfig;
};
export function SavedViews({
  config,
  apply,
  onClose,
}: {
  config: ViewConfig;
  apply: (c: ViewConfig) => void;
  onClose: () => void;
}) {
  const { user, devices } = useFleet();
  const { data, error, reload } = useQuery<SavedView[]>("/views");
  const [editId, setEditId] = useState("");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(config);
  async function save(id?: string) {
    setBusy(true);
    setFailure("");
    try {
      await api(id ? "/views/" + id : "/views", id ? "PUT" : "POST", {
        name: name.trim(),
        shared,
        config: draft,
      });
      reload();
      setName("");
      setEditId("");
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Saved monitoring views" onClose={onClose}>
      <ErrorBox message={failure || error} />
      <p>
        Personal views follow your account. Shared views are maintained by
        administrators.
      </p>
      <div className="stack">
        {data?.map((v) => (
          <div key={v.id} className="row-between" style={{ flexWrap: "wrap" }}>
            <span>
              {v.name} · {v.shared ? "Shared" : "Personal"}
            </span>
            <div className="actions">
              <button
                onClick={() => {
                  apply(v.config);
                  const url = new URL(location.href);
                  url.searchParams.set("view", v.id);
                  window.history.replaceState(null, "", url);
                  onClose();
                }}
              >
                Open
              </button>
              <button
                onClick={() => {
                  setEditId("");
                  setName(v.name + " copy");
                  setShared(false);
                  setDraft(v.config);
                }}
              >
                Copy
              </button>
              {(v.shared ? user.role === "admin" : v.owner_id === user.id) && (
                <>
                  <button
                    onClick={() => {
                      setEditId(v.id);
                      setName(v.name);
                      setShared(v.shared);
                      setDraft(v.config);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await api("/views/" + v.id, "DELETE");
                        reload();
                      } catch (e) {
                        setFailure((e as Error).message);
                      }
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(editId || undefined);
        }}
      >
        <Field label="View name">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Search filter">
          <input
            placeholder="Search name, IP, tag or GPU…"
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
          />
        </Field>
        <Field label="Default monitor layout">
          <select
            value={draft.view}
            onChange={(e) => setDraft({ ...draft, view: e.target.value })}
          >
            <option value="devices">Device view</option>
            <option value="clusters">Cluster view</option>
          </select>
        </Field>
        <Field label="View group">
          <select
            value={draft.group}
            onChange={(e) => setDraft({ ...draft, group: e.target.value })}
          >
            <option value="">All groups</option>
            {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="View cluster">
          <select
            value={draft.cluster}
            onChange={(e) => setDraft({ ...draft, cluster: e.target.value })}
          >
            <option value="">All clusters & standalone</option>
            {[...new Set(devices.map((d) => d.cluster_name).filter(Boolean))]
              .sort()
              .map((g) => (
                <option key={g}>{g}</option>
              ))}
            <option value="__standalone">Standalone devices</option>
          </select>
        </Field>
        <Field label="Summary cards">
          <div className="target-list">
            {[
              ["reporting", "Devices reporting"],
              ["incidents", "Active incidents"],
              ["power", "GPU power"],
              ["clusters", "Configured clusters"],
            ].map(([key, label]) => (
              <label key={key} className="checkbox">
                <input
                  type="checkbox"
                  checked={(
                    draft.summary_widgets ?? defaultViewConfig.summary_widgets!
                  ).includes(key)}
                  onChange={(e) => {
                    const selected =
                      draft.summary_widgets ??
                      defaultViewConfig.summary_widgets!;
                    setDraft({
                      ...draft,
                      summary_widgets: e.target.checked
                        ? [...selected, key]
                        : selected.filter((k) => k !== key),
                    });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
        <Field
          label="Live chart window"
          hint="Controls the visible chart window; collection and freshness checks remain unchanged."
        >
          <select
            aria-label="Live chart window"
            value={draft.live_window_seconds ?? 300}
            onChange={(e) =>
              setDraft({
                ...draft,
                live_window_seconds: Number(e.target.value),
              })
            }
          >
            {[60, 180, 300].map((n) => (
              <option key={n} value={n}>
                {n / 60} minute{n > 60 ? "s" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Metric colors">
          <div className="monitor-palette">
            {Object.entries(viewPalette).map(([key, color]) => (
              <label key={key}>
                {key.replaceAll("-", " ")}
                <input
                  aria-label={`Saved ${key} color`}
                  type="color"
                  value={draft.colors[key] || color}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      colors: { ...draft.colors, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.tv}
            onChange={(e) => setDraft({ ...draft, tv: e.target.checked })}
          />
          Open in Live TV
        </label>
        <Field label="TV cards per page">
          <select
            value={draft.page_size}
            onChange={(e) =>
              setDraft({ ...draft, page_size: Number(e.target.value) })
            }
          >
            <option value={4}>4 cards</option>
            <option value={6}>6 cards</option>
          </select>
        </Field>
        <Field label="Page rotation">
          <select
            value={draft.rotation_seconds}
            onChange={(e) =>
              setDraft({ ...draft, rotation_seconds: Number(e.target.value) })
            }
          >
            {[0, 10, 20, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n ? `${n} seconds` : "Fixed page"}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Included devices"
          hint="No selection includes all devices matching the filters."
        >
          <div className="target-list">
            {devices.map((d) => (
              <label className="checkbox" key={d.id}>
                <input
                  type="checkbox"
                  checked={draft.device_ids.includes(d.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      device_ids: e.target.checked
                        ? [...draft.device_ids, d.id]
                        : draft.device_ids.filter((id) => id !== d.id),
                    })
                  }
                />
                {d.name}
              </label>
            ))}
          </div>
        </Field>
        <Field
          label="Visible live metrics"
          hint="No selection uses all available metrics."
        >
          <div className="target-list">
            {[
              "cpu",
              "gpu",
              "memory",
              "temperature",
              "disk-read",
              "disk-write",
              "network-rx",
              "network-tx",
            ].map((m) => (
              <label className="checkbox" key={m}>
                <input
                  type="checkbox"
                  checked={draft.metric_keys.includes(m)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      metric_keys: e.target.checked
                        ? [...draft.metric_keys, m]
                        : draft.metric_keys.filter((k) => k !== m),
                    })
                  }
                />
                {m.replaceAll("-", " ")}
              </label>
            ))}
          </div>
        </Field>
        {user.role === "admin" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            Shared with workspace
          </label>
        )}
        <div className="modal-actions">
          <button
            type="button"
            onClick={() => {
              apply(draft);
              onClose();
            }}
          >
            Apply without saving
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {editId ? "Update view" : "Save new view"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
type Target = { id: string; device: Device; prefix: string; label: string };
export function CompareFleet({ onClose }: { onClose: () => void }) {
  const { devices } = useFleet();
  const [selection, setSelection] = useState<string[]>([]);
  const [metric, setMetric] = useState("cpu.usage_pct");
  const [range, setRange] = useState(3600);
  const [result, setResult] = useState<{
    key: string;
    start: number;
    end: number;
    series: { target: Target; points: Point[]; error: string }[];
  } | null>(null);
  const targets: Target[] = devices.flatMap((d) => [
    { id: d.id, device: d, prefix: "", label: d.name },
    ...(d.info?.gpus || []).map((g) => ({
      id: d.id + "/" + g.id,
      device: d,
      prefix: `gpu.${g.id}.`,
      label: `${d.name} · ${g.name} (${g.index})`,
    })),
  ]);
  const requestKey = selection.join() + metric + range;
  useEffect(() => {
    let live = true;
    const end = Date.now() / 1000,
      start = end - range;
    setResult(null);
    void Promise.all(
      selection.map(async (id) => {
        const target = targets.find((t) => t.id === id)!;
        const key = target.prefix
          ? target.prefix + metric.replace(/^gpu\./, "")
          : metric;
        try {
          const points = await api<Point[]>(
            `/history?device_id=${encodeURIComponent(target.device.id)}&source=system&metric=${encodeURIComponent(key)}&from_ts=${start}&to_ts=${end}`,
          );
          return { target, points, error: "" };
        } catch (e) {
          return { target, points: [], error: (e as Error).message };
        }
      }),
    ).then((series) => {
      if (live) setResult({ key: requestKey, start, end, series });
    });
    return () => {
      live = false;
    };
  }, [requestKey]);
  const definition = metricDefinition(metric);
  const all = result?.series.flatMap((s) => s.points) || [];
  const max = Math.max(1, ...all.map((p) => p.max));
  const min = Math.min(0, ...all.map((p) => p.min));
  return (
    <Modal title="Compare devices & GPUs" onClose={onClose}>
      <p>
        Choose up to four targets. All charts use the same recorded time window
        and scale. Missing measurements remain empty.
      </p>
      <div className="filters">
        <select
          aria-label="Comparison metric"
          value={metric}
          onChange={(e) => {
            setMetric(e.target.value);
            setSelection([]);
          }}
        >
          {[
            "cpu.usage_pct",
            "memory.used_pct",
            "gpu.util_pct",
            "gpu.temp_c",
            "gpu.power_draw_w",
          ].map((k) => (
            <option value={k} key={k}>
              {metricDefinition(k).label}
            </option>
          ))}
        </select>
        <select
          aria-label="Comparison range"
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
        >
          {[
            [300, "5 minutes"],
            [3600, "1 hour"],
            [86400, "24 hours"],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="target-list">
        {targets
          .filter((t) =>
            metric.startsWith("gpu.")
              ? t.prefix || !t.device.info?.gpus?.length
              : !t.prefix,
          )
          .map((t) => (
            <label key={t.id} className="checkbox">
              <input
                type="checkbox"
                checked={selection.includes(t.id)}
                disabled={!selection.includes(t.id) && selection.length >= 4}
                onChange={(e) =>
                  setSelection((s) =>
                    e.target.checked
                      ? [...s, t.id]
                      : s.filter((id) => id !== t.id),
                  )
                }
              />
              {t.label}
            </label>
          ))}
      </div>
      {selection.length > 0 && !result && (
        <p role="status">Loading comparison…</p>
      )}
      {result?.key === requestKey &&
        result.series.map((s, i) => (
          <section key={s.target.id}>
            <h3>{s.target.label}</h3>
            <ErrorBox message={s.error} />
            {s.points.length ? (
              <HistoryChart
                points={s.points}
                start={result.start}
                end={result.end}
                domainMin={min}
                domainMax={max}
                label={definition.label}
                unit={definition.unit}
                percent={definition.percent}
                color={["#22d3ee", "#a78bfa", "#34d399", "#fb923c"][i]}
              />
            ) : (
              !s.error && <p>No supported samples in this time range.</p>
            )}
          </section>
        ))}
    </Modal>
  );
}
