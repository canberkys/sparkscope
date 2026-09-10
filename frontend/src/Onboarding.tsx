import { useEffect, useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  ArrowRight,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { api, DEMO } from "./api";
import type { Device, Job } from "./types";
import { Modal, Field, ErrorBox, useFleet } from "./ui";
export default function Onboarding({
  onClose,
  device,
}: {
  onClose: () => void;
  device?: Device;
}) {
  const { refresh, notify, navigate, devices } = useFleet();
  const [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form, setForm] = useState({
    address: device?.address || "",
    port: device?.port || 22,
    username: device?.username || "",
    auth_type: "password",
    password: "",
    private_key: "",
    passphrase: "",
  });
  const [name, setName] = useState(device?.name || ""),
    [group, setGroup] = useState(device?.group || "Default"),
    [cluster, setCluster] = useState(device?.cluster_name || ""),
    [tags, setTags] = useState(device?.tags.join(", ") || "");
  const set = (key: string, v: string | number) =>
    setForm((f) => ({ ...f, [key]: v }));
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let active = true;
    const t = setInterval(async () => {
      try {
        const updated = await api<Job>("/jobs/" + job.id);
        if (active) setJob(updated);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }, 1000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [job?.id, job?.status]);
  async function test(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await api<Job>("/discoveries", "POST", {
        ...form,
        ...(device ? { device_id: device.id } : {}),
      });
      setJob(j);
      setForm((f) => ({ ...f, password: "", private_key: "", passphrase: "" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function trust() {
    setBusy(true);
    setError("");
    try {
      await api("/discoveries/" + job!.id + "/trust", "POST", {
        fingerprint: job!.result.fingerprint,
      });
      setJob((j) => (j ? { ...j, status: "running" } : j));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const d = await api<Device>("/devices", "POST", {
        discovery_id: job!.id,
        cluster_name: cluster,
        name,
        group,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      await refresh();
      notify(device ? "Connection updated" : "Device added to your fleet");
      navigate("devices/" + d.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={device ? "Update connection" : "Add a device"}
      onClose={onClose}
    >
      <div className="steps">
        <span className={!job ? "current" : ""}>1. Connection</span>
        <span className={job?.status === "awaiting_trust" ? "current" : ""}>
          2. Verify host
        </span>
        <span className={job?.status === "complete" ? "current" : ""}>
          3. Review & save
        </span>
      </div>
      {DEMO && (
        <div className="notice">
          Demo connection. Use sample values; do not enter real credentials.
        </div>
      )}
      <ErrorBox message={error} />
      {!job ? (
        <form onSubmit={test}>
          <div className="form-grid">
            <Field label="IP address or hostname">
              <input
                required
                autoFocus
                placeholder="10.20.0.10"
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
            <Field label="SSH port">
              <input
                type="number"
                min="1"
                max="65535"
                required
                value={form.port}
                onChange={(e) => set("port", Number(e.target.value))}
              />
            </Field>
            <Field label="SSH username">
              <input
                required
                autoComplete="off"
                placeholder="operator"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
              />
            </Field>
            <Field label="Authentication">
              <select
                value={form.auth_type}
                onChange={(e) => set("auth_type", e.target.value)}
              >
                <option value="password">Password</option>
                <option value="key">SSH private key</option>
              </select>
            </Field>
          </div>
          {form.auth_type === "password" ? (
            <Field
              label="SSH password"
              hint="Encrypted on the server. Never returned to the browser."
            >
              <input
                type="password"
                autoComplete="new-password"
                disabled={DEMO}
                placeholder={DEMO ? "Not needed in the demo" : ""}
                required={!DEMO}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field label="Private key">
                <textarea
                  required={!DEMO}
                  disabled={DEMO}
                  rows={5}
                  spellCheck={false}
                  value={form.private_key}
                  onChange={(e) => set("private_key", e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
              <Field label="Key passphrase (optional)">
                <input
                  type="password"
                  disabled={DEMO}
                  value={form.passphrase}
                  onChange={(e) => set("passphrase", e.target.value)}
                />
              </Field>
            </>
          )}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <ArrowRight size={16} />
              )}{" "}
              Test connection
            </button>
          </div>
        </form>
      ) : job.status === "awaiting_trust" ? (
        <div className="stack">
          <ShieldCheck size={36} className="accent" />
          <h3>Verify this device’s identity</h3>
          <p>
            Compare this fingerprint with the device’s SSH host key through a
            trusted channel before connecting.
          </p>
          <code className="fingerprint">{job.result.fingerprint}</code>
          <p>
            Target: {String(job.data.address)}:{String(job.data.port)}
          </p>
          <div className="modal-actions">
            <button onClick={() => setJob(null)}>Back</button>
            <button className="primary" disabled={busy} onClick={trust}>
              Trust this host & connect
            </button>
          </div>
        </div>
      ) : job.status === "complete" ? (
        <form onSubmit={save}>
          <div className="discovery-success">
            <CheckCircle2 size={25} />
            <div>
              <strong>Connected successfully</strong>
              <p>
                {job.result.info?.gpu || "System detected"} ·{" "}
                {job.result.info?.os || "OS information unavailable"}
              </p>
            </div>
          </div>
          <div className="discovered-services">
            {job.result.services?.map((s: any, i: number) => (
              <div key={i}>
                <KeyRound size={16} />
                {s.provider} · port {s.port}
                <span>
                  {s.data?.models?.map((m: any) => m.name).join(", ")}
                </span>
              </div>
            ))}
          </div>
          {job.result.info?.warnings?.map((w: string) => (
            <div className="notice" key={w}>
              {w}
            </div>
          ))}
          <Field label="Device name">
            <input
              required
              autoFocus
              placeholder={job.result.info?.hostname || "device-01"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="Group">
              <input
                list="onboarding-groups"
                required
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              />
            </Field>
            <datalist id="onboarding-groups">
              {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <Field label="Tags (comma separated)">
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="production, rack-01"
              />
            </Field>
          </div>
          <Field
            label="Cluster name (optional)"
            hint="Display membership only; no cluster configuration is changed."
          >
            <input
              value={cluster}
              maxLength={80}
              onChange={(e) => setCluster(e.target.value)}
              placeholder="e.g. Inference cluster A"
            />
          </Field>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Save device
            </button>
          </div>
        </form>
      ) : ["failed", "expired", "interrupted"].includes(job.status) ? (
        <div className="stack">
          <ErrorBox
            message={
              job.result.error || "Connection test expired. Start a new test."
            }
          />
          <button
            onClick={() => {
              setJob(null);
              setError("");
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="empty">
          <Loader2 size={30} className="spin accent" />
          <h2>Discovering your device</h2>
          <p>
            Reading hardware and checking for supported LLM services. No
            software is being installed.
          </p>
        </div>
      )}
    </Modal>
  );
}
