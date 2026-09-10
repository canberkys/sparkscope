import { useState } from "react";
import { api, DEMO } from "./api";
import { ErrorBox, Field, Panel, useFleet, useQuery, time } from "./ui";
import HardwarePolicy from "./HardwarePolicy";
type Channel = {
  id: string;
  name: string;
  kind: "webhook" | "email";
  enabled: boolean;
  config: Record<string, any>;
  has_secret: boolean;
};
type Window = {
  id: string;
  name: string;
  start: number;
  end: number;
  scope: { device_ids: string[]; group: string; cluster: string };
};
export default function SettingsExtensions() {
  const { devices } = useFleet();
  const channels = useQuery<Channel[]>("/notification-channels", 10000);
  const windows = useQuery<Window[]>("/maintenance-windows", 10000);
  const diagnostics = useQuery<any>("/diagnostics", 5000);
  const deliveries = useQuery<any[]>("/notification-deliveries", 10000);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"webhook" | "email">("webhook");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [tls, setTls] = useState("starttls");
  const [sender, setSender] = useState("");
  const [recipients, setRecipients] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [editing, setEditing] = useState("");
  const [windowName, setWindowName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [group, setGroup] = useState("");
  const [cluster, setCluster] = useState("");
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      channels.reload();
      windows.reload();
      deliveries.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function resetChannel() {
    setEditing("");
    setName("");
    setUrl("");
    setToken("");
    setUsername("");
    setPassword("");
    setEnabled(false);
    setHost("");
    setPort(587);
    setTls("starttls");
    setSender("");
    setRecipients("");
  }
  async function saveChannel() {
    const config =
      kind === "webhook"
        ? {}
        : {
            host,
            port,
            tls,
            sender,
            recipients: recipients
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          };
    const secret =
      kind === "webhook"
        ? { ...(url ? { url } : {}), ...(token ? { token } : {}) }
        : {
            ...(username ? { username } : {}),
            ...(password ? { password } : {}),
          };
    await api(
      editing ? `/notification-channels/${editing}` : "/notification-channels",
      editing ? "PUT" : "POST",
      { name, kind, enabled, config, secret },
    );
    resetChannel();
  }
  function edit(c: Channel) {
    setEditing(c.id);
    setName(c.name);
    setKind(c.kind);
    setEnabled(c.enabled);
    setUrl("");
    setToken("");
    setHost(c.config.host || "");
    setPort(c.config.port || 587);
    setTls(c.config.tls || "starttls");
    setSender(c.config.sender || "");
    setRecipients((c.config.recipients || []).join(", "));
    setUsername("");
    setPassword("");
  }
  return (
    <div className="section-gap">
      <ErrorBox
        message={error || channels.error || windows.error || diagnostics.error}
      />
      <HardwarePolicy />
      <Panel title="Server diagnostics">
        <p>
          {diagnostics.data?.ready ? "Ready" : "Not ready"} · remote device
          outages are reported separately.
        </p>
        <dl className="info-list">
          {diagnostics.data &&
            Object.entries({
              Database: diagnostics.data.database,
              Supervision: diagnostics.data.supervision,
              Maintenance: diagnostics.data.maintenance,
              Notifications: diagnostics.data.notifications,
              "Pending deliveries": diagnostics.data.pending_notifications,
              "System polls": diagnostics.data.collector?.polls ?? 0,
              "Collection failures": diagnostics.data.collector?.failures ?? 0,
              "Stalled jobs": diagnostics.data.stalled_jobs?.length ?? 0,
              "Last maintenance": diagnostics.data.collector?.last_maintenance
                ? time(diagnostics.data.collector.last_maintenance)
                : "Waiting for maintenance",
              "Last supervision": diagnostics.data.collector?.last_supervision
                ? time(diagnostics.data.collector.last_supervision)
                : "Waiting for supervision",
            }).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {typeof v === "boolean"
                    ? v
                      ? "Healthy"
                      : "Needs attention"
                    : String(v ?? "N/A")}
                </dd>
              </div>
            ))}
        </dl>
      </Panel>
      <Panel title="Notification channels">
        <p>
          Channels start disabled. Enabling allows alert delivery. Test sends
          require a separate action. Saved secrets are never displayed.
          {DEMO && " Demo tests are simulated; no webhook or email is sent."}
        </p>
        <div className="stack">
          {channels.data?.map((c) => (
            <div
              className="row-between"
              style={{ flexWrap: "wrap", overflowWrap: "anywhere" }}
              key={c.id}
            >
              <span>
                {c.name} · {c.kind} · {c.enabled ? "Enabled" : "Disabled"}
              </span>
              <div className="actions">
                <button disabled={busy} onClick={() => edit(c)}>
                  Edit
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      api(`/notification-channels/${c.id}`, "PUT", {
                        name: c.name,
                        kind: c.kind,
                        enabled: !c.enabled,
                        config: c.config,
                      }),
                    )
                  }
                >
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  disabled={busy || !c.enabled}
                  onClick={() =>
                    action(() =>
                      api(`/notification-channels/${c.id}/test`, "POST"),
                    )
                  }
                >
                  Send test
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      api(`/notification-channels/${c.id}`, "DELETE"),
                    )
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(saveChannel);
          }}
        >
          <div className="two-col">
            <Field label="Channel name">
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Channel type">
              <select
                disabled={!!editing}
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="webhook">Webhook</option>
                <option value="email">Email</option>
              </select>
            </Field>
          </div>
          {kind === "webhook" ? (
            <div className="two-col">
              <Field label="HTTPS webhook URL">
                <input
                  type="url"
                  required={!editing}
                  placeholder={
                    editing ? "Leave blank to keep saved endpoint" : "https://…"
                  }
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Field label="Bearer token">
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    editing ? "Leave blank to keep saved token" : "Optional"
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <>
              <div className="two-col">
                <Field label="SMTP host">
                  <input
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </Field>
                <Field label="SMTP port">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </Field>
                <Field label="TLS">
                  <select value={tls} onChange={(e) => setTls(e.target.value)}>
                    <option value="starttls">STARTTLS</option>
                    <option value="ssl">TLS</option>
                  </select>
                </Field>
                <Field label="Sender">
                  <input
                    type="email"
                    required
                    value={sender}
                    onChange={(e) => setSender(e.target.value)}
                  />
                </Field>
                <Field label="Recipients (comma-separated)">
                  <input
                    required
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                  />
                </Field>
                <Field label="SMTP username">
                  <input
                    autoComplete="off"
                    placeholder={
                      editing
                        ? "Leave blank to keep saved username"
                        : "Optional"
                    }
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </Field>
                <Field label="SMTP password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      editing
                        ? "Leave blank to keep saved password"
                        : "Optional"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable alert delivery
          </label>
          <div className="actions">
            <button disabled={busy} className="primary">
              {editing ? "Save channel" : "Add channel"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  resetChannel();
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
        <h3>Recent delivery attempts</h3>
        <ErrorBox message={deliveries.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data?.map((d) => (
                <tr key={d.id}>
                  <td>{d.event_id}</td>
                  <td>{d.status}</td>
                  <td>{d.attempts}</td>
                  <td>{d.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Maintenance windows">
        <p>
          Telemetry and incident recording continue. Matching external
          notifications are suppressed; open incidents are summarized when
          maintenance ends. Scope filters are combined.
        </p>
        {windows.data?.map((w) => (
          <div
            className="row-between"
            style={{ flexWrap: "wrap", overflowWrap: "anywhere" }}
            key={w.id}
          >
            <span>
              {w.name} · {time(w.start)} → {time(w.end)}
              <small>
                Scope:{" "}
                {w.scope.device_ids.length
                  ? w.scope.device_ids
                      .map((id) => devices.find((d) => d.id === id)?.name || id)
                      .join(", ")
                  : "Any device"}
                {w.scope.group ? ` · Group: ${w.scope.group}` : ""}
                {w.scope.cluster ? ` · Cluster: ${w.scope.cluster}` : ""}
              </small>
            </span>
            {w.end > Date.now() / 1000 && (
              <button
                disabled={busy}
                onClick={() =>
                  action(() => api(`/maintenance-windows/${w.id}`, "DELETE"))
                }
              >
                {w.start > Date.now() / 1000 ? "Cancel" : "End now"}
              </button>
            )}
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api("/maintenance-windows", "POST", {
                name: windowName,
                start: new Date(start).getTime() / 1000,
                end: new Date(end).getTime() / 1000,
                device_ids: selected,
                group,
                cluster,
              });
              setWindowName("");
            });
          }}
        >
          <div className="two-col">
            <Field label="Maintenance name">
              <input
                required
                value={windowName}
                onChange={(e) => setWindowName(e.target.value)}
              />
            </Field>
            <Field label="Start (local time)">
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="End (local time)">
              <input
                type="datetime-local"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
            <Field label="Maintenance group">
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">Any group</option>
                {[...new Set(devices.map((d) => d.group))].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </Field>
            <Field label="Maintenance cluster">
              <select
                value={cluster}
                onChange={(e) => setCluster(e.target.value)}
              >
                <option value="">Any cluster</option>
                {[
                  ...new Set(
                    devices.map((d) => d.cluster_name).filter(Boolean),
                  ),
                ].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="target-list">
            {devices.map((d) => (
              <label className="checkbox" key={d.id}>
                <input
                  type="checkbox"
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
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={busy || !(selected.length || group || cluster)}
          >
            Schedule maintenance
          </button>
        </form>
      </Panel>
    </div>
  );
}
