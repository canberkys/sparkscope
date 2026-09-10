import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Server,
  Boxes,
  Bell,
  Terminal,
  Settings,
  LogOut,
  Loader2,
  X,
  LockKeyhole,
} from "lucide-react";
import { api, APIError, DEMO, setCsrf, subscribe } from "./api";
import type { User, Device, Alert, Service } from "./types";
import { Context, Field, ErrorBox } from "./ui";
import { Devices, DeviceDetail } from "./Devices";
import { Overview, Models, Alerts, Operations, SettingsPage } from "./Pages";
const nav = [
  ["overview", "Overview", Activity],
  ["devices", "Devices", Server],
  ["models", "Models & Services", Boxes],
  ["alerts", "Alerts", Bell],
  ["operations", "Operations", Terminal],
  ["settings", "Settings", Settings],
] as const;
function route() {
  return location.hash.replace(/^#\/?/, "").split("?")[0] || "overview";
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [setup, setSetup] = useState(false),
    [bootError, setBootError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [page, setPage] = useState(route()),
    [devices, setDevices] = useState<Device[]>([]),
    [alerts, setAlerts] = useState<Alert[]>([]),
    [services, setServices] = useState<Service[]>([]),
    [connected, setConnected] = useState(false),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(
      null,
    );
  const navigate = useCallback((p: string) => {
    location.hash = "/" + p;
    setPage(p.split("?")[0]);
  }, []);
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onHash = () => setPage(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let active = true;
    setBootError("");
    setReady(false);
    (async () => {
      try {
        const status = await api<{ setup_required: boolean }>("/auth/status");
        if (!active) return;
        setSetup(status.setup_required);
        if (!status.setup_required) {
          try {
            const info = await api<{ user: User; csrf: string }>("/auth/me");
            if (active) {
              setUser(info.user);
              setCsrf(info.csrf);
            }
          } catch (e) {
            if (!(e instanceof APIError) || e.status !== 401) throw e;
          }
        }
      } catch (e) {
        if (active) setBootError((e as Error).message);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);
  const refresh = useCallback(async () => {
    const [d, a, s] = await Promise.all([
      api<Device[]>("/devices"),
      api<Alert[]>("/alerts"),
      api<Service[]>("/services"),
    ]);
    setDevices(d);
    setAlerts(a);
    setServices(s);
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const load = () =>
      refresh().catch((e) => {
        if (!active) return;
        if (e instanceof APIError && e.status === 401) {
          setUser(null);
          setCsrf("");
        } else notify(e.message, true);
      });
    void load();
    const timer = setInterval(load, 8000);
    const stop = subscribe((message) => {
      if (!active) return;
      setDevices((prev) =>
        message.type === "snapshot"
          ? message.devices
          : [
              ...prev.filter(
                (d) =>
                  !message.removed.includes(d.id) &&
                  !message.devices.some((c) => c.id === d.id),
              ),
              ...message.devices,
            ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setAlerts((prev) => [
        ...message.alerts,
        ...prev.filter((a) => a.resolved_at),
      ]);
    }, setConnected);
    return () => {
      active = false;
      clearInterval(timer);
      stop();
    };
  }, [user, refresh, notify]);
  if (!ready)
    return (
      <div className="auth-screen">
        <Activity className="accent" size={38} />
        <p>Connecting to SparkScope…</p>
      </div>
    );
  if (bootError)
    return (
      <div className="auth-screen">
        <div className="auth-card panel">
          <h1>Server unavailable</h1>
          <ErrorBox message={bootError} />
          <p>Check that the SparkScope server is running, then try again.</p>
          <button className="primary" onClick={() => setAttempt((v) => v + 1)}>
            Retry connection
          </button>
        </div>
      </div>
    );
  if (!user)
    return (
      <Login
        setup={setup}
        onLogin={(u, csrf) => {
          setUser(u);
          setCsrf(csrf);
          setSetup(false);
        }}
      />
    );
  const title = nav.find(([key]) => page.startsWith(key))?.[1] || "Overview";
  return (
    <Context.Provider
      value={{
        devices,
        services,
        alerts,
        user,
        connected,
        refresh,
        notify,
        navigate,
      }}
    >
      <div className="shell">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <aside className="sidebar">
          <a className="brand" href="#/overview">
            <span className="brand-mark">
              <Activity />
            </span>
            <span>
              sparkscope<small>FLEET CONSOLE</small>
            </span>
          </a>
          <div className="workspace">
            <span className="status-dot" />
            Fleet workspace
            <small>{DEMO ? "DEMONSTRATION" : "LOCAL / SELF-HOSTED"}</small>
          </div>
          <nav aria-label="Main navigation">
            {nav
              .filter(([key]) => key !== "settings" || user.role === "admin")
              .map(([key, label, Icon]) => (
                <button
                  key={key}
                  className={page.startsWith(key) ? "active" : ""}
                  onClick={() => navigate(key)}
                  aria-current={page.startsWith(key) ? "page" : undefined}
                >
                  <Icon size={19} />
                  {label}
                  {key === "alerts" && alerts.some((a) => !a.resolved_at) && (
                    <span className="nav-count">
                      {alerts.filter((a) => !a.resolved_at).length}
                    </span>
                  )}
                </button>
              ))}
          </nav>
          <div className="sidebar-foot">
            <div className="user-chip">
              <span className="avatar">
                {user.username.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <strong>{user.username}</strong>
                <small>{user.role}</small>
              </div>
              <button
                aria-label="Sign out"
                className="icon-button"
                onClick={async () => {
                  try {
                    await api("/auth/logout", "POST", {});
                    setUser(null);
                    setCsrf("");
                    setDevices([]);
                    setServices([]);
                    setAlerts([]);
                  } catch (e) {
                    notify((e as Error).message, true);
                  }
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
            <small>SPARKSCOPE 0.3 · YOUR FLEET, IN VIEW</small>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar">
            <span>
              Workspace <span className="separator">/</span> {title}
            </span>
            <div className="topbar-right">
              {DEMO && <span className="demo-label">DEMO</span>}
              <span className={`connection ${connected ? "" : "lost"}`}>
                <span className="status-dot" />
                {connected ? "Live updates" : "Reconnecting"}
              </span>
            </div>
          </header>
          {DEMO && (
            <div className="demo-banner">
              Synthetic data · no real devices connected.{" "}
              <a
                href="https://github.com/canberkys/sparkscope"
                target="_blank"
                rel="noreferrer"
              >
                View source ↗
              </a>
            </div>
          )}
          <main id="main-content">
            {page === "overview" ? (
              <Overview />
            ) : page === "devices" ? (
              <Devices />
            ) : page.startsWith("devices/") ? (
              <DeviceDetail key={page} id={page.split("/")[1]} />
            ) : page === "models" ? (
              <Models />
            ) : page === "alerts" ? (
              <Alerts />
            ) : page === "operations" ? (
              <Operations />
            ) : page === "settings" && user.role === "admin" ? (
              <SettingsPage />
            ) : (
              <Overview />
            )}
          </main>
        </div>
        {toast && (
          <div
            role={toast.error ? "alert" : "status"}
            className={`toast ${toast.error ? "error" : ""}`}
          >
            <span>{toast.message}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </Context.Provider>
  );
}
function Login({
  setup,
  onLogin,
}: {
  setup: boolean;
  onLogin: (user: User, csrf: string) => void;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <Activity /> sparkscope
      </div>
      <div className="auth-card panel">
        <span className="eyebrow">
          {setup ? "FIRST-RUN SETUP" : "FLEET CONSOLE"}
        </span>
        <h1>{setup ? "Create your workspace" : "Welcome back"}</h1>
        <p>
          {setup
            ? "Create the first administrator using the setup code on this server."
            : "Sign in to monitor and manage your device fleet."}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const result = await api<{ user: User; csrf: string }>(
                setup ? "/auth/setup" : "/auth/login",
                "POST",
                { username, password, ...(setup ? { token: code } : {}) },
              );
              onLogin(result.user, result.csrf);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ErrorBox message={error} />
          {setup && (
            <Field
              label="Local setup code"
              hint="On the server, run: uv run python -m sparkscope.cli setup-code"
            >
              <input
                type="password"
                autoComplete="off"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          )}
          <Field label="Username">
            <input
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field
            label={setup ? "Password (at least 12 characters)" : "Password"}
          >
            <input
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={setup ? 12 : 1}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button className="primary full-width" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <LockKeyhole size={17} />
            )}{" "}
            {setup ? "Create administrator" : "Sign in"}
          </button>
        </form>
      </div>
      <p className="auth-foot">Your infrastructure stays on your server.</p>
    </div>
  );
}
