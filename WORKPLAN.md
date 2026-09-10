# SparkScope 0.2 — current delivery status

Target: 10–50 mixed Linux devices, including CPU-only hosts, GB10 and single/multiple NVIDIA GPU servers such as a dual-H200 HPE host. Local Mac development and shared Linux/Docker installations are supported. UI language is English.

## Completed locally

- [x] New-Mac inspection, user-local toolchain and dependency installation from unchanged locks; copied environments and uncommitted work preserved.
- [x] Modular backend, SQLAlchemy/Alembic, SQLite/PostgreSQL, sessions/roles/CSRF, SSH host-key trust, encrypted credentials and rotation.
- [x] Independent collection, runtime metadata discovery, history/rollup/retention, device lifecycle and controlled explicit-target operations.
- [x] Live device expansion, aligned alarm/healthy cards, configurable chart colors, TV mode and explicit cluster membership.
- [x] Stable GPU UUIDs, retained legacy history keys, hardware capability refresh, CPU-only health and per-GPU inventory.
- [x] Profile/device/GPU threshold overrides, explicit unconfigured hardware limits, per-component incidents and recorded event timeline.
- [x] Device-list return context, operational status ordering, alarm context filters and operation target eligibility.
- [x] Personal/shared saved monitoring views, TV density/rotation, four-target comparison and cluster summaries.
- [x] Settings management of Overview filters/colors/summary cards/live window/TV; GPU-model search for GB10/H200/4090.
- [x] Disabled-by-default encrypted webhook/email channels, bounded durable retries, maintenance suppression and end summaries.
- [x] All-secret startup validation, operational readiness/diagnostics and separate collection capacity pools.
- [x] Migration `0002` preservation tests; local database backed up and migrated with master key preserved. Local application remains unconfigured, with zero users/devices/channels.
- [x] Real browser → backend → local SSH journey and CI integration, in addition to demo interaction tests.
- [x] Isolated Docker/HTTPS/WebSocket/session validation and PostgreSQL backup restoration; same-image data rollback rehearsal.

## Validation and remaining acceptance

Actual command results and historical runs are maintained in [deployment/VALIDATION.md](deployment/VALIDATION.md). Local synthetic tests never substitute for hardware acceptance.

- [x] Complete and record the 1800-second monotonic fault-injection run, resource/retention/recovery evidence and observed clock discontinuities. It does not establish uninterrupted wall-clock soak or long-term memory stability.
- [ ] Owner creates the first administrator and supplies/verifies real device access.
- [ ] Validate real GB10, CPU-only Linux and dual-H200 hardware, installed runtime providers and actual permission differences.
- [ ] Complete 24-hour / 50-device soak on the intended reference server and its dedicated test database.
- [ ] Verify installation/reboot behavior on the intended deployment server and rehearse rollback to an identified previous application release. Local same-image database restoration is already checked.

The final review and publication work is recorded in deployment/VALIDATION.md and CHANGELOG.md. No real external notification or real-device state-changing operation was performed. AMD/Intel GPU adapters, non-Linux remote collectors, HPE iLO and MIG instance monitoring remain outside the accepted scope. See [monitoring guide](deployment/MONITORING.md) for behavior and limits.
