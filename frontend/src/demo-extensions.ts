import type { Device, User, Alert } from "./types";
const viewKey = "sparkscope.demo.views.v1";
const loadViews = (): any[] => {
  try {
    const rows = JSON.parse(localStorage.getItem(viewKey) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};
const persistViews = () => {
  try {
    localStorage.setItem(viewKey, JSON.stringify(views));
  } catch {
    /* Optional demo preferences */
  }
};
const views: any[] = loadViews(),
  channels: any[] = [],
  windows: any[] = [],
  deliveries: any[] = [];
let hardware: any = { profiles: {}, devices: {} };
export function demoExtension(
  route: string,
  method: string,
  body: any,
  query: URLSearchParams,
  user: User,
  devices: Device[],
  alerts: Alert[],
): any {
  const parts = route.split("/").filter(Boolean);
  const id = () => crypto.randomUUID();
  const clone = (v: any) => structuredClone(v);
  const admin = () => {
    if (user.role !== "admin")
      throw Error("Your role does not permit this action");
  };
  if (parts[0] === "views") {
    if (method === "GET")
      return clone(views.filter((v) => v.shared || v.owner_id === user.id));
    const index = views.findIndex((v) => v.id === parts[1]);
    const row = views[index];
    if (
      row &&
      ((row.shared && user.role !== "admin") ||
        (!row.shared && row.owner_id !== user.id))
    )
      throw Error("View access denied");
    if (body.shared) admin();
    if (method === "DELETE") {
      if (index >= 0) views.splice(index, 1);
      persistViews();
      return { ok: true };
    }
    const saved = {
      id: row?.id || id(),
      owner_id: row?.owner_id || user.id,
      ...clone(body),
    };
    if (index >= 0) views[index] = saved;
    else views.push(saved);
    persistViews();
    return clone(saved);
  }
  if (route === "/events")
    return alerts
      .filter(
        (a) =>
          (!query.get("device_id") || a.device_id === query.get("device_id")) &&
          a.first_seen >= Number(query.get("start") || 0) &&
          a.first_seen <= Number(query.get("end") || 1e12),
      )
      .map((a) => ({
        id: "event-" + a.id,
        device_id: a.device_id,
        component_id: null,
        kind: "alarm.open",
        ts: a.first_seen,
        detail: { message: a.message, synthetic: true },
      }));
  if (route === "/diagnostics") {
    admin();
    return {
      ready: true,
      database: true,
      supervision: true,
      maintenance: true,
      notifications: true,
      pending_notifications: 0,
      collector: {},
      synthetic: true,
    };
  }
  if (route === "/settings/hardware") {
    admin();
    if (method === "PUT") hardware = clone(body);
    return clone(hardware);
  }
  if (parts[0] === "devices" && parts[2] === "thresholds") return {};
  if (parts[0] === "notification-channels") {
    admin();
    if (method === "GET") return clone(channels);
    const index = channels.findIndex((c) => c.id === parts[1]);
    const row = channels[index];
    if (parts[2] === "test") {
      if (!row?.enabled) throw Error("Enable channel first");
      deliveries.unshift({
        id: id(),
        event_id: "synthetic-test-" + id(),
        channel_id: row.id,
        status: "simulated",
        attempts: 0,
        next_attempt: Date.now() / 1000,
        error: null,
      });
      return { ok: true };
    }
    if (method === "DELETE") {
      if (index >= 0) channels.splice(index, 1);
      return { ok: true };
    }
    const saved = {
      id: row?.id || id(),
      name: body.name,
      kind: body.kind,
      enabled: body.enabled,
      config: clone(body.config),
      has_secret: !!body.secret || !!row?.has_secret,
    };
    if (index >= 0) channels[index] = saved;
    else channels.push(saved);
    return clone(saved);
  }
  if (route === "/notification-deliveries") {
    admin();
    return clone(deliveries);
  }
  if (parts[0] === "maintenance-windows") {
    if (method === "GET") return clone(windows);
    admin();
    if (method === "DELETE") {
      const w = windows.find((w) => w.id === parts[1]);
      if (w) w.end = Date.now() / 1000;
      return { ok: true };
    }
    const row = {
      id: id(),
      name: body.name,
      start: body.start,
      end: body.end,
      scope: {
        device_ids: body.device_ids,
        group: body.group,
        cluster: body.cluster,
      },
      summarized: false,
    };
    windows.push(row);
    return clone(row);
  }
  return undefined;
}
