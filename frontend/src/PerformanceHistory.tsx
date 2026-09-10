import { useEffect, useRef, useState } from "react";
import { RefreshCw, Activity, Database, Clock3 } from "lucide-react";
import { api, DEMO } from "./api";
import type { Device, Point } from "./types";
import { Panel, time } from "./ui";
import { sourceMetrics, metricDefinition } from "./metrics";
import { HistoryEvents, useHistoryEvents } from "./HistoryEvents";
import { HistoryChart } from "./HistoryChart";
import "./performance-history.css";

type Result = { key: string; points: Point[]; start: number; end: number };
export default function PerformanceHistory({ device }: { device: Device }) {
  const [source, setSource] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] || "")
      .get("metric")
      ?.startsWith("nvme.")
      ? "smart"
      : "system",
  );
  const initial = new URLSearchParams(location.hash.split("?")[1] || "");
  const [metric, setMetric] = useState(initial.get("metric") || "gpu.util_pct");
  const [fixed, setFixed] = useState(() => {
    const start = Number(initial.get("from_ts")),
      end = Number(initial.get("to_ts"));
    return start > 0 && end > start ? { start, end } : null;
  });
  const [range, setRange] = useState(3600);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const definitions = sourceMetrics(device, source);
  // Incident links can reference a removed GPU or historical legacy key.
  if (
    fixed &&
    metric &&
    (source === "system" || source === "smart") &&
    !definitions.some((m) => m.key === metric)
  )
    definitions.push(metricDefinition(metric));
  const definition =
    definitions.find((m) => m.key === metric) ?? definitions[0];
  const metricKey = definition?.key ?? "";
  const requestKey = `${device.id}/${source}/${metricKey}/${range}`;
  const previousRequest = useRef(requestKey);
  const [initialEnd] = useState(Date.now() / 1000);
  const { events, error: eventsError } = useHistoryEvents(
    device.id,
    dataStart(),
    dataEnd(),
  );
  function dataStart() {
    return result?.start ?? fixed?.start ?? initialEnd - range;
  }
  function dataEnd() {
    return result?.end ?? fixed?.end ?? initialEnd;
  }
  const service = device.services?.find((s) => s.id === source);
  const cadence = source === "smart" ? 60 : 5;
  const data = result?.key === requestKey ? result : null;

  useEffect(() => {
    let active = true;
    let running = false;
    setResult((previous) => (previous?.key === requestKey ? previous : null));
    if (previousRequest.current !== requestKey) setError("");
    previousRequest.current = requestKey;
    setLoading(Boolean(metricKey));
    if (!metricKey) return;
    const load = async () => {
      if (running) return;
      running = true;
      const end = fixed?.end ?? Date.now() / 1000;
      const start = fixed?.start ?? end - range;
      try {
        const points = await api<Point[]>(
          `/history?device_id=${encodeURIComponent(device.id)}&metric=${encodeURIComponent(metricKey)}&source=${encodeURIComponent(source)}&from_ts=${start}&to_ts=${end}`,
        );
        if (active) {
          setResult({ key: requestKey, points, start, end });
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [device.id, source, metricKey, range, requestKey, attempt, fixed]);

  const points = (data?.points ?? [])
    .filter((p) => [p.ts, p.value, p.min, p.max].every(Number.isFinite))
    .map((p) => ({
      ...p,
      value: p.value * (definition?.scale ?? 1),
      min: p.min * (definition?.scale ?? 1),
      max: p.max * (definition?.scale ?? 1),
      count: p.count ?? 1,
      bucket_seconds:
        p.bucket_seconds ?? Math.max(cadence, Math.ceil(range / 300)),
      last_sample_ts: p.last_sample_ts ?? null,
    }));
  const last = points.at(-1);
  const stale = Boolean(
    last &&
    data &&
    data.end - (last.last_sample_ts ?? last.ts + last.bucket_seconds) >
      Math.max(cadence * 3, last.bucket_seconds * 2),
  );
  const counter = metricKey.endsWith("_total");

  return (
    <Panel className="performance-history">
      <div className="performance-heading">
        <div>
          <span className="eyebrow">TELEMETRY</span>
          <h2>Performance history</h2>
        </div>
        <span className={DEMO ? "history-mode synthetic" : "history-mode"}>
          {DEMO ? <Database size={13} /> : <Activity size={13} />}
          {DEMO ? "Synthetic data" : "Recorded measurements"}
        </span>
      </div>
      <div className="performance-controls">
        <label>
          Source
          <select
            aria-label="History source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setMetric("");
            }}
          >
            <option value="system">System</option>
            <option value="smart">NVMe SMART</option>
            {device.services?.map((s) => (
              <option value={s.id} key={s.id}>
                {s.provider} · :{s.port}
              </option>
            ))}
          </select>
        </label>
        {definition && (
          <label className="performance-metric">
            Metric
            <select
              aria-label="History metric"
              value={metricKey}
              onChange={(e) => setMetric(e.target.value)}
            >
              {definitions.map((m) => (
                <option value={m.key} key={m.key}>
                  {m.label}
                  {m.unit ? ` (${m.unit})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="performance-range">
          Time range
          <select
            aria-label="History range"
            value={range}
            onChange={(e) => {
              setFixed(null);
              setRange(Number(e.target.value));
            }}
          >
            {[
              [300, "5 minutes"],
              [3600, "1 hour"],
              [21600, "6 hours"],
              [86400, "24 hours"],
              [604800, "7 days"],
              [7776000, "90 days"],
            ].map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!definition ? (
        <div className="performance-state" role="status">
          <Database size={24} />
          <h3>
            {service?.provider === "ollama"
              ? "Model metadata only"
              : "Metrics not available"}
          </h3>
          <p>
            {service?.provider === "ollama"
              ? "The Ollama adapter reads installed and loaded models. Queue, token throughput and cache measurements are not collected."
              : "No supported measurements have been observed at this endpoint yet. Check the service status and whether its metrics endpoint is available."}
          </p>
          <span>
            Model information is available in Models & services below.
          </span>
        </div>
      ) : !data && (loading || !error) ? (
        <div className="performance-state" role="status" aria-live="polite">
          <RefreshCw className="history-loading" size={22} />
          <h3>Loading history…</h3>
          <p>Reading recorded measurements for this time range.</p>
        </div>
      ) : (
        <>
          {error && (
            <div className="performance-warning" role="alert">
              <span>
                <strong>
                  {data ? "Refresh failed" : "Could not load history"}
                </strong>{" "}
                · {error}
                {data ? " Showing the last successful response." : ""}
              </span>
              <button
                disabled={loading}
                onClick={() => setAttempt((n) => n + 1)}
              >
                {loading ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {stale && !error && (
            <div className="performance-warning" role="status">
              <Clock3 size={16} />
              <span>
                No recent samples. The gap at the end of the chart shows missing
                measurements.
              </span>
            </div>
          )}
          {points.length > 0 ? (
            <>
              <HistoryChart
                points={points}
                start={data!.start}
                end={data!.end}
                label={definition.label}
                unit={definition.unit}
                digits={definition.digits}
                percent={definition.percent}
                expectedCadenceSeconds={cadence}
                events={events}
              />
              {counter && (
                <p className="performance-note">
                  Cumulative counter · decreases can indicate a runtime restart.
                  This is not a per-second rate.
                </p>
              )}
              {error && data && (
                <p className="performance-note">
                  Last successful request: {time(data.end)}
                </p>
              )}
            </>
          ) : data && !error ? (
            <div className="performance-state" role="status">
              <Activity size={24} />
              <h3>No samples in this range</h3>
              <p>
                Try a longer time range or check the source connection.
                {service
                  ? " Some runtime measurements appear only after two successful polls."
                  : " Missing measurements are not zero."}
              </p>
            </div>
          ) : null}
        </>
      )}
      <HistoryEvents events={events} error={eventsError} />
      <div className="performance-footer">
        <span>Refreshes every 15 seconds</span>
        <span>Gaps indicate missing data</span>
      </div>
    </Panel>
  );
}
