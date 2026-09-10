import { demoExtension } from "./demo-extensions";
import { demoHistory } from "./demo-history";
import type {
  Device,
  Service,
  Alert,
  Job,
  Command,
  Preferences,
  User,
} from "./types";
const q = new URLSearchParams(location.search),
  count = Math.max(0, Math.min(50, Number(q.get("hosts") ?? 2))),
  scenario = q.get("scenario") || "mixed";
const start = Date.now() / 1000;
const now = () => Date.now() / 1000;
const id = () => crypto.randomUUID();
let user: User = {
  id: "demo-admin",
  username: "operator",
  role: (q.get("role") as User["role"]) || "admin",
  active: true,
};
const users = [user];
let devices: Device[] = Array.from(
  { length: scenario === "empty" ? 0 : count },
  (_, i) => ({
    id: `node-${i + 1}`,
    name: `GB10-${String(i + 1).padStart(2, "0")}`,
    address: `10.20.${Math.floor(i / 20)}.${(i % 20) + 10}`,
    port: 22,
    username: "operator",
    group: ["Inference", "Research", "Development"][i % 3],
    cluster_name:
      i < 2 ? "Inference cluster A" : i < 5 ? "Research cluster B" : "",
    tags: i % 2 ? ["lab"] : ["production"],
    status: scenario === "offline" || i % 13 === 12 ? "offline" : "online",
    paused: false,
    archived: false,
    last_seen: start,
    stale: false,
    metrics: {},
    error: null,
    host_key_verified: true,
    created_at: start - 86400 * (i + 1),
    revision: 1,
    info: {
      hostname: `gb10-${i + 1}`,
      os: "Ubuntu 24.04 LTS · DGX OS",
      kernel: "6.14.0-nvidia",
      gpu: "NVIDIA GB10",
      warnings: [],
      interfaces: ["enp1s0f0np0", "wlP9s9"],
    },
    gpu_procs: [],
    top_procs: [
      {
        pid: 2714,
        user: "operator",
        cpu_pct: 12.4,
        mem_pct: 4.2,
        command: "vllm",
      },
    ],
  }),
);
if (q.get("hardware") === "mixed")
  devices = devices.map((d, i) => ({
    ...d,
    name:
      i % 4 === 0
        ? d.name
        : i % 4 === 1
          ? `GPU-server-${i + 1}`
          : i % 4 === 2
            ? `CPU-server-${i + 1}`
            : `Multi-GPU-${i + 1}`,
    info: {
      ...d.info,
      os: i % 4 === 0 ? d.info?.os : "Ubuntu 24.04 LTS",
      gpu:
        i % 4 === 0
          ? "NVIDIA GB10"
          : i % 4 === 1
            ? "NVIDIA RTX 4090"
            : i % 4 === 2
              ? ""
              : "2 × NVIDIA H200",
      gpu_count: i % 4 === 2 ? 0 : i % 4 === 3 ? 2 : 1,
      capabilities: { system: true, gpu: i % 4 !== 2 },
      gpus:
        i % 4 === 2
          ? []
          : Array.from({ length: i % 4 === 3 ? 2 : 1 }, (_, gpu) => ({
              id: `GPU-demo-${i + 1}-${gpu}`,
              uuid: `GPU-demo-${i + 1}-${gpu}`,
              index: gpu,
              name:
                i % 4 === 0
                  ? "NVIDIA GB10"
                  : i % 4 === 1
                    ? "NVIDIA RTX 4090"
                    : "NVIDIA H200",
              present: true,
              last_seen: start,
            })),
    },
  }));
let services: Service[] = devices
  .filter((_, i) => i % 3 !== 2)
  .map((d, i) => ({
    id: `service-${d.id}`,
    device_id: d.id,
    provider: ["vllm", "ollama", "llama.cpp"][i % 3],
    port: [8000, 11434, 8080][i % 3],
    path: "",
    manual: false,
    has_api_key: false,
    last_seen: start,
    status: "online",
    models: [
      {
        name: ["Qwen3-32B", "llama3.3:70b", "DeepSeek-R1-Distill-32B"][i % 3],
        state: i % 3 === 1 ? "loaded" : "serving",
        context_length: 32768,
      },
    ],
    metrics:
      i % 3 === 1
        ? {}
        : {
            gen_tokens_per_s: 35 + i * 2,
            prompt_tokens_per_s: 70 + i * 2,
            requests_running: 2 + (i % 3),
            requests_waiting: 0,
            ...(i % 3 === 0 ? { kv_cache_pct: 30 + (i % 20) } : {}),
          },
    supported_metrics:
      i % 3 === 1
        ? []
        : [
            "gen_tokens_per_s",
            "prompt_tokens_per_s",
            "requests_running",
            "requests_waiting",
            ...(i % 3 === 0 ? ["kv_cache_pct"] : []),
          ],
    warnings: [],
  }));
