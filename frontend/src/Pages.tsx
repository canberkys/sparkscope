import { useState, useEffect } from "react";
import {
  Plus,
  ArrowUpRight,
  Server,
  Search,
  ShieldAlert,
  Check,
  Terminal,
  Monitor,
  PauseCircle,
} from "lucide-react";
import { api, DEMO } from "./api";
import type {
  Command,
  Job,
  Service,
  Preferences,
  User,
  Audit,
  Device,
} from "./types";
import {
  useFleet,
  Panel,
  Stat,
  Empty,
  Badge,
  Field,
  Modal,
  ErrorBox,
  value,
  age,
  time,
  useQuery,
} from "./ui";
import Onboarding from "./Onboarding";
import SettingsExtensions from "./SettingsExtensions";
import { MonitoringViewSettings } from "./FleetViews";
export { default as Overview } from "./LiveMonitor";
export function Models() {
  const { services, devices, navigate } = useFleet();
  const [provider, setProvider] = useState(""),
    [search, setSearch] = useState("");
  const visible = services.filter(
    (s) =>
      (!provider || s.provider === provider) &&
      (!search ||
        `${s.models?.map((m) => m.name).join(" ")} ${devices.find((d) => d.id === s.device_id)?.name}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">INFERENCE INVENTORY</div>
          <h1>Models & services</h1>
          <p>Installed, loaded and serving models across the fleet.</p>
        </div>
      </div>
      <div className="filters">
        <div className="search">
          <Search size={18} />
          <input
            aria-label="Search models"
            placeholder="Search model or device…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter runtime"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="">All runtimes</option>
          {["vllm", "ollama", "llama.cpp"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <Panel>
        {visible.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Model / endpoint</th>
                  <th>Device</th>
                  <th>Runtime</th>
                  <th>Status</th>
                  <th>Generation</th>
                  <th>Requests</th>
                  <th>KV cache</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.models?.length ? (
                        s.models.map((m) => (
                          <div className="model-cell" key={m.name}>
                            <strong>{m.name}</strong>
                            <small>
                              {m.state} · {value(m.context_length, " context")}
                            </small>
                          </div>
                        ))
                      ) : (
                        <span className="muted">No model data</span>
                      )}
                      <small className="mono muted">
                        localhost:{s.port}
                        {s.path}
                      </small>
                      {s.warnings?.map((w) => (
                        <small className="amber" key={w}>
                          {w}
                        </small>
                      ))}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => navigate("devices/" + s.device_id)}
                      >
                        {devices.find((d) => d.id === s.device_id)?.name ||
                          s.device_id}
                      </button>
                    </td>
                    <td>
                      <span className="runtime-tag">{s.provider}</span>
                    </td>
                    <td>
                      <Badge status={s.status} />
                    </td>
                    <td>{value(s.metrics?.gen_tokens_per_s, " tok/s", 1)}</td>
                    <td>{value(s.metrics?.requests_running)}</td>
                    <td>{value(s.metrics?.kv_cache_pct, "%", 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No matching services"
            text="Services are discovered after a device connects. You can also add a local endpoint in device details."
          />
        )}
      </Panel>
      <p className="footnote">
        N/A means the runtime does not expose that metric or the endpoint could
        not be read. Model lists do not trigger inference requests.
      </p>
    </>
  );
}
export function Alerts() {
  const { alerts, devices, user, refresh, notify, navigate } = useFleet();
  const [tab, setTab] = useState("active"),
    [severity, setSeverity] = useState(""),
    [deviceFilter, setDeviceFilter] = useState(
      new URLSearchParams(location.hash.split("?")[1] || "").get("device") ||
        "",
    ),
    [groupFilter, setGroupFilter] = useState(""),
    [clusterFilter, setClusterFilter] = useState("");
  const rows = alerts.filter(
    (a) =>
      (tab === "history" || !a.resolved_at) &&
      (!severity || a.severity === severity) &&
      (!deviceFilter || a.device_id === deviceFilter) &&
      (!groupFilter ||
        devices.find((d) => d.id === a.device_id)?.group === groupFilter) &&
      (!clusterFilter ||
        devices.find((d) => d.id === a.device_id)?.cluster_name ===
          clusterFilter),
  );
  const start = Date.now() / 1000 - 86400;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HEALTH & EVENTS</div>
          <h1>Alerts</h1>
          <p>Track each incident from first detection through recovery.</p>
        </div>
      </div>
      <div className="filters">
        <div className="segmented">
          <button
            className={tab === "active" ? "selected" : ""}
            onClick={() => setTab("active")}
          >
            Active
          </button>
          <button
            className={tab === "history" ? "selected" : ""}
            onClick={() => setTab("history")}
          >
            History
          </button>
        </div>
        <select
          aria-label="Alert severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="">All severities</option>
          <option>critical</option>
          <option>warning</option>
        </select>
        <select
          aria-label="Alert device"
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Alert group"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
        >
          <option value="">All groups</option>
          {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select
          aria-label="Alert cluster"
          value={clusterFilter}
          onChange={(e) => setClusterFilter(e.target.value)}
        >
          <option value="">All clusters</option>
          {[...new Set(devices.map((d) => d.cluster_name).filter(Boolean))]
            .sort()
            .map((g) => (
              <option key={g}>{g}</option>
            ))}
        </select>
      </div>
      {tab === "history" && (
        <Panel
          title="Incident timeline · last 24 hours"
          className="section-gap-bottom"
        >
          <div className="timeline">
            {rows
              .filter((a) => (a.resolved_at || Date.now() / 1000) > start)
              .slice(0, 12)
              .map((a) => (
                <div key={a.id}>
                  <span>
                    {devices.find((d) => d.id === a.device_id)?.name ||
                      "Archived device"}
                  </span>
                  <div className="timeline-track">
                    <i
                      className={a.severity}
                      style={{
                        left: `${Math.max(0, ((a.first_seen - start) / 86400) * 100)}%`,
                        width: `${Math.max(0.5, (((a.resolved_at || Date.now() / 1000) - Math.max(start, a.first_seen)) / 86400) * 100)}%`,
                      }}
                      title={`${time(a.first_seen)} → ${a.resolved_at ? time(a.resolved_at) : "ongoing"}`}
                    />
                  </div>
                </div>
              ))}
          </div>
        </Panel>
      )}
      <Panel>
        {rows.length ? (
          <div className="alert-list">
            {rows.map((a) => (
              <div className="alert-row" key={a.id}>
                <ShieldAlert
                  size={23}
                  className={a.severity === "critical" ? "red" : "amber"}
                />
                <div className="alert-body">
                  <div className="row-between">
                    <button
                      className="text-button"
                      onClick={() => navigate("devices/" + a.device_id)}
                    >
                      {devices.find((d) => d.id === a.device_id)?.name ||
                        "Archived device"}
                    </button>
                    <Badge status={a.resolved_at ? "resolved" : a.severity} />
                  </div>
                  <p>{a.message}</p>
                  <button
                    className="text-button"
                    onClick={() =>
                      navigate(
                        "devices/" +
                          a.device_id +
                          "?metric=" +
                          encodeURIComponent(a.metric) +
                          "&from_ts=" +
                          (a.first_seen - 300) +
                          "&to_ts=" +
                          ((a.resolved_at || Date.now() / 1000) + 300),
                      )
                    }
                  >
                    View incident history <ArrowUpRight size={14} />
                  </button>
                  <div className="alert-meta">
                    <span>First seen {time(a.first_seen)}</span>
                    <span>{a.occurrences} observations</span>
                    {a.resolved_at ? (
                      <span>Recovered {time(a.resolved_at)}</span>
                    ) : (
                      <span>Last seen {age(a.last_seen)}</span>
                    )}
                  </div>
                  {a.acknowledged_at ? (
                    <small className="accent">
                      Acknowledged by {a.acknowledged_by} ·{" "}
                      {age(a.acknowledged_at)}
                    </small>
                  ) : (
                    !a.resolved_at &&
                    user.role !== "viewer" && (
                      <button
                        className="small-button"
                        onClick={async () => {
                          try {
                            await api(
                              "/alerts/" + a.id + "/acknowledge",
                              "POST",
                              {},
                            );
                            await refresh();
                            notify(
                              "Alert acknowledged. It will resolve after recovery.",
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        <Check size={15} />
                        Acknowledge
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title={
              tab === "active" ? "No active alerts" : "No recorded incidents"
            }
            text="New incidents appear automatically when a threshold is exceeded for three consecutive samples."
          />
        )}
      </Panel>
    </>
  );
}
export function Operations() {
  const { devices, user, notify } = useFleet();
  const { data: commands, error } = useQuery<Command[]>("/commands");
  const { data: jobs, reload } = useQuery<Job[]>("/jobs", 2000);
  const [selected, setSelected] = useState<string[]>([]),
    [command, setCommand] = useState(""),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<string | null>(null),
    [failure, setFailure] = useState(""),
    [targetSearch, setTargetSearch] = useState(""),
    [targetGroup, setTargetGroup] = useState("");
  const reason = (d: Device | undefined) =>
    !d
      ? "Device removed"
      : d.archived
        ? "Archived"
        : d.paused
          ? "Monitoring paused"
          : !d.host_key_verified
            ? "SSH identity unverified"
            : d.stale || d.status === "offline"
              ? "No fresh connection"
              : "";
  const invalid = selected
    .map((id) => ({ id, why: reason(devices.find((d) => d.id === id)) }))
    .filter((d) => d.why);
  const invalidKey = invalid.map((d) => d.id + d.why).join();
  useEffect(() => setConfirm(false), [command, selected, invalidKey]);
  const cmd = commands?.find((c) => c.key === command);
  const allowed = commands?.filter(
    (c) => !c.destructive || user.role === "admin",
  );
  async function run() {
    if (invalid.length) {
      setFailure(
        "Selected targets are no longer eligible. Remove them before continuing.",
      );
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      const body = { command, device_ids: selected };
      let proof;
      if (cmd?.destructive)
        proof = await api("/operations/confirmations", "POST", body);
      await api("/operations", "POST", {
        ...body,
        ...(proof ? { confirmation: proof.confirmation } : {}),
      });
      setConfirm(false);
      notify("Operation queued");
      reload();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONTROLLED EXECUTION</div>
          <h1>Operations</h1>
          <p>Explicit targets, tracked results and a record of every action.</p>
        </div>
      </div>
      <ErrorBox message={error || failure} />
      {user.role !== "viewer" && (
        <Panel title="Run a command">
          <div className="operation-form">
            <Field label="Command">
              <select
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              >
                <option value="">Choose a command</option>
                {allowed?.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.category} · {c.label}
                    {c.destructive ? " · changes device" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <div className="field-label">
                Target devices · {selected.length} selected
              </div>
              <div className="filters">
                <input
                  type="search"
                  aria-label="Search operation targets"
                  placeholder="Search name or address…"
                  value={targetSearch}
                  onChange={(e) => setTargetSearch(e.target.value)}
                />
                <select
                  aria-label="Operation group"
                  value={targetGroup}
                  onChange={(e) => setTargetGroup(e.target.value)}
                >
                  <option value="">All groups</option>
                  {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </div>
              <p className="inline-note">
                Selected:{" "}
                {selected
                  .map((id) => devices.find((d) => d.id === id)?.name || id)
                  .join(", ") || "None"}
              </p>
              {invalid.length > 0 && (
                <div className="notice" role="alert">
                  {invalid.map((d) => (
                    <div key={d.id}>
                      {devices.find((v) => v.id === d.id)?.name || d.id}:{" "}
                      {d.why}{" "}
                      <button
                        onClick={() =>
                          setSelected((s) => s.filter((id) => id !== d.id))
                        }
                      >
                        Remove target
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="target-list">
                {devices
                  .filter(
                    (d) =>
                      (!targetGroup || d.group === targetGroup) &&
                      `${d.name} ${d.address}`
                        .toLowerCase()
                        .includes(targetSearch.toLowerCase()),
                  )
                  .map((d) => (
                    <label key={d.id} className="checkbox">
                      <input
                        type="checkbox"
                        disabled={!!reason(d) && !selected.includes(d.id)}
                        checked={selected.includes(d.id)}
                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, d.id]
                              : v.filter((id) => id !== d.id),
                          )
                        }
                      />
                      {d.name}
                      <small>
                        {d.address}
                        {reason(d) ? " · " + reason(d) : ""}
                      </small>
                      <Badge status={d.status} />
                    </label>
                  ))}
              </div>
              {!devices.length && <p>Add a device before running commands.</p>}
            </div>
            <div className="row-between">
              <p className="text-sm">
                {cmd
                  ? `${cmd.timeout_seconds / 60} minute timeout${cmd.destructive ? " · administrator confirmation required" : ""}`
                  : "No device is selected automatically."}
              </p>
              <button
                className={cmd?.destructive ? "danger" : "primary"}
                disabled={
                  !command || !selected.length || !!invalid.length || busy
                }
                onClick={() =>
                  cmd?.destructive ? setConfirm(true) : void run()
                }
              >
                <Terminal size={16} />
                {cmd?.destructive ? "Review & confirm" : "Run command"}
              </button>
            </div>
          </div>
        </Panel>
      )}
      <Panel title="Recent operations" className="section-gap">
        {jobs?.length ? (
          <div className="jobs-list">
            {jobs.map((j) => (
              <div key={j.id} className="job-item">
                <button
                  className="job-summary"
                  onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                >
                  <span>
                    <Terminal size={18} />
                    <strong>
                      {String(j.data.command || "Rediscover services")}
                    </strong>
                    <small>{time(j.created_at)}</small>
                  </span>
                  <Badge status={j.status} />
                </button>
                {expanded === j.id && (
                  <div className="job-results">
                    {Object.entries(j.result).map(([target, result]) => (
                      <div key={target}>
                        <strong>
                          {devices.find((d) => d.id === target)?.name || target}
                        </strong>
                        {typeof result === "object" && result !== null ? (
                          <>
                            <div className="row-between">
                              <span className="muted">
                                Exit code: {result.exit_code ?? "unknown"}
                              </span>
                              <span
                                className={
                                  result.exit_code === 0 ? "accent" : "red"
                                }
                              >
                                {result.timed_out
                                  ? "Remote state unknown"
                                  : result.exit_code === 0
                                    ? "Succeeded"
                                    : "Failed"}
                              </span>
                            </div>
                            <pre>
                              {result.stdout || result.stderr || "No output"}
                            </pre>
                            {result.stdout && result.stderr && (
                              <pre className="red">{result.stderr}</pre>
                            )}
                          </>
                        ) : (
                          <p>{String(result)}</p>
                        )}
                      </div>
                    ))}
                    {!Object.keys(j.result).length && (
                      <p>Waiting for the first device result…</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="No operations yet"
            text="Command results and rediscovery jobs will appear here."
          />
        )}
      </Panel>
      {confirm && cmd && (
        <Modal title="Confirm device changes" onClose={() => setConfirm(false)}>
          <div className="stack">
            <ShieldAlert className="amber" size={32} />
            <h3>{cmd.label}</h3>
            <p>{cmd.confirmation_text}</p>
            <div className="notice">
              {selected
                .map((id) => devices.find((d) => d.id === id)?.name)
                .join(", ")}
            </div>
            <p>
              {selected.length} selected devices. This operation is never
              retried automatically.
            </p>
            <ErrorBox message={failure} />
            <div className="modal-actions">
              <button onClick={() => setConfirm(false)}>Cancel</button>
              <button
                className="danger"
                disabled={busy || !!invalid.length}
                onClick={run}
              >
                Confirm & run
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function SettingsPage() {
  const { notify, refresh } = useFleet();
  const { data: p, error, reload } = useQuery<Preferences>("/settings");
  const { data: users, reload: reloadUsers } = useQuery<User[]>("/users");
  const { data: audit } = useQuery<Audit[]>("/audit", 10000);
  const { data: archived, reload: reloadArchived } = useQuery<Device[]>(
    "/devices?archived=true",
  );
  const [tab, setTab] = useState("Monitoring"),
    [edit, setEdit] = useState<Preferences | null>(null),
    [newUser, setNewUser] = useState(false),
    [busy, setBusy] = useState(false);
  const prefs = edit || p;
  async function save(section: string, body: unknown) {
    setBusy(true);
    try {
      await api("/settings/" + section, "PUT", body);
      notify("Settings saved");
      setEdit(null);
      reload();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  if (error) return <ErrorBox message={error} />;
  if (!prefs) return <div className="empty">Loading settings…</div>;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE ADMINISTRATION</div>
          <h1>Settings</h1>
          <p>Manage monitoring rules, access and data retention.</p>
        </div>
      </div>
      <div className="tabs">
        {[
          "Monitoring",
          "Monitoring views",
          "Groups",
          "Users",
          "Archived",
          "Audit",
          "Operations & health",
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Monitoring" && (
        <>
          <div className="stats">
            <Stat
              label="Database"
              number={prefs.database}
              detail="Persistent fleet inventory"
            />
            <Stat
              label="Poll interval"
              number={`${prefs.poll_seconds}s`}
              detail="Independent device scheduling"
            />
            <Stat
              label="Samples collected"
              number={value(prefs.collector.polls)}
              detail="Since collector startup"
            />
            <Stat
              label="Maintenance"
              number={age(prefs.collector.last_maintenance)}
              detail="Rollups and retention"
            />
          </div>
          <Panel title="Alert thresholds">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Warning</th>
                    <th>Critical</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(prefs.thresholds).map(([metric, pair]) => (
                    <tr key={metric}>
                      <td>{metric.replaceAll("_", " ")}</td>
                      {pair.map((v, i) => (
                        <td key={i}>
                          <input
                            aria-label={`${metric} ${i ? "critical" : "warning"}`}
                            type="number"
                            min="0"
                            step="any"
                            placeholder="Disabled"
                            value={v ?? ""}
                            onChange={(e) => {
                              const next = structuredClone(prefs);
                              next.thresholds[metric][i] =
                                e.target.value === "" && i === 1
                                  ? null
                                  : Number(e.target.value);
                              setEdit(next);
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-footer">
              <span>
                Three consecutive violations open an incident; three normal
                samples resolve it.
              </span>
              <button
                className="primary"
                disabled={busy}
                onClick={() => save("thresholds", prefs.thresholds)}
              >
                Save thresholds
              </button>
            </div>
          </Panel>
          <Panel title="Data retention" className="section-gap">
            <div className="retention-form">
              {Object.entries(prefs.retention).map(([k, v]) => (
                <Field key={k} label={k.replaceAll("_", " ")}>
                  <input
                    type="number"
                    min="1"
                    value={v}
                    onChange={(e) => {
                      const next = structuredClone(prefs);
                      (next.retention as any)[k] = Number(e.target.value);
                      setEdit(next);
                    }}
                  />
                </Field>
              ))}
            </div>
            <div className="panel-footer">
              <span>
                Reducing retention removes older records during maintenance.
              </span>
              <button
                className="primary"
                disabled={busy}
                onClick={() => save("retention", prefs.retention)}
              >
                Save retention
              </button>
            </div>
          </Panel>
        </>
      )}
      {tab === "Groups" && (
        <Panel title="Device groups">
          <div className="padded">
            <Field
              label="Group names, one per line"
              hint="Groups organize the fleet; they do not restrict user access."
            >
              <textarea
                rows={8}
                value={prefs.groups.join("\n")}
                onChange={(e) =>
                  setEdit({ ...prefs, groups: e.target.value.split("\n") })
                }
              />
            </Field>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                save("groups", { names: prefs.groups.filter((g) => g.trim()) })
              }
            >
              Save groups
            </button>
          </div>
        </Panel>
      )}
      {tab === "Users" && (
        <Panel
          title="Workspace users"
          action={
            <button className="primary" onClick={() => setNewUser(true)}>
              <Plus size={16} />
              Add user
            </button>
          }
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users?.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>
                      <select
                        aria-label={`Role for ${u.username}`}
                        value={u.role}
                        onChange={async (e) => {
                          try {
                            await api("/users/" + u.id, "PATCH", {
                              role: e.target.value,
                              active: u.active,
                            });
                            reloadUsers();
                            notify("Role updated. Existing sessions revoked.");
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        {["viewer", "operator", "admin"].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Badge status={u.active ? "active" : "disabled"} />
                    </td>
                    <td>
                      <button
                        onClick={async () => {
                          try {
                            await api("/users/" + u.id, "PATCH", {
                              role: u.role,
                              active: !u.active,
                            });
                            reloadUsers();
                            notify("User updated");
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        {u.active ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="inline-note">
            Viewer: monitoring. Operator: diagnostics and acknowledgements.
            Admin: device changes and workspace administration.
          </p>
        </Panel>
      )}
      {tab === "Archived" && (
        <Panel title="Archived devices">
          {archived?.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Address</th>
                    <th>History</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {archived.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td className="mono">{d.address}</td>
                      <td>Preserved</td>
                      <td>
                        <button
                          onClick={async () => {
                            try {
                              await api("/devices/" + d.id, "PATCH", {
                                name: d.name,
                                group: d.group,
                                tags: d.tags,
                                paused: true,
                                archived: false,
                              });
                              reloadArchived();
                              await refresh();
                              notify("Device restored with monitoring paused");
                            } catch (e) {
                              notify((e as Error).message, true);
                            }
                          }}
                        >
                          Restore paused
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No archived devices"
              text="Archived devices retain their history and can be restored here."
            />
          )}
        </Panel>
      )}
      {tab === "Audit" && (
        <Panel title="Audit trail">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {audit?.map((a) => (
                  <tr key={a.id}>
                    <td>{time(a.ts)}</td>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td className="mono">{a.target || "Workspace"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {tab === "Monitoring views" && <MonitoringViewSettings />}
      {tab === "Operations & health" && <SettingsExtensions />}
      {newUser && (
        <NewUser
          onClose={() => {
            setNewUser(false);
            reloadUsers();
          }}
        />
      )}
    </>
  );
}
function NewUser({ onClose }: { onClose: () => void }) {
  const { notify } = useFleet();
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState("viewer"),
    [error, setError] = useState("");
  return (
    <Modal title="Add workspace user" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/users", "POST", { username, password, role });
            notify("User created");
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <ErrorBox message={error} />
        <Field label="Username">
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password (at least 12 characters)">
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {["viewer", "operator", "admin"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Create user</button>
        </div>
      </form>
    </Modal>
  );
}
