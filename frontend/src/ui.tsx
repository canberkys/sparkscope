import {
  createContext,
  useContext,
  useId,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X, Server, ArrowUpRight } from "lucide-react";
import { api } from "./api";
import type { Device, Service, Alert, User } from "./types";
export const Context = createContext<{
  devices: Device[];
  services: Service[];
  alerts: Alert[];
  user: User;
  connected: boolean;
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  navigate: (page: string) => void;
}>({} as any);
export const useFleet = () => useContext(Context);
export function value(v: number | null | undefined, suffix = "", digits = 0) {
  return v == null || !Number.isFinite(v)
    ? "N/A"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits }) + suffix;
}
export function age(ts: number | null | undefined) {
  if (!ts) return "Not yet";
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 10
    ? "Just now"
    : s < 60
      ? `${Math.floor(s)}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : s < 86400
          ? `${Math.floor(s / 3600)}h ago`
          : `${Math.floor(s / 86400)}d ago`;
}
export function time(ts: number | null | undefined) {
  return ts ? new Date(ts * 1000).toLocaleString("en-US") : "—";
}
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <span />
      {status.replaceAll("_", " ")}
    </span>
  );
}
export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Server size={32} />
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Stat({
  label,
  number,
  detail,
  color = "",
}: {
  label: string;
  number: ReactNode;
  detail?: ReactNode;
  color?: string;
}) {
  return (
    <div className="stat panel">
      <div className="stat-label">
        {label}
        <ArrowUpRight size={15} />
      </div>
      <div className={`stat-value ${color}`}>{number}</div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}
export function Meter({
  v,
  color = "mint",
}: {
  v: number | null | undefined;
  color?: string;
}) {
  return (
    <div className={`meter ${color}`}>
      <i style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%` }} />
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.showModal();
    return () => {
      el?.close();
      opener.current?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error-box" role="alert">
      {message}
    </div>
  ) : null;
}
export function useQuery<T>(path: string, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    const load = async () => {
      try {
        const d = await api<T>(path);
        if (active) {
          setData(d);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const timer = interval ? setInterval(load, interval) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, interval, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}