const alerts: Alert[] = [];
if (devices.length && scenario !== "healthy" && scenario !== "empty")
  alerts.push({
    id: "alert-1",
    device_id: devices[0].id,
    metric: "gpu.temp_c",
    severity: "critical",
    message: "GPU temperature is above the 90°C critical threshold.",
    first_seen: start - 420,
    last_seen: start,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    occurrences: 84,
  });
const jobs: Job[] = [];
const proofs = new Map<string, string>();
const commands: Command[] = [
  ["uptime", "Show uptime", "System", false],
  ["kernel_info", "Kernel information", "System", false],
  ["reboot", "Reboot", "System", true],
  ["shutdown", "Shut down", "System", true],
  ["nvidia_smi_full", "GPU status", "GPU", false],
  ["gpu_reset", "Reset GPU", "GPU", true],
  ["interface_status", "Network interfaces", "Network", false],
  ["dmesg_tail", "Kernel logs", "Logs", false],
  ["apt_update", "Refresh package indexes", "Package", true],
  ["apt_upgrade", "Upgrade packages", "Package", true],
].map(([key, label, category, destructive]) => ({
  key: String(key),
  label: String(label),
  category: String(category),
  destructive: Boolean(destructive),
  confirmation_text: `Run ${label} on the selected devices?`,
  timeout_seconds: category === "Package" ? 1800 : 30,
}));
let preferences: Preferences = {
  thresholds: {
    "cpu.temp_max_c": [75, 85],
    "gpu.temp_c": [80, 90],
    "gpu.power_draw_w": [200, null],
    "disk.root_used_pct": [80, 95],
    "memory.used_pct": [90, null],
    "gpu.ecc_uncorrected": [1, 1],
    "gpu.throttle_active": [1, null],
  },
  groups: ["Default", "Inference", "Research", "Development"],
  retention: {
    raw_hours: 24,
    minute_days: 7,
    quarter_days: 90,
    event_days: 90,
  },
  collector: { polls: 15042, failures: 3, last_maintenance: start },
  poll_seconds: 5,
  database: "Demo · in-memory",
};
function tick() {
  const t = now() - start;
  devices = devices.map((d, i) => {
    if (d.paused || d.archived) return d;
    const offline = scenario === "offline" || i % 13 === 12;
    if (offline && Object.keys(d.metrics).length) return d;
    const w = (Math.sin(t / 16 + i) + 1) / 2;
    const sample: Device = {
      ...d,
      status: offline
        ? "offline"
        : i === 0 && alerts.some((a) => !a.resolved_at)
          ? "degraded"
          : "online",
      last_seen: offline ? start - 180 : now(),
      stale: offline,
      error: offline
        ? "SSH connection timed out. Retrying automatically."
        : null,
      metrics: {
        "cpu.usage_pct": 15 + w * 35,
        "cpu.temp_max_c": 48 + w * 12,
        "gpu.util_pct": 35 + w * 55,
        "gpu.temp_c":
          i === 0 && alerts.some((a) => !a.resolved_at) ? 92 : 48 + w * 16,
        "gpu.power_draw_w": 45 + w * 85,
        "memory.total_kb": 128 * 1048576,
        "memory.available_kb": (60 - w * 28) * 1048576,
        "memory.used_pct": 53 + w * 22,
        "disk.root_used_pct": 28 + (i % 40),
        "disk.read_mbps": w * 64,
        "disk.write_mbps": w * 16,
        "system.uptime_seconds": 86400 * 8 + t,
        "nvme.temp_c": 41,
        "nvme.used_pct": 2,
        "network.enp1s0f0np0_rx_mbps": w * 580,
        "network.enp1s0f0np0_tx_mbps": w * 360,
        "network.wlP9s9_rx_mbps": w * 4,
        "network.wlP9s9_tx_mbps": w * 2,
      },
    };
    if (q.get("hardware") === "mixed") {
      if (i % 4 === 2)
        for (const key of Object.keys(sample.metrics)) {
          if (key.startsWith("gpu.")) delete sample.metrics[key];
        }
      if (i % 4 === 1)
        Object.assign(sample.metrics, {
          "gpu.mem_total_mb": 24576,
          "gpu.mem_used_mb": 12288,
          "gpu.mem_free_mb": 12288,
        });
      if (i % 4 < 2) {
        for (const key of Object.keys(sample.metrics))
          if (key.startsWith("gpu.")) {
            sample.metrics[`gpu.GPU-demo-${i + 1}-0.${key.slice(4)}`] =
              sample.metrics[key];
            delete sample.metrics[key];
          }
      }
      if (i % 4 === 3) {
        for (const key of Object.keys(sample.metrics))
          if (key.startsWith("gpu.")) delete sample.metrics[key];
        for (const gpu of [0, 1])
          Object.assign(sample.metrics, {
            [`gpu.GPU-demo-${i + 1}-${gpu}.util_pct`]: 25 + w * 40 + gpu * 15,
            [`gpu.GPU-demo-${i + 1}-${gpu}.temp_c`]: 45 + w * 15 + gpu * 5,
            [`gpu.GPU-demo-${i + 1}-${gpu}.mem_total_mb`]: 141000,
            [`gpu.GPU-demo-${i + 1}-${gpu}.mem_used_mb`]: 8192 + gpu * 4096,
          });
      }
    }
    return sample;
  });
  services = services.map((s, i) => {
    const device = devices.find((d) => d.id === s.device_id);
    if (!device || device.stale || device.paused)
      return {
        ...s,
        status: "unavailable",
        last_seen: Math.min(s.last_seen || start, device?.last_seen || start),
      };
    return {
      ...s,
      status: "online",
      last_seen: now(),
      metrics:
        s.provider === "ollama"
          ? {}
          : { ...s.metrics, gen_tokens_per_s: 40 + Math.sin(t / 10 + i) * 12 },
    };
  });
}
tick();
export function subscribe(fn: (message: any) => void) {
  const send = () => {
    tick();
    fn({
      type: "snapshot",
      devices: devices.filter((d) => !d.archived),
      removed: [],
      alerts: alerts.filter((a) => !a.resolved_at),
      ts: now(),
    });
  };
  send();
  const t = setInterval(send, 2000);
  return () => clearInterval(t);
}
export async function request(
  path: string,
  method = "GET",
  body: any = {},
): Promise<any> {
  const [route, query = ""] = path.split("?");
  const p = new URLSearchParams(query);
  const parts = route.split("/").filter(Boolean);
  const extension = demoExtension(
    route,
    method,
    body,
    p,
    user,
    devices,
    alerts,
  );
  if (extension !== undefined) return extension;
  if (route === "/auth/status") return { setup_required: false };
  if (
    route === "/auth/me" ||
    route === "/auth/login" ||
    route === "/auth/setup"
  )
    return { user, csrf: "demo" };
  if (route === "/auth/logout") return { ok: true };
  if (route === "/devices" && method === "GET")
    return structuredClone(
      devices.filter((d) => d.archived === (p.get("archived") === "true")),
    );
  if (parts[0] === "devices" && parts.length === 2) {
    const d = devices.find((d) => d.id === parts[1]);
    if (!d) throw Error("Device not found");
    if (method === "PATCH") {
      Object.assign(d, body);
      return structuredClone(d);
    }
    return structuredClone({
      ...d,
      services: services.filter((s) => s.device_id === d.id),
    });
  }
  if (route === "/discoveries" && method === "POST") {
    const job: Job = {
      id: id(),
      kind: "discovery",
      status: "awaiting_trust",
      created_at: now(),
      updated_at: now(),
      data: {
        address: body.address,
        port: body.port,
        username: body.username,
        device_id: body.device_id,
      },
      result: {
        fingerprint: "SHA256:DEMO-FINGERPRINT-NO-REAL-CONNECTION",
        host_key: "demo",
      },
    };
    jobs.unshift(job);
    return structuredClone(job);
  }
  if (parts[0] === "discoveries" && parts[2] === "trust") {
    const job = jobs.find((j) => j.id === parts[1])!;
    job.status = "running";
    setTimeout(() => {
      job.status = "complete";
      job.result = {
        ...job.result,
        info: {
          hostname: "gb10-new",
          os: "Ubuntu 24.04 LTS",
          gpu: "NVIDIA GB10",
          warnings: [],
        },
        services: [
          {
            provider: "vllm",
            port: 8000,
            data: { models: [{ name: "Qwen3-32B", state: "serving" }] },
          },
        ],
      };
    }, 600);
    return { id: job.id, status: "running" };
  }
  if (route === "/devices" && method === "POST") {
    const j = jobs.find((j) => j.id === body.discovery_id)!;
    let d = devices.find((d) => d.id === j.data.device_id);
    if (!d) {
      d = {
        id: id(),
        name: body.name,
        address: String(j.data.address),
        port: Number(j.data.port),
        username: String(j.data.username),
        group: body.group,
        cluster_name: (body.cluster_name || "").trim(),
        tags: body.tags,
        status: "online",
        paused: false,
        archived: false,
        last_seen: now(),
        stale: false,
        metrics: {},
        error: null,
        host_key_verified: true,
        created_at: now(),
        revision: 1,
        info: j.result.info,
      };
      devices.push(d);
    } else
      Object.assign(d, {
        name: body.name,
        address: j.data.address,
        group: body.group,
        cluster_name: (body.cluster_name || "").trim(),
        tags: body.tags,
      });
    j.status = "saved";
    return structuredClone(d);
  }
  if (parts[0] === "devices" && parts[2] === "rediscover") {
    const j: Job = {
      id: id(),
      kind: "rediscovery",
      status: "complete",
      created_at: now(),
      updated_at: now(),
      data: { device_id: parts[1] },
      result: { message: "Service discovery completed" },
    };
    jobs.unshift(j);
    return j;
  }
  if (parts[0] === "devices" && parts[2] === "services") {
    const s: Service = {
      id: id(),
      device_id: parts[1],
      provider: body.provider,
      port: body.port,
      path: body.path,
      manual: true,
      has_api_key: Boolean(body.api_key),
      status: "online",
      last_seen: now(),
      models: [{ name: "Demo model", state: "serving" }],
      metrics: {},
      warnings: [],
    };
    services.push(s);
    return s;
  }
  if (route === "/services")
    return structuredClone(
      services.filter((s) =>
        devices.some((d) => d.id === s.device_id && !d.archived),
      ),
    );
  if (route === "/history") {
    const device = devices.find((d) => d.id === p.get("device_id"));
    if (!device) return [];
    return demoHistory(
      device,
      services.filter((s) => s.device_id === device.id),
      p,
      q.get("history") || "mixed",
    );
  }
  if (route === "/alerts") return structuredClone(alerts);
  if (parts[0] === "alerts" && parts[2] === "acknowledge") {
    const a = alerts.find((a) => a.id === parts[1])!;
    a.acknowledged_at = now();
    a.acknowledged_by = user.username;
    return { ok: true };
  }
  if (route === "/commands") return commands;
  if (route === "/operations/confirmations") {
    const key = id();
    proofs.set(key, JSON.stringify(body));
    return { confirmation: key, expires_in: 120 };
  }
  if (route === "/operations") {
    const j: Job = {
      id: id(),
      kind: "command",
      status: "running",
      created_at: now(),
      updated_at: now(),
      data: { command: body.command, device_ids: body.device_ids },
      result: {},
    };
    jobs.unshift(j);
    setTimeout(() => {
      j.status = scenario === "failure" ? "failed" : "complete";
      j.updated_at = now();
      j.result = Object.fromEntries(
        body.device_ids.map((d: string) => [
          d,
          {
            exit_code: scenario === "failure" ? 1 : 0,
            stdout: `[DEMO] ${body.command} completed. No remote command was sent.`,
            stderr: scenario === "failure" ? "Simulated permission denied" : "",
            duration_ms: 800,
            timed_out: false,
          },
        ]),
      );
    }, 800);
    return structuredClone(j);
  }
  if (route === "/jobs")
    return structuredClone(jobs.filter((j) => j.kind !== "discovery"));
  if (parts[0] === "jobs")
    return structuredClone(jobs.find((j) => j.id === parts[1]));
  if (route === "/settings") return structuredClone(preferences);
  if (parts[0] === "settings" && method === "PUT") {
    if (parts[1] === "groups") preferences.groups = body.names;
    else (preferences as any)[parts[1]] = body;
    return body;
  }
  if (route === "/users" && method === "GET") return structuredClone(users);
  if (route === "/users" && method === "POST") {
    const u: User = {
      id: id(),
      username: body.username,
      role: body.role,
      active: true,
    };
    users.push(u);
    return u;
  }
  if (parts[0] === "users" && method === "PATCH") {
    const u = users.find((u) => u.id === parts[1])!;
    u.role = body.role;
    u.active = body.active;
    return u;
  }
  if (route === "/audit")
    return [
      {
        id: 1,
        ts: start,
        actor: "operator",
        action: "demo.start",
        target: "fleet",
        detail: { devices: count },
      },
    ];
  throw Error("This action is not available in the demo.");
}
