import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorBox, time } from "./ui";
export type TimelineEvent = {
  id: string;
  device_id: string;
  component_id?: string;
  kind: string;
  ts: number;
  detail: Record<string, unknown>;
};
export function useHistoryEvents(device: string, start: number, end: number) {
  const [events, setEvents] = useState<TimelineEvent[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setEvents([]);
    setError("");
    void api<TimelineEvent[]>(
      `/events?device_id=${encodeURIComponent(device)}&start=${start}&end=${end}`,
    )
      .then((r) => {
        if (!Array.isArray(r)) throw new Error("Invalid events response");
        if (active) setEvents(r);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [device, start, end]);
  return { events, error };
}
export function HistoryEvents({
  events,
  error,
}: {
  events: TimelineEvent[];
  error: string;
}) {
  return (
    <details className="padded">
      <summary>Recorded events · {events.length}</summary>
      <ErrorBox message={error} />
      {events.length ? (
        <ul>
          {events.map((e) => (
            <li key={e.id}>
              <time>{time(e.ts)}</time> · {e.kind.replaceAll(".", " ")}
              {e.component_id ? " · " + e.component_id : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No recorded events in this range. Events before collection began are
          unavailable.
        </p>
      )}
    </details>
  );
}
