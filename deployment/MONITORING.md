# Monitoring a mixed Linux fleet

SparkScope monitors Linux hosts through verified SSH connections. NVIDIA GPU telemetry is optional. A CPU-only host can be healthy; missing NVIDIA tooling does not prove that a host has no accelerator. GB10, dedicated GPU workstations and servers with multiple H200 GPUs share the same inventory and dashboard.

## Devices, GPUs and thresholds

A host is one device. Its GPUs are child components, identified by NVIDIA UUID rather than their current display order. Inventory refreshes with the 60-second discovery loop; transient driver or discovery errors retain the last known inventory. A successful discovery can mark a removed GPU absent. System memory is separate from GPU-reported memory; no automatic shared-memory capacity is inferred from two installed GPUs or cluster membership.

New samples use `gpu.<UUID>.<metric>` keys. Previous `gpu.*` and `gpu.N.*` history remains unchanged; it is never retroactively assigned to a UUID. Existing alert history links preserve the original metric. Unknown/unsupported measurements remain empty, not zero. GPU processes are associated only when the collector returns identity evidence; service-to-GPU placement is not inferred.

In **Settings → Operations & health → Hardware thresholds**, administrators can create empty named profiles, assign a profile to a device, and enter device or GPU-specific rules. Priority is GPU → device → selected profile → saved global configuration. Inherit removes an override; Disable explicitly turns that rule off. The UI shows each effective rule's source. New UUID GPUs do not receive unverified temperature or power thresholds from built-in legacy defaults; configure suitable limits. Explicitly saved global limits and historical legacy rules are preserved and are not certified H200 limits.

Incidents open after three bad samples and resolve after three healthy samples. Acknowledgement is separate. Missing telemetry, removed hardware and disabled rules do not fabricate healthy samples or automatically resolve an existing incident.

## Overview, saved views and TV

Search accepts device names, addresses, tags and GPU models such as GB10, H200 or 4090. Filters and pagination survive device-detail navigation. Cluster membership is explicit metadata; the view does not verify fabric links, distributed inference or pooled memory.

Use **Saved views** from Overview or **Settings → Monitoring views** to manage personal and shared layouts. Personal layouts belong to the account; only administrators maintain shared layouts. Anyone with access can make a personal copy. Views store device/group/cluster selection, search, device/cluster mode, metric selection, colors, summary widgets, live chart window, TV density and rotation. The `view` URL parameter opens an accessible saved view. Demo saved views are browser-local simulations, not server account records.

Live charts retain at most five minutes of received data in the current browser session. Display windows are one, three or five minutes. Freshness is still based on telemetry timestamps; changing the display window does not change collection frequency or make stale data fresh. TV defaults to six cards and 20-second rotation, with four-card and fixed-page options. Escape exits TV. Up to four devices/GPUs can be compared using the same recorded time interval and axis scale.

History displays recorded incident, connectivity and service transitions. Events before this feature was installed do not exist; acknowledgement is not shown as recovery.

## Notifications and maintenance

Only administrators configure notification channels. Channels start disabled. Enabling a channel authorizes ongoing alert delivery; **Send test** is a separate explicit action. Webhook URLs/tokens and SMTP credentials are encrypted by the master key and included in key rotation. Saved secrets are never returned by the configuration API.

Webhooks use HTTPS by default, carry `X-SparkScope-Event-ID`, and do not follow redirects. SMTP uses STARTTLS or TLS. API-only `allow_insecure: true` is available for deliberately configured trusted test endpoints; the normal UI uses secure transports. No endpoint or real recipient is preconfigured.

Opening, escalation and resolution notifications are persisted. A delivery has at most five attempts with increasing delays. The same event identifier is used after a restart; receivers should deduplicate webhook events. SMTP cannot guarantee exactly-once delivery. Recent delivery status is visible in Settings. Endpoint/TLS/authentication errors never include saved credentials.

Maintenance windows combine selected device IDs, group and cluster filters. At least one scope is required. Recording and alarm evaluation continue during maintenance; matching external notifications are suppressed, including pending retries. At the end, still-open incidents are summarized once. Overlapping active windows continue suppressing matching devices. Cancelling a future window removes it; ending an active window allows its summary on the next queue pass.

## Operational health and compatibility

`/api/v1/health` is process liveness. `/api/v1/readiness` returns HTTP 200 or 503 without diagnostic details. Authenticated administrators can inspect `/api/v1/diagnostics` for database, scheduling, maintenance, stalled jobs and notification progress. An offline remote host alone does not make the server unready. Collection-disabled test installations report that mode explicitly.

The `0002` migration adds event, view, notification and maintenance storage plus optional alert component identity. Back up the database and its matching master key before upgrading. Restore the matching backup for rollback; destructive downgrade is disabled. No old telemetry is rewritten. One application worker and one collector per database remain required.

Current limits: Linux remote collection, NVIDIA GPU support, NVMe SMART. AMD/Intel accelerators, Windows/macOS remote collectors, HPE iLO, detailed MIG instance monitoring, model lifecycle operations and automatic GPU-placement discovery are not included. Validate actual GB10 and dual-H200 hardware separately from the synthetic demo.
