import { useEffect, useState } from "react";
import { api } from "./api";
import "./hardware-policy.css";
import { ErrorBox, Panel, useFleet } from "./ui";

type Pair = [number, number | null] | null;
type Rules = Record<string, Pair>;
type Policy = {
  profiles: Record<string, { metrics: Rules }>;
  devices: Record<
    string,
    { profile?: string; metrics?: Rules; gpus?: Record<string, Rules> }
  >;
};
type Effective = Record<
  string,
  { thresholds: Pair; source: string; component_id: string | null }
>;
const metrics = [
  ["cpu.temp_max_c", "CPU temperature (°C)"],
  ["gpu.temp_c", "GPU temperature (°C)"],
  ["gpu.power_draw_w", "GPU power (W)"],
  ["disk.root_used_pct", "Root disk used (%)"],
  ["memory.used_pct", "System memory used (%)"],
  ["gpu.ecc_uncorrected", "Uncorrected GPU ECC errors"],
  ["gpu.throttle_active", "GPU throttling (0 or 1)"],
];

export default function HardwarePolicy() {
  const { devices, notify } = useFleet();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [scope, setScope] = useState("device");
  const [deviceId, setDeviceId] = useState("");
  const [profile, setProfile] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const [gpu, setGpu] = useState("");
  const [metric, setMetric] = useState("gpu.temp_c");
  const [mode, setMode] = useState("inherit");
  const [warning, setWarning] = useState("");
  const [critical, setCritical] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [effective, setEffective] = useState<Effective>({});
  const device = devices.find((item) => item.id === deviceId);
  const gpus = (device?.info?.gpus || []).filter(
    (item) => item.uuid || item.id,
  );

  useEffect(() => {
    let active = true;
    api<Policy>("/settings/hardware")
      .then((value) => {
        if (active) setPolicy(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setEffective({});
    if (deviceId)
      api<Effective>(`/devices/${deviceId}/thresholds`)
        .then((value) => {
          if (active) setEffective(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [deviceId, policy]);
  useEffect(() => {
    const selected =
      scope === "profile"
        ? policy?.profiles[profile]?.metrics
        : scope === "gpu"
          ? policy?.devices[deviceId]?.gpus?.[gpu]
          : policy?.devices[deviceId]?.metrics;
    const rule = selected?.[metric];
    setMode(
      rule === undefined ? "inherit" : rule === null ? "disabled" : "custom",
    );
    setWarning(rule?.[0]?.toString() || "");
    setCritical(rule?.[1]?.toString() || "");
  }, [policy, scope, profile, deviceId, gpu, metric]);

  async function save(next: Policy) {
    setBusy(true);
    setError("");
    try {
      setPolicy(await api<Policy>("/settings/hardware", "PUT", next));
      notify("Hardware policy saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveRule(e: React.FormEvent) {
    e.preventDefault();
    if (!policy || busy || !ready) return;
    let pair: Pair | undefined;
    if (mode === "disabled") pair = null;
    if (mode === "custom") {
      const warn = Number(warning),
        crit = critical.trim() ? Number(critical) : null;
      if (
        !warning.trim() ||
        !Number.isFinite(warn) ||
        warn < 0 ||
        (crit !== null && (!Number.isFinite(crit) || crit < warn))
      ) {
        setError(
          "Enter a non-negative warning; critical must be blank or at least the warning value.",
        );
        return;
      }
      pair = [warn, crit];
    }
    const next = structuredClone(policy);
    let selected: Rules;
    if (scope === "profile") selected = next.profiles[profile].metrics;
    else {
      const row = (next.devices[deviceId] ||= {});
      selected =
        scope === "gpu"
          ? ((row.gpus ||= {})[gpu] ||= {})
          : (row.metrics ||= {});
    }
    if (pair === undefined) delete selected[metric];
    else selected[metric] = pair;
    await save(next);
  }
  const ready =
    policy &&
    (scope === "profile" ? !!profile : !!device && (scope !== "gpu" || !!gpu));
  return (
    <Panel title="Hardware profiles and overrides" className="hardware-policy">
      <div style={{ padding: "20px", display: "grid", gap: "16px" }}>
        <p>
          Rules resolve from GPU → device → selected profile → global settings.
          Global limits are inherited settings, not certified limits for H200 or
          other hardware. Set values from your operating requirements.
        </p>
        <ErrorBox message={error} />
        {!policy ? (
          <p>Loading hardware policy…</p>
        ) : (
          <fieldset
            disabled={busy}
            style={{
              border: 0,
              padding: 0,
              margin: 0,
              minWidth: 0,
              display: "grid",
              gap: "16px",
            }}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = newProfile.trim();
                if (!name || policy.profiles[name]) {
                  setError("Choose a new, non-empty profile name.");
                  return;
                }
                const next = structuredClone(policy);
                next.profiles[name] = { metrics: {} };
                void save(next).then(() => {
                  setNewProfile("");
                });
              }}
              style={{
                display: "flex",
                gap: "12px",
                flexWrap: "wrap",
                alignItems: "end",
              }}
            >
              <label style={{ minWidth: 0, maxWidth: "100%" }}>
                New profile name
                <input
                  aria-label="New hardware profile name"
                  maxLength={100}
                  value={newProfile}
                  onChange={(e) => setNewProfile(e.target.value)}
                  required
                />
              </label>
              <button disabled={busy}>Create empty profile</button>
            </form>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ minWidth: 0, maxWidth: "100%" }}>
                Rule scope
                <select
                  style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                  aria-label="Hardware rule scope"
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value);
                    if (e.target.value === "gpu" && !metric.startsWith("gpu."))
                      setMetric("gpu.temp_c");
                  }}
                >
                  <option value="device">Device</option>
                  <option value="gpu">Individual GPU</option>
                  <option value="profile">Profile</option>
                </select>
              </label>
              {scope === "profile" ? (
                <label style={{ minWidth: 0, maxWidth: "100%" }}>
                  Profile
                  <select
                    style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                    aria-label="Hardware profile"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                  >
                    <option value="">Select a profile</option>
                    {Object.keys(policy.profiles).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label style={{ minWidth: 0, maxWidth: "100%" }}>
                  Device
                  <select
                    style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                    aria-label="Hardware policy device"
                    value={deviceId}
                    onChange={(e) => {
                      setDeviceId(e.target.value);
                      setGpu("");
                    }}
                  >
                    <option value="">Select a device</option>
                    {devices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {scope === "gpu" && (
                <label style={{ minWidth: 0, maxWidth: "100%" }}>
                  GPU
                  <select
                    style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                    aria-label="Hardware policy GPU"
                    value={gpu}
                    onChange={(e) => setGpu(e.target.value)}
                  >
                    <option value="">Select a discovered GPU</option>
                    {gpus.map((item) => (
                      <option
                        key={item.uuid || item.id}
                        value={item.uuid || item.id}
                      >
                        {item.name} · {item.uuid || item.id}
                        {item.present === false
                          ? " (not currently present)"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {scope !== "profile" && device && (
              <label style={{ minWidth: 0, maxWidth: "100%" }}>
                Assigned device profile
                <select
                  style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                  aria-label="Assigned device profile"
                  disabled={busy}
                  value={policy.devices[deviceId]?.profile || ""}
                  onChange={(e) => {
                    const next = structuredClone(policy);
                    (next.devices[deviceId] ||= {}).profile = e.target.value;
                    void save(next);
                  }}
                >
                  <option value="">Global settings only</option>
                  {Object.keys(policy.profiles).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            )}
            {scope === "gpu" && device && gpus.length === 0 && (
              <p>
                No stable GPU identity has been discovered. A GPU rule cannot be
                tied to an index.
              </p>
            )}
            <form onSubmit={saveRule} style={{ display: "grid", gap: "12px" }}>
              <label style={{ minWidth: 0, maxWidth: "100%" }}>
                Metric
                <select
                  style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                  aria-label="Hardware rule metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                >
                  {metrics
                    .filter(
                      ([key]) => scope !== "gpu" || key.startsWith("gpu."),
                    )
                    .map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              <label style={{ minWidth: 0, maxWidth: "100%" }}>
                Rule behavior
                <select
                  style={{ maxWidth: "100%", minWidth: 0, width: "100%" }}
                  aria-label="Hardware rule behavior"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="inherit">
                    Inherit (remove this override)
                  </option>
                  <option value="disabled">Disable this alarm rule</option>
                  <option value="custom">Custom thresholds</option>
                </select>
              </label>
              {mode === "custom" && (
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  <label style={{ minWidth: 0, maxWidth: "100%" }}>
                    Warning
                    <input
                      aria-label="Hardware warning threshold"
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={warning}
                      onChange={(e) => setWarning(e.target.value)}
                    />
                  </label>
                  <label style={{ minWidth: 0, maxWidth: "100%" }}>
                    Critical (optional)
                    <input
                      aria-label="Hardware critical threshold"
                      type="number"
                      min="0"
                      step="any"
                      value={critical}
                      onChange={(e) => setCritical(e.target.value)}
                      placeholder="No critical threshold"
                    />
                  </label>
                </div>
              )}
              <button className="primary" disabled={!ready || busy}>
                {busy ? "Saving…" : "Save rule"}
              </button>
            </form>
            {device && scope !== "profile" && (
              <details>
                <summary>Effective rules from the latest device sample</summary>
                <p>
                  Unavailable metrics may have no effective entry. Values below
                  reflect saved rules.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Metric / component</th>
                        <th>Warning</th>
                        <th>Critical</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(effective).map(([key, rule]) => (
                        <tr key={key}>
                          <td style={{ overflowWrap: "anywhere" }}>{key}</td>
                          <td>
                            {rule.source === "unconfigured"
                              ? "Configure a hardware limit"
                              : (rule.thresholds?.[0] ?? "Disabled")}
                          </td>
                          <td>{rule.thresholds?.[1] ?? "—"}</td>
                          <td>{rule.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </fieldset>
        )}
      </div>
    </Panel>
  );
}
