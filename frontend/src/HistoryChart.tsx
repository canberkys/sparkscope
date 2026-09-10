import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Point } from "./types";
import "./history-chart.css";

type Props = {
  points: Point[];
  start: number;
  end: number;
  label: string;
  unit: string;
  digits?: number;
  percent?: boolean;
  expectedCadenceSeconds?: number;
  color?: string;
  compact?: boolean;
  compactHeight?: number;
  events?: { id: string; ts: number; kind: string }[];
  domainMin?: number;
  domainMax?: number;
};

export function HistoryChart({
  points,
  start,
  end,
  label,
  unit,
  digits = 1,
  percent = false,
  expectedCadenceSeconds = 5,
  color = "#71e5bc",
  compact = false,
  compactHeight = 140,
  events = [],
  domainMin,
  domainMax,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [inspect, setInspect] = useState<number | null>(null);
  const [showRange, setShowRange] = useState(false);
  const descriptionId = useId();
  const clipId = useId();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setInspect(null), [start, end, label]);

  // The parent owns loading, validation and empty/error states.
  if (!points.length) return null;
  const last = points.at(-1)!;
  const count = points.reduce((sum, point) => sum + point.count, 0);
  const average = count
    ? points.reduce((sum, point) => sum + point.value * point.count, 0) / count
    : null;
  const peak = Math.max(...points.map((point) => point.max));
  const minimum = domainMin ?? Math.min(0, ...points.map((point) => point.min));
  const maximum = Math.max(1, domainMax ?? peak);
  const rawStep = (maximum - minimum) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) *
    magnitude;
  const low = percent ? 0 : Math.floor(minimum / step) * step;
  const high = percent ? 100 : Math.ceil(maximum / step) * step;
  const yStep = percent ? (compact ? 50 : 25) : step;
  const ticks = Array.from(
    { length: Math.round((high - low) / yStep) + 1 },
    (_, i) => low + i * yStep,
  );
  const number = (value: number, precision = digits) =>
    value.toLocaleString("en-US", {
      maximumFractionDigits: precision,
    });
  const formatted = (value: number | null) =>
    value === null ? "—" : `${number(value)}${unit ? ` ${unit}` : ""}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fullTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  const multiDay =
    new Date(start * 1000).toDateString() !==
    new Date(end * 1000).toDateString();
  const axisTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString("en-US", {
      ...(multiDay ? { month: "short" as const, day: "numeric" as const } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(compact && end - start < 120 ? { second: "2-digit" as const } : {}),
    });
  const left = Math.max(
    44,
    Math.max(...ticks.map((t) => number(t).length)) * 7 + 12,
  );
  const right = width - 12;
  const top = 18;
  const plotHeight = compact
    ? Math.max(100, Math.min(160, compactHeight))
    : 222;
  const bottom = plotHeight - 33;
  const x = (ts: number) =>
    left + ((ts - start) / Math.max(1, end - start)) * (right - left);
  const y = (v: number) =>
    bottom -
    ((Math.min(high, Math.max(low, v)) - low) / (high - low)) * (bottom - top);
  const segments: Point[][] = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (
      !previous ||
      point.ts - previous.ts >
        Math.max(
          previous.bucket_seconds,
          point.bucket_seconds,
          expectedCadenceSeconds,
        ) *
          1.5
    )
      segments.push([]);
    segments.at(-1)!.push(point);
  });
  const path = (segment: Point[], key: "value" | "min" | "max") =>
    segment
      .map((point, i) => `${i ? "L" : "M"}${x(point.ts)},${y(point[key])}`)
      .join(" ");
  const selected =
    inspect === null ? null : Math.min(inspect, points.length - 1);
  const point = selected === null ? null : points[selected];
  const tickCount = compact || width < 480 ? 2 : width < 760 ? 4 : 5;
  const inspectAt = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect();
    const ts =
      start +
      ((((clientX - rect.left) * width) / rect.width - left) / (right - left)) *
        (end - start);
    let nearest = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.ts - ts) < Math.abs(points[nearest].ts - ts)) nearest = i;
    });
    setInspect(nearest);
  };

  return (
    <section
      className={`history-chart${compact ? " history-chart-compact" : ""}`}
      style={{ "--history-color": color } as CSSProperties}
      aria-label={`${label} history`}
    >
      <div className="history-chart-heading">
        <h3>
          {label}
          {unit && <span> · {unit}</span>}
        </h3>
        {compact ? (
          <strong
            className="history-latest"
            title={`${last.count === 1 ? "Last sample" : "Latest bucket average"}: ${fullTime(last.last_sample_ts ?? last.ts)} (${zone})`}
          >
            {formatted(last.value)}
          </strong>
        ) : (
          <label className="history-range-toggle">
            <input
              type="checkbox"
              checked={showRange}
              onChange={(e) => setShowRange(e.target.checked)}
            />
            Min/max band
          </label>
        )}
      </div>
      {!compact && (
        <dl className="history-summary">
          <div>
            <dt>Latest bucket avg</dt>
            <dd>{formatted(last.value)}</dd>
          </div>
          <div>
            <dt>Period average</dt>
            <dd>{formatted(average)}</dd>
          </div>
          <div>
            <dt>Peak</dt>
            <dd>{formatted(peak)}</dd>
          </div>
          <div>
            <dt>
              {last.last_sample_ts == null ? "Latest bucket" : "Last sample"}
            </dt>
            <dd className="history-summary-time">
              {fullTime(last.last_sample_ts ?? last.ts)}
            </dd>
          </div>
        </dl>
      )}
      <div ref={container} className="history-plot">
        <svg
          viewBox={`0 0 ${width} ${plotHeight}`}
          style={{ height: plotHeight }}
          role="slider"
          tabIndex={0}
          aria-label={`Inspect ${label} samples`}
          aria-describedby={descriptionId}
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={(selected ?? points.length - 1) + 1}
          aria-valuetext={`${fullTime((point ?? last).ts)} (${zone}); ${compact && (point ?? last).count === 1 ? "sample" : "bucket average"} ${formatted((point ?? last).value)}`}
          onFocus={() => setInspect((current) => current ?? points.length - 1)}
          onKeyDown={(event) => {
            const current = selected ?? points.length - 1;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? points.length - 1
                  : event.key === "ArrowLeft" || event.key === "ArrowDown"
                    ? Math.max(0, current - 1)
                    : event.key === "ArrowRight" || event.key === "ArrowUp"
                      ? Math.min(points.length - 1, current + 1)
                      : null;
            if (next !== null) {
              event.preventDefault();
              setInspect(next);
            }
          }}
          onPointerDown={(event) =>
            inspectAt(event.clientX, event.currentTarget)
          }
          onPointerMove={(event) => {
            if (event.pointerType === "mouse" || event.buttons)
              inspectAt(event.clientX, event.currentTarget);
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={left - 4}
                y={top - 4}
                width={right - left + 8}
                height={bottom - top + 8}
              />
            </clipPath>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="history-grid"
                x1={left}
                x2={right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text x={left - 9} y={y(tick) + 4} textAnchor="end">
                {number(tick)}
              </text>
            </g>
          ))}
          {Array.from({ length: tickCount }, (_, i) => {
            const ts = start + (i / (tickCount - 1)) * (end - start);
            return (
              <text
                key={i}
                x={x(ts)}
                y={plotHeight - 13}
                textAnchor={
                  i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle"
                }
              >
                {axisTime(ts)}
              </text>
            );
          })}
          {segments.map((segment, i) => (
            <g key={i} clipPath={`url(#${clipId})`}>
              {!compact && showRange && (
                <path
                  className="history-band"
                  d={`${path(segment, "max")} ${[...segment]
                    .reverse()
                    .map((p) => `L${x(p.ts)},${y(p.min)}`)
                    .join(" ")} Z`}
                />
              )}
              <path className="history-line" d={path(segment, "value")} />
              {segment.length === 1 && (
                <circle
                  className="history-dot"
                  cx={x(segment[0].ts)}
                  cy={y(segment[0].value)}
                  r={3}
                />
              )}
            </g>
          ))}
          {point && (
            <g clipPath={`url(#${clipId})`}>
              <line
                className="history-crosshair"
                x1={x(point.ts)}
                x2={x(point.ts)}
                y1={top}
                y2={bottom}
              />
              <circle
                className="history-dot"
                cx={x(point.ts)}
                cy={y(point.value)}
                r={4}
              />
            </g>
          )}
          {events
            .filter((e) => e.ts >= start && e.ts <= end)
            .map((e) => (
              <g key={e.id}>
                <title>
                  {e.kind.replaceAll(".", " ")} · {fullTime(e.ts)}
                </title>
                <line
                  x1={x(e.ts)}
                  x2={x(e.ts)}
                  y1={top}
                  y2={bottom}
                  stroke={
                    e.kind === "alarm.resolve"
                      ? "#34d399"
                      : e.kind.startsWith("alarm.")
                        ? "#fb7185"
                        : "#fbbf24"
                  }
                  strokeDasharray="3 4"
                  opacity={0.7}
                />
                <circle cx={x(e.ts)} cy={top} r={3} fill="#fbbf24" />
              </g>
            ))}
        </svg>
      </div>
      <div className="history-inspection">
        {compact ? (
          <>
            <span>
              {point
                ? point.count === 1
                  ? "Sample"
                  : "Bucket avg"
                : last.count === 1
                  ? "Last sample"
                  : "Latest bucket avg"}{" "}
              {point ? formatted(point.value) : ""}
            </span>
            <time
              dateTime={new Date(
                (point?.last_sample_ts ??
                  point?.ts ??
                  last.last_sample_ts ??
                  last.ts) * 1000,
              ).toISOString()}
            >
              {new Date(
                (point?.last_sample_ts ??
                  point?.ts ??
                  last.last_sample_ts ??
                  last.ts) * 1000,
              ).toLocaleTimeString("en-US", { hour12: false })}
            </time>
          </>
        ) : point ? (
          <>
            <strong>{fullTime(point.ts)}</strong>
            <span>Bucket avg {formatted(point.value)}</span>
            <span>
              Min {formatted(point.min)} · max {formatted(point.max)}
            </span>
            <span>
              {number(point.count, 0)} samples ·{" "}
              {number(point.bucket_seconds, 0)}s bucket
            </span>
          </>
        ) : (
          <span>
            Point or tap to inspect. Use arrow keys, Home or End when focused.
          </span>
        )}
      </div>
      <p
        id={descriptionId}
        className={compact ? "history-description-hidden" : "history-method"}
      >
        {compact ? (
          `Point or tap to inspect. Use arrow keys, Home or End when focused. Time zone: ${zone}. Gaps indicate missing intervals.`
        ) : (
          <>
            {number(count, 0)} samples · {number(last.bucket_seconds, 0)}s
            buckets · Average weighted by sample count · Gaps indicate missing
            intervals · Time zone: {zone}.
            {showRange && " Band shows recorded bucket minimum and maximum."}
          </>
        )}
      </p>
    </section>
  );
}
