# Changelog

All notable changes are documented here. Versions describe repository functionality; acceptance limits remain explicit. The original published baseline is commit [`5fb8304`](https://github.com/canberkys/sparkscope/commit/5fb8304b6cee07001a015acf3202a08f7fc22b38).

## 0.2.0 — 2026-09-10

Fleet monitoring implementation and documentation update. Targets 10–50 mixed Linux devices; real hardware and sustained production acceptance remain pending. This entry does not imply a release tag, production deployment or completed hardware certification.

### Added

**Inventory and access**

- Dashboard-based device onboarding with SSH password/private-key authentication, explicit fingerprint verification and discovery preview.
- Connection replacement, device pause/archive, groups, tags and explicit cluster membership.
- Viewer/operator/admin accounts, sessions, CSRF/origin validation and audit records.
- Encrypted device/service/job/notification credentials, startup decryption checks and master-key rotation.

**Mixed hardware**

- CPU-only Linux and single/multiple NVIDIA GPU inventory; stable UUID identity independent of display order.
- GPU-specific utilization, memory, temperature, power and supported health measurements; retained history for removed components.
- Separate system RAM and GPU-reported memory, discovery capability states and preserved last-known inventory during failures.
- Named hardware profiles, per-device/per-GPU rule overrides and effective-rule sources. New UUID GPU temperature/power thresholds require configuration unless saved global rules exist.
- GPU-model search, including GB10, H200 and 4090 names reported by inventory.

**Monitoring workflows**

- Personal/shared saved views and Settings controls for filters, selected metrics, colors, summary widgets, live window and TV layout.
- Four/six-card TV pages, fixed/rotating pages, explicit cluster summaries and up-to-four-target historical comparison.
- Incident, connectivity and service event history; device/group/cluster incident filters and contextual history links.
- Durable webhook/email delivery, bounded retries, channel tests, maintenance suppression and end-of-maintenance summaries.
- Readiness and administrative diagnostics for database, collectors, maintenance and notification progress.

**Storage, operations and validation**

- SQLAlchemy/Alembic with SQLite and PostgreSQL, schema migrations, legacy import, CLI backup and password recovery.
- Raw/rollup retention, device-specific collection backoff and separate collection capacity pools.
- Docker/Compose installation, CI and isolated backend/browser/SSH/deployment/fault test harnesses.
- English installation, hardware onboarding, maintenance and roadmap documentation with synthetic UI screenshots.

### Changed

- Replaced the served Alpine.js/canvas frontend with React/TypeScript/Vite. The production app and static demo now share frontend source.
- Reorganized the single application into the `sparkscope/` backend package. Legacy files remain reference material.
- Moved configuration from legacy YAML to environment variables and authenticated dashboard settings.
- Default system/service cadence is 5 seconds, compared with the original 2-second system polling; SMART and discovery run independently every 60 seconds.
- Expanded vLLM-only integration to vLLM, Ollama and llama.cpp discovery, with provider-specific metric capabilities. Discovery reads metadata and does not manage model lifecycles.
- Preserved live device expansion and TV workflows while adding inventory, history, settings and multi-user administration.
- Alarm identity is now device/metric/component specific. Three bad samples open and three healthy samples resolve; acknowledgement is a separate action.
- Operations require explicit eligible targets. Privileged operations use short-lived confirmations bound to the user, command and device set; unknown remote outcomes are not retried automatically.

### Fixed

- History now uses actual timestamp spacing and gaps rather than equal sample spacing or connecting across outages.
- Added readable units, accessible keyboard/touch inspection, loading/empty/unsupported/error states and sample-weighted rollup history.
- Removed fabricated provider metrics and generic interchangeable demo waveforms; synthetic data is labeled and capability-aware.
- Aligned healthy/alarmed device card slots and metric baselines; corrected mobile table and long-GPU-identity overflow.
- GPU temperature colors follow matching incidents and configured rules rather than a universal hard-coded 90°C cutoff.
- CPU-only devices no longer depend on NVIDIA telemetry to appear healthy; missing measurements remain unavailable rather than becoming zero.
- Preserved device-list context on return from detail, historical GPU access after discovery changes, and per-component alarm separation.
- Hardened pending notification processing against restart/late-commit issues and enforced retry limits before transport attempts.

- Corrected the demo device-count selector for custom and empty inventory sizes.
- Rejected malformed webhook URLs and invalid ports with a validation response instead of an internal server error; secret endpoints are not echoed.
- Extended CI linting to validation scripts and made demo drift checks catch newly generated untracked assets.

### Upgrade notes

- Install locked Python/frontend dependencies and build assets before starting the new application. Run one worker and one collector per database.
- Back up the database and matching master key before migration. `0002` adds events, saved views, notification channels/deliveries, maintenance windows and alert component identity.
- Import the original YAML/database through the CLI into a separate new installation. Imported devices start paused and require host-key/credential verification; legacy incidents are historical resolved records.
- Legacy GPU history retains its original keys and is not silently relabeled as UUID history. GPU-process snapshots from legacy import remain in the preserved source backup.
- Use backup restoration for rollback; destructive in-place schema downgrade is not supported. See [operations](deployment/OPERATIONS.md).

### Verification and known limits

See [validation](deployment/VALIDATION.md) for the final review results and exact historical checks. Automated browser/SSH fixtures and demo screenshots are synthetic. Local installation/restore tests do not replace acceptance on the deployment server.

Still open: real GB10/CPU-only/dual-H200 validation, uninterrupted 24-hour/50-device soak and identified previous-release rollback. Cluster membership does not validate fabric or pooled memory. AMD/Intel GPU adapters, non-Linux remote collection, HPE iLO/Redfish, detailed MIG monitoring and distributed collectors are outside this release.

## Original published dashboard — baseline through `5fb8304`

- GB10/DGX Spark-focused SSH system telemetry, GPU health, NVMe SMART and vLLM integration.
- Live charts, historical queries, threshold alerts and whitelisted command panels.
- SQLite storage, YAML host configuration and persistent SSH reconnect.
- Hero health dial, expandable hosts, adaptive grid and TV/NOC mode.
- Browser-only GitHub Pages demo with synthetic telemetry.
