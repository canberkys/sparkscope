export type Metrics = Record<string, number | null>;
export type User = {
  id: string;
  username: string;
  role: "viewer" | "operator" | "admin";
  active: boolean;
};
export type Device = {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  cluster_name?: string;
  tags: string[];
  status: string;
  paused: boolean;
  archived: boolean;
  last_seen: number | null;
  stale: boolean;
  metrics: Metrics;
  error: string | null;
  host_key_verified: boolean;
  created_at: number;
  revision: number;
  info?: {
    cluster_peer_ip?: string;
    capabilities?: { system?: boolean; gpu?: boolean };
    gpu_count?: number;
    gpus?: {
      id: string;
      uuid?: string;
      index: number;
      name: string;
      driver?: string;
      memory_total_mb?: number | null;
      last_seen?: number;
      present?: boolean;
    }[];
    memory_model?: string;
    capability_status?: Record<string, string>;
    capability_details?: Record<string, string>;
    hardware_checked_at?: number;
    disks?: { name: string; size: number; type: string }[];
    hostname?: string;
    kernel?: string;
    os?: string;
    gpu?: string;
    warnings?: string[];
    interfaces?: string[];
  };
  smart?: { available?: boolean; error?: string; ts?: number };
  gpu_procs?: { pid: number; name: string; mem_mb: number | null }[];
  top_procs?: {
    pid: number;
    user: string;
    cpu_pct: number;
    mem_pct: number;
    command: string;
  }[];
  services?: Service[];
};
export type Service = {
  id: string;
  device_id: string;
  provider: string;
  port: number;
  path: string;
  manual: boolean;
  has_api_key: boolean;
  last_seen: number | null;
  status: string;
  models: {
    name: string;
    state: string;
    context_length?: number;
    size_bytes?: number;
  }[];
  metrics: Metrics;
  supported_metrics?: string[];
  warnings: string[];
};
export type Alert = {
  component_id?: string | null;
  id: string;
  device_id: string;
  metric: string;
  severity: string;
  message: string;
  first_seen: number;
  last_seen: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  resolved_at: number | null;
  occurrences: number;
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  created_at: number;
  updated_at: number;
  data: Record<string, unknown>;
  result: Record<string, any>;
};
export type Command = {
  key: string;
  label: string;
  category: string;
  destructive: boolean;
  confirmation_text: string;
  timeout_seconds: number;
};
export type Point = {
  ts: number;
  value: number;
  min: number;
  max: number;
  count: number;
  bucket_seconds: number;
  last_sample_ts: number | null;
};
export type Preferences = {
  thresholds: Record<string, [number, number | null]>;
  groups: string[];
  retention: {
    raw_hours: number;
    minute_days: number;
    quarter_days: number;
    event_days: number;
  };
  collector: Record<string, number | null>;
  poll_seconds: number;
  database: string;
};
export type Audit = {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
};
