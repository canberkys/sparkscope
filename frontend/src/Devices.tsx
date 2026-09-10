import { useEffect, useState } from "react";
import {
  Search,
  List,
  LayoutGrid,
  ArrowUpRight,
  Plus,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { api } from "./api";
import type { Device, Alert } from "./types";
import {
  useFleet,
  value,
  age,
  time,
  Badge,
  Panel,
  Empty,
  Stat,
  Meter,
  Field,
  Modal,
  ErrorBox,
  useQuery,
} from "./ui";
import Onboarding from "./Onboarding";
import PerformanceHistory from "./PerformanceHistory";
const gpuReading = (d: Device, metric: string) => {
  const ids = d.info?.gpus?.filter((g) => g.present !== false) || [];
  return ids.length === 1
    ? d.metrics[`gpu.${ids[0].id}.${metric}`]
    : ids.length
      ? null
      : d.metrics[`gpu.${metric}`];
};
function gpuTemperatureColor(d: Device, alerts: Alert[]) {
  const gpus = d.info?.gpus?.filter((g) => g.present !== false) || [];
  if (gpus.length > 1) return "";
  const metric = gpus.length ? `gpu.${gpus[0].id}.temp_c` : "gpu.temp_c";
  const active = alerts.filter(
    (a) => a.device_id === d.id && a.metric === metric && !a.resolved_at,
  );
  return active.some((a) => a.severity === "critical")
    ? "red"
    : active.some((a) => a.severity === "warning")
      ? "amber"
      : "";
}
export function Devices() {
  const { devices, alerts, navigate, user } = useFleet();
  const initial = new URLSearchParams(location.hash.split("?")[1] || "");
  const [search, setSearch] = useState(initial.get("q") || ""),
    [group, setGroup] = useState(initial.get("group") || ""),
    [status, setStatus] = useState(initial.get("status") || ""),
    [tag, setTag] = useState(initial.get("tag") || ""),
    [sort, setSort] = useState(initial.get("sort") || "name"),
    [view, setView] = useState(
      initial.get("view") === "cards" ? "cards" : "table",
    ),
    [page, setPage] = useState(Math.max(1, Number(initial.get("page")) || 1)),
    [add, setAdd] = useState(false);
  const groups = [...new Set(devices.map((d) => d.group))].sort();
  const tags = [...new Set(devices.flatMap((d) => d.tags))].sort();
  useEffect(() => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (group) p.set("group", group);
    if (status) p.set("status", status);
    if (tag) p.set("tag", tag);
    if (sort !== "name") p.set("sort", sort);
    if (view !== "table") p.set("view", view);
    if (page > 1) p.set("page", String(page));
    history.replaceState(
      null,
      "",
      location.pathname +
        location.search +
        "#/devices" +
        (p.size ? "?" + p : ""),
    );
  }, [search, group, status, tag, sort, view, page]);
  const open = (id: string) =>
    navigate(
      "devices/" + id + "?return=" + encodeURIComponent(location.hash.slice(2)),
    );
  const priority = (d: Device) => {
    const events = alerts.filter((a) => a.device_id === d.id && !a.resolved_at);
    return events.some((a) => a.severity === "critical")
      ? 0
      : events.length
        ? 1
        : d.paused
          ? 4
          : d.stale || d.status !== "online"
            ? 2
            : 3;
  };
  const filtered = devices
    .filter(
      (d) =>
        (!search ||
          `${d.name} ${d.address} ${d.tags.join(" ")} ${d.info?.hostname || ""} ${d.info?.gpu || ""} ${d.info?.gpus?.map((g) => g.name).join(" ") || ""}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (!group || d.group === group) &&
        (!status || d.status === status) &&
        (!tag || d.tags.includes(tag)),
    )
    .sort((a, b) =>
      sort === "gpu"
        ? (gpuReading(b, "util_pct") ?? -1) - (gpuReading(a, "util_pct") ?? -1)
        : sort === "status"
          ? priority(a) - priority(b) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
    );
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const shown = filtered.slice(
    (Math.min(page, pages) - 1) * 25,
    Math.min(page, pages) * 25,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR FLEET</div>
          <h1>
            Devices <span className="count">{devices.length}</span>
          </h1>
          <p>Monitor, organize and connect your Linux devices.</p>
        </div>
        {user.role === "admin" && (
          <button className="primary" onClick={() => setAdd(true)}>
            <Plus size={17} />
            Add device
          </button>
        )}
      </div>
      <div className="filters">
        <div className="search">
          <Search size={18} />
          <input
            aria-label="Search devices"
            placeholder="Search name, IP, tag or GPU…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          aria-label="Filter by group"
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {["online", "degraded", "offline", "paused"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="Filter by tag"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select
          aria-label="Sort devices"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
        >
          <option value="name">Name A–Z</option>
          <option value="gpu">GPU usage</option>
          <option value="status">Operational priority</option>
        </select>
        <div className="segmented">
          <button
            aria-label="Table view"
            className={view === "table" ? "selected" : ""}
            onClick={() => setView("table")}
          >
            <List size={18} />
          </button>
          <button
            aria-label="Card view"
            className={view === "cards" ? "selected" : ""}
            onClick={() => setView("cards")}
          >
            <LayoutGrid size={18} />
          </button>
        </div>
      </div>
      {!shown.length ? (
        <Panel>
          <Empty
            title={
              devices.length ? "No matching devices" : "Your fleet starts here"
            }
            text={
              devices.length
                ? "Try changing your search or filters."
                : "Add your first device to discover its hardware and running models."
            }
            action={
              user.role === "admin" && !devices.length ? (
                <button className="primary" onClick={() => setAdd(true)}>
                  Add your first device
                </button>
              ) : undefined
            }
          />
        </Panel>
      ) : view === "table" ? (
        <Panel>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Group</th>
                  <th>GPU usage</th>
                  <th>Memory</th>
                  <th>GPU temp</th>
                  <th>Last seen</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button
                        className="text-button device-name"
                        onClick={() => open(d.id)}
                      >
                        {d.name}
                      </button>
                      <small className="mono muted">{d.address}</small>
                    </td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td>{d.group}</td>
                    <td className={d.stale ? "stale" : ""}>
                      {value(gpuReading(d, "util_pct"), "%")}
                      <Meter v={gpuReading(d, "util_pct")} />
                    </td>
                    <td className={d.stale ? "stale" : ""}>
                      {value(d.metrics["memory.used_pct"], "%")}
                      <Meter v={d.metrics["memory.used_pct"]} color="blue" />
                    </td>
                    <td
                      className={`${gpuTemperatureColor(d, alerts)} ${d.stale ? "stale" : ""}`}
                    >
                      {value(gpuReading(d, "temp_c"), "°C")}
                    </td>
                    <td className="muted">{age(d.last_seen)}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open ${d.name}`}
                        onClick={() => open(d.id)}
                      >
                        <ArrowUpRight size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        <div className="device-cards">
          {shown.map((d) => (
            <button
              className="device-card panel"
              key={d.id}
              onClick={() => open(d.id)}
            >
              <div>
                <strong>{d.name}</strong>
                <Badge status={d.status} />
              </div>
              <p className="mono">
                {d.address} · {d.group}
              </p>
              <div className="card-metrics">
                <span>
                  GPU<strong>{value(gpuReading(d, "util_pct"), "%")}</strong>
                </span>
                <span>
                  Memory
                  <strong>{value(d.metrics["memory.used_pct"], "%")}</strong>
                </span>
                <span>
                  Temp<strong>{value(gpuReading(d, "temp_c"), "°C")}</strong>
                </span>
              </div>
              <Meter v={gpuReading(d, "util_pct")} />
              <small>{age(d.last_seen)}</small>
            </button>
          ))}
        </div>
      )}
      <div className="pagination">
        <span>
          {filtered.length} devices · page {Math.min(page, pages)} of {pages}
        </span>
        <div>
          <button
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {add && <Onboarding onClose={() => setAdd(false)} />}
    </>
  );
}
export function DeviceDetail({ id }: { id: string }) {
  const { user, alerts, notify, refresh, navigate } = useFleet();
  const { data: d, error, reload } = useQuery<Device>("/devices/" + id, 5000);
  const [connection, setConnection] = useState(false),
    [edit, setEdit] = useState(false),
    [endpoint, setEndpoint] = useState(false);
  async function rediscover() {
    try {
      await api("/devices/" + id + "/rediscover", "POST", {});
      notify("Rediscovery started. Follow its result in Operations.");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  if (error) return <ErrorBox message={error} />;
  if (!d) return <div className="empty">Loading device…</div>;
  return (
    <>
      <button
        className="back text-button"
        onClick={() => {
          const back = new URLSearchParams(
            location.hash.split("?")[1] || "",
          ).get("return");
          navigate(
            back?.startsWith("devices?") || back === "devices"
              ? back
              : "devices",
          );
        }}
      >
        <ChevronLeft size={16} />
        All devices
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{d.group} / DEVICE DETAIL</div>
          <h1>
            {d.name} <Badge status={d.status} />
          </h1>
          <p>
            <span className="mono">
              {d.address}:{d.port}
            </span>{" "}
            · Last seen {age(d.last_seen)}
          </p>
        </div>
        {user.role === "admin" && (
          <div className="actions">
            <button onClick={() => setEdit(true)}>
              <SlidersHorizontal size={16} />
              Edit device
            </button>
            <button onClick={() => setConnection(true)}>
              Update connection
            </button>
          </div>
        )}
      </div>
      {(d.error || d.stale) && (
        <div className="notice">
          {d.error ||
            "Measurements are stale. Values below show the last successful sample."}
        </div>
      )}
      {!d.host_key_verified && (
        <div className="notice">
          SSH identity needs verification. Use Update connection to complete a
          connection test.
        </div>
      )}
      <div className="stats">
        <Stat
          label="GPU utilization"
          number={value(gpuReading(d, "util_pct"), "%")}
          detail={d.info?.gpu || "GPU telemetry unavailable"}
        />
        <Stat
          label="CPU utilization"
          number={value(d.metrics["cpu.usage_pct"], "%")}
          detail={`${value(d.metrics["cpu.temp_max_c"], "°C")} temperature`}
        />
        <Stat
          label="Memory used"
          number={value(d.metrics["memory.used_pct"], "%")}
          detail={`${value(d.metrics["memory.total_kb"] ? d.metrics["memory.total_kb"] / 1048576 : null, " GiB")} system memory`}
        />
        <Stat
          label="GPU temperature"
          number={value(gpuReading(d, "temp_c"), "°C")}
          color={`${gpuTemperatureColor(d, alerts)} ${d.stale ? "stale" : ""}`}
          detail={`${value(gpuReading(d, "power_draw_w"), " W")} power draw`}
        />
      </div>
      {d.info?.gpus?.length ? (
        <Panel title="GPU inventory">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>GPU</th>
                  <th>Identity</th>
                  <th>Utilization</th>
                  <th>Memory used / total</th>
                  <th>Temperature</th>
                  <th>Power</th>
                </tr>
              </thead>
              <tbody>
                {d.info.gpus.map((g) => (
                  <tr
                    key={g.id}
                    className={d.stale || g.present === false ? "stale" : ""}
                  >
                    <td>
                      {g.name} · GPU {g.index}
                      {g.present === false ? " · Not currently present" : ""}
                    </td>
                    <td className="mono">{g.id}</td>
                    <td>{value(d.metrics[`gpu.${g.id}.util_pct`], "%")}</td>
                    <td>
                      {value(d.metrics[`gpu.${g.id}.mem_used_mb`], " MiB")} /{" "}
                      {value(g.memory_total_mb, " MiB")}
                    </td>
                    <td>{value(d.metrics[`gpu.${g.id}.temp_c`], "°C")}</td>
                    <td>
                      {value(d.metrics[`gpu.${g.id}.power_draw_w`], " W")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="inline-note">
            {d.info.memory_model === "unified"
              ? "Unified CPU/GPU memory; reported GPU allocations are not an additional memory pool."
              : "GPU memory is separate from system RAM."}
          </p>
        </Panel>
      ) : null}
      {d.info?.capability_status && (
        <p className="inline-note">
          {Object.entries(d.info.capability_status)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}{" "}
          · Hardware checked {age(d.info.hardware_checked_at ?? null)}
        </p>
      )}
      <PerformanceHistory key={id} device={d} />
      <div className="two-col section-gap">
        <Panel title="Hardware & connection">
          <dl className="info-list">
            {Object.entries({
              Hostname: d.info?.hostname,
              "Operating system": d.info?.os,
              Kernel: d.info?.kernel,
              GPU: d.info?.gpu,
              "SSH user": d.username,
              "Disk usage": value(d.metrics["disk.root_used_pct"], "%"),
              "SMART temperature": value(d.metrics["nvme.temp_c"], "°C"),
              Tags: d.tags.join(", ") || "No tags",
            }).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v || "N/A"}</dd>
              </div>
            ))}
          </dl>
          {d.smart?.error && <p className="inline-note">{d.smart.error}</p>}
          {d.info?.warnings?.map((w) => (
            <p className="inline-note" key={w}>
              {w}
            </p>
          ))}
        </Panel>
        <Panel
          title="Models & services"
          action={
            user.role === "admin" ? (
              <div className="actions">
                <button
                  className="icon-button"
                  aria-label="Rediscover services"
                  onClick={rediscover}
                >
                  <RefreshCw size={16} />
                </button>
                <button onClick={() => setEndpoint(true)}>
                  <Plus size={15} />
                  Endpoint
                </button>
              </div>
            ) : undefined
          }
        >
          {d.services?.length ? (
            <div className="service-list">
              {d.services.map((s) => (
                <div key={s.id}>
                  <div className="row-between">
                    <strong>
                      {s.provider}{" "}
                      <small className="muted">
                        :{s.port}
                        {s.path}
                      </small>
                    </strong>
                    <Badge status={s.status} />
                  </div>
                  {s.models?.map((m) => (
                    <div className="model-line" key={m.name}>
                      <span>{m.name}</span>
                      <small>{m.state}</small>
                    </div>
                  ))}
                  <p>
                    {value(s.metrics?.gen_tokens_per_s, " tok/s", 1)} ·{" "}
                    {value(s.metrics?.requests_running)} running requests
                  </p>
                  {s.warnings?.map((w) => (
                    <small className="muted" key={w}>
                      {w}
                    </small>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No services discovered"
              text="Add a local endpoint or rediscover after starting a supported runtime."
            />
          )}
        </Panel>
      </div>
      <Panel className="section-gap" title="Processes">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>User</th>
                <th>CPU</th>
                <th>Memory</th>
              </tr>
            </thead>
            <tbody>
              {d.top_procs?.map((p) => (
                <tr key={p.pid}>
                  <td className="mono">{p.pid}</td>
                  <td>{p.command}</td>
                  <td>{p.user}</td>
                  <td>{value(p.cpu_pct, "%")}</td>
                  <td>{value(p.mem_pct, "%")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.top_procs?.length && (
            <div className="inline-note">Process data unavailable.</div>
          )}
        </div>
      </Panel>
      {connection && (
        <Onboarding
          device={d}
          onClose={() => {
            setConnection(false);
            reload();
          }}
        />
      )}
      {edit && (
        <EditDevice
          device={d}
          onClose={() => {
            setEdit(false);
            reload();
            void refresh();
          }}
        />
      )}
      {endpoint && (
        <Endpoint
          device={d}
          onClose={() => {
            setEndpoint(false);
            reload();
            void refresh();
          }}
        />
      )}
    </>
  );
}
function EditDevice({
  device: d,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  const { notify, devices } = useFleet();
  const [peer, setPeer] = useState(d.info?.cluster_peer_ip || ""),
    [name, setName] = useState(d.name),
    [group, setGroup] = useState(d.group),
    [cluster, setCluster] = useState(d.cluster_name || ""),
    [tags, setTags] = useState(d.tags.join(", ")),
    [paused, setPaused] = useState(d.paused),
    [archived, setArchived] = useState(d.archived),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Edit device" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/devices/" + d.id, "PATCH", {
              name,
              group,
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              paused,
              archived,
              cluster_peer_ip: peer,
              cluster_name: cluster,
            });
            notify("Device updated");
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox message={error} />
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Group">
          <input
            list="edit-device-groups"
            required
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
        </Field>
        <datalist id="edit-device-groups">
          {[...new Set(devices.map((d) => d.group))].sort().map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <Field label="Tags">
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field
          label="Cluster name (optional)"
          hint="Explicit membership for the monitor view. This does not configure or verify a distributed cluster."
        >
          <input
            maxLength={80}
            value={cluster}
            onChange={(e) => setCluster(e.target.value)}
            placeholder="e.g. Inference cluster A"
          />
        </Field>
        <Field
          label="Cluster peer IP (optional)"
          hint="Used by the Ping Cluster Peer command."
        >
          <input
            value={peer}
            onChange={(e) => setPeer(e.target.value)}
            placeholder="192.168.100.11"
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
          />
          Pause monitoring
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archive device (keep history)
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Endpoint({
  device,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  const { notify } = useFleet();
  const [provider, setProvider] = useState("vllm"),
    [port, setPort] = useState(8000),
    [path, setPath] = useState(""),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Add or update a service endpoint" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/devices/${device.id}/services`, "POST", {
              provider,
              port,
              path,
              api_key: key,
            });
            notify(
              "Endpoint saved; metrics will appear after the next collection.",
            );
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Connect to a service on this device’s localhost through SSH. Saving
          the same port and path updates its credentials.
        </p>
        <ErrorBox message={error} />
        <Field label="Runtime">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setPort(
                e.target.value === "ollama"
                  ? 11434
                  : e.target.value === "vllm"
                    ? 8000
                    : 8080,
              );
            }}
          >
            <option>vllm</option>
            <option>ollama</option>
            <option>llama.cpp</option>
          </select>
        </Field>
        <Field label="Port">
          <input
            type="number"
            min="1"
            max="65535"
            required
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </Field>
        <Field label="Base path (optional)">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/inference"
          />
        </Field>
        <Field
          label="API key (optional)"
          hint="Leave empty for no authentication; this clears any saved key at the same endpoint."
        >
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save endpoint
          </button>
        </div>
      </form>
    </Modal>
  );
}
