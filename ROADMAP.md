# SparkScope roadmap

Updated 2026-09-10. This roadmap distinguishes implemented features from acceptance work and possible future extensions. It is not a promise of release dates. See [CHANGELOG](CHANGELOG.md) for delivered changes and [validation evidence](deployment/VALIDATION.md) for test scope.

## Product direction

Make it easy to answer: which devices need attention, how fresh and reliable are their readings, and what action is available? Preserve live monitoring, expandable device detail and TV mode while supporting 10–50 mixed Linux hosts. UI language is English.

## Implemented in the 0.3 codebase

- [x] Modular FastAPI backend, SQLite/PostgreSQL, migrations and repeatable dependency locks.
- [x] Verified SSH onboarding, encrypted credentials/rotation, accounts/roles and controlled operations.
- [x] Independent collectors, provider-aware runtime discovery, history/rollups/retention and freshness states.
- [x] Live expandable device cards, aligned incident layouts, configurable charts, mobile layouts and rotating TV pages.
- [x] CPU-only and multi-NVIDIA inventory, UUID GPU identity, separate system/GPU memory and per-component rules.
- [x] Explicit groups/clusters, GPU-model search, personal/shared views and Settings-driven monitoring layouts.
- [x] Comparison charts, event history, alarm acknowledgement, webhook/email delivery and maintenance windows.
- [x] Readiness diagnostics, migration tests, browser/API/SSH integration and isolated deployment/restore checks.

## Required before production acceptance

| Priority | Work | Completion evidence |
| --- | --- | --- |
| P0 | Validate real GB10, CPU-only Linux and dual-H200 hosts | Trusted SSH fingerprints; correct per-GPU identity, values/units, unavailable states, runtime discovery, permissions and reconnect behavior |
| P0 | Preserve the original monitoring experience | Compare original/current screens using the same real device; check important readings are visible and interpretable without unnecessary navigation |
| P0 | Run 24 hours with 50 devices on the intended reference server | Dedicated test database; uninterrupted clock, latency and resource records; retention, growth and recovery review |
| P0 | Validate intended-server installation and reboot | HTTPS, authenticated WebSocket, secure cookies and persistent database/key state after host reboot |
| P0 | Rehearse previous-release rollback | Named previous application revision plus matching database/key backup; successful restore, login and credential decryption |
| P1 | Complete the first real operator pilot | Owner-created accounts, device access, hardware rules and explicitly configured notification destinations; record usability findings |

Local Compose/HTTPS/container restart and same-image backup restoration have passed. They do not close the intended-server or previous-release rollback gates. The 1800-second monotonic fault test observed wall-clock discontinuities; it does not close the uninterrupted soak gate.

## UI refinements identified in the final review

- [ ] Make GPU count/model more prominent on collapsed multi-GPU cards without implying a misleading aggregate utilization.
- [ ] Make mobile navigation overflow easier to discover.
- [ ] Extend browser coverage beyond Chromium and perform a broader accessibility audit. Keyboard/touch and mobile checks already exist; they are not a complete accessibility certification.

## Candidate extensions — not committed release scope

| Area | Possible work | Prerequisite |
| --- | --- | --- |
| More accelerators | AMD/Intel collectors and detailed NVIDIA MIG instances | Real hardware fixtures and a stable capability/identity contract |
| Server hardware health | HPE iLO/Redfish sensors and inventory | Explicit management access, read-only scope and vendor validation |
| Cluster visibility | Verified fabric/topology and workload placement | Reliable telemetry sources; membership alone is insufficient |
| Remote platforms | Windows/macOS collectors | Separate platform adapters and test hosts |
| Larger installations | Distributed collectors and high availability | Ownership/coordination design and load evidence beyond the current single-worker model |
| Fleet onboarding | Bulk inventory import/discovery | Explicit scope, credentials and host-trust workflow |

Prioritize real-device findings before adding more settings or dashboard panels. Model installation/start/stop is outside this monitoring release.
