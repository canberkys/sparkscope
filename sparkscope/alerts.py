"""One incident per device and metric; acknowledgement is independent of recovery."""

import math

from sqlalchemy import select

from .hardware import effective_rules
from .models import Alert, FleetEvent, uid


class AlertEngine:
    def __init__(self):
        self.counters = {}

    def reset(self, device_id):
        self.counters = {k: v for k, v in self.counters.items() if k[0] != device_id}

    async def evaluate(self, session, device_id, metrics, ts, thresholds=None, hardware_rules=None):
        rules = effective_rules(device_id, metrics, thresholds, hardware_rules)
        active = {
            a.metric: a
            for a in (
                await session.scalars(select(Alert).where(Alert.device_id == device_id, Alert.resolved_at.is_(None)))
            ).all()
        }
        for key in list(self.counters):
            if key[0] == device_id and key[1] not in rules:
                self.counters.pop(key)
        for metric, rule in rules.items():
            if rule["thresholds"] is None:
                self.counters.pop((device_id, metric), None)
                continue
            warning, critical = rule["thresholds"]
            value = metrics.get(metric)
            if value is None or not isinstance(value, (float, int)) or not math.isfinite(value):
                self.counters.pop((device_id, metric), None)
                continue
            state = self.counters.setdefault((device_id, metric), {"bad": 0, "good": 0, "critical": 0})
            severity = "critical" if critical is not None and value >= critical else "warning"
            if value >= warning:
                state["bad"] += 1
                state["good"] = 0
                state["critical"] = state["critical"] + 1 if severity == "critical" else 0
                if state["bad"] < 3:
                    continue
                level = "critical" if state["critical"] >= 3 else "warning"
                alert = active.get(metric)
                message = f"{metric}: {value:.1f} (warning {warning}" + (
                    f", critical {critical})" if critical is not None else ")"
                )
                if alert:
                    alert.last_seen = ts
                    alert.message = message
                    alert.occurrences += 1
                    if level == "critical" and alert.severity != "critical":
                        alert.severity = "critical"
                        session.add(
                            FleetEvent(
                                device_id=device_id,
                                component_id=rule["component_id"],
                                kind="alarm.escalate",
                                ts=ts,
                                detail={"alert_id": alert.id, "metric": metric, "severity": level},
                            )
                        )
                else:
                    alert = Alert(
                        id=uid(),
                        component_id=rule["component_id"],
                        device_id=device_id,
                        metric=metric,
                        severity=level,
                        message=message,
                        first_seen=ts,
                        last_seen=ts,
                    )
                    session.add(alert)
                    session.add(
                        FleetEvent(
                            device_id=device_id,
                            component_id=rule["component_id"],
                            kind="alarm.open",
                            ts=ts,
                            detail={"alert_id": alert.id, "metric": metric, "severity": level},
                        )
                    )
                    active[metric] = alert
            else:
                state["bad"] = state["critical"] = 0
                state["good"] += 1
                if state["good"] >= 3 and metric in active:
                    session.add(
                        FleetEvent(
                            device_id=device_id,
                            component_id=rule["component_id"],
                            kind="alarm.resolve",
                            ts=ts,
                            detail={
                                "alert_id": active[metric].id,
                                "metric": metric,
                                "severity": active[metric].severity,
                            },
                        )
                    )
                    active[metric].resolved_at = ts
                    active.pop(metric)
