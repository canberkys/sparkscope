import type { Device, Alert } from "./types";
export const DEMO =
  import.meta.env.MODE === "demo" ||
  (import.meta.env.DEV &&
    new URLSearchParams(location.search).get("demo") === "1");
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (DEMO) {
    const { request } = await import("./demo");
    return request(path, method, body);
  }
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response
    .json()
    .catch(() => ({ detail: "The server returned an unreadable response." }));
  if (!response.ok)
    throw new APIError(
      typeof result.detail === "string" ? result.detail : "The request failed.",
      response.status,
    );
  return result;
}
export function subscribe(
  onMessage: (message: {
    type: string;
    devices: Device[];
    removed: string[];
    alerts: Alert[];
    ts: number;
  }) => void,
  onStatus: (connected: boolean) => void,
) {
  let stopped = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout>;
  let off: (() => void) | undefined;
  if (DEMO) {
    import("./demo").then((m) => {
      if (!stopped) {
        off = m.subscribe(onMessage);
        onStatus(true);
      }
    });
    return () => {
      stopped = true;
      off?.();
    };
  }
  let retries = 0;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/live`,
    );
    ws.onopen = () => {
      retries = 0;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* next snapshot can recover */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!stopped)
        timer = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
        );
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
