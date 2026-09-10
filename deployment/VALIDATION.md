# Validation status

Local implementation verification, 2026-09-09. These checks do not constitute production or real-device acceptance. Previous-Mac results below are retained separately from the new-Mac rerun.

## Final pre-publication review — 2026-09-10

This section supersedes earlier counts for the current source. Three focused reviews covered UI/workflows, backend/security behavior and installation/CI; they do not certify every possible deployment or accessibility requirement.

- **55 SQLite tests passed**, then **83 SQLite/PostgreSQL-parametrized tests passed** against the dedicated disposable test environment. No application database was used. Two existing dependency deprecation warnings remain.
- Fixed malformed webhook URLs/ports causing a server error or unusable saved endpoint. Validation now returns 422 without echoing secret URLs; a regression test covers the cases.
- **25 demo/mocked Playwright scenarios passed in the final full run** (24.7 seconds), and **one real production frontend/API/local SSH journey passed** (8.9 seconds). Fixtures use disposable synthetic hosts/credentials; no external notification or real device command was sent.
- Fixed the synthetic demo device-count selector for nonstandard/empty inventories. The final demo was regenerated and rechecked; the production bundle stayed unchanged, so the preceding real-API result applies to the same production asset.
- Six current desktop/mobile/TV captures had no JavaScript errors or horizontal document overflow. Six-card TV fits 1920×1080. Synthetic screenshots are published under `deployment/images/`; detailed local capture records are in the ignored `.runtime/validation/` directory.
- Production/demo builds, TypeScript, frontend formatting, locked Python synchronization, and Ruff lint/format (**40 files**) passed. CI now checks scripts and detects untracked generated demo assets. No dependency lock changes were needed in this final review.
- **All eight isolated Compose/HTTPS/restore checks passed again** with the final backend: image build/start, verified HTTPS, secure session cookies, authenticated WebSocket, cross-origin rejection, restart persistence, fresh PostgreSQL backup restoration/decryption and same-image data rollback. Evidence: `.runtime/validation/deployment-release-review.json`. Temporary deployment resources were removed. Intended-server and previous-binary rollback remain open.
- Replaced machine-specific README content with public installation requirements, native/Compose setup, host onboarding, adding/replacing GPUs, threshold guidance and screenshots. Roadmap separates completed features, acceptance gates and candidate extensions. Added detailed `CHANGELOG.md` against the original GitHub baseline.
- Local checks passed before publication. Hosted CI and Pages status must be verified on the pushed revision; no hosted result is inferred from these local checks.

No new 24-hour test was performed. The earlier monotonic fault-run result and clock/resource caveats remain unchanged. Future UI refinements include clearer collapsed multi-GPU identity, mobile navigation affordance, non-Chromium coverage and broader accessibility review.

## Implemented plan and Settings/GPU search — 2026-09-09–10

- **54 SQLite tests passed**, followed by **81 tests passed with SQLite/PostgreSQL parametrization** on the isolated `sparkscope-postgres-test` database service. Coverage includes UUID ordering/retirement, per-GPU rules, all-secret startup rejection, legacy migration preservation, view ownership/roles, notification retry caps/late events and maintenance suppression/summary. Two existing dependency deprecation warnings remain.
- **24 demo/mocked browser scenarios passed**, including saved-view CRUD/account simulation, Settings-driven layout/summary/window/color changes, GB10/H200/4090 search, hardware threshold editing, mobile layouts, notification configuration and maintenance scope. Initial final-run failures exposed a HardwarePolicy intrinsic-width issue and an ambiguous accessible label; both were corrected before this passing run.
- A subsequent GPU temperature rendering correction removed the fixed 90°C color rule; colors now follow the corresponding active component incident. The seven workflow scenarios passed after this change, including its new H200/no-incident regression. The suite now contains 25 demo/mocked scenarios; the earlier full run covered 24, followed by these seven targeted checks. Production/demo were rebuilt.
- **One real browser → backend → local AsyncSSH journey passed** using the production frontend and a fresh temporary database. It traverses first-run setup, login/logout, explicit fingerprint trust, credential replacement, CSRF rejection, viewer/operator restrictions, real saved-view persistence/ownership and a disabled webhook channel. The endpoint is intentionally invalid and no notification was sent. Evidence: `.runtime/validation/real-e2e.json`; temporary secrets are excluded from traces/screenshots.
- Ruff lint/format (**39 files**, including new validation scripts), frontend Prettier, TypeScript and production/static-demo builds passed. CI now includes the separate real-API browser configuration; hosted CI has not run because changes have not been pushed.
- Static demo desktop/mobile screenshots were captured and inspected: mixed-device Overview, dual-H200 expansion, TV and Settings view editor. No page errors or horizontal document overflow; the six-card TV view fits 1920×1080. Evidence: `.runtime/validation/final-browser-results.json` and `final-*.png`. All hardware identities/telemetry in these screenshots are synthetic.
- **Eight isolated deployment checks passed** on the dedicated Colima context: Compose build/start, verified local HTTPS certificate/frontend, secure/HttpOnly/SameSite cookies, authenticated WebSocket, cross-origin rejection, container-restart persistence, PostgreSQL restore into an empty database with credential decryption/login, and rollback of a post-backup mutation using the same application image. Own project resources were removed. Evidence: `.runtime/validation/deployment-local-final.json` includes source hashes. This does not prove a rollback to a previous application binary or deployment on the intended server.
- Local application was stopped, backed up by the CLI, migrated to **0002** and restarted on 8010. SQLite integrity is `ok`; users/devices/notification channels are all zero, key permissions remain 0600, and readiness returns true. No credentials were printed and no administrator was fabricated.
- Final fault injection completed **1800.21 seconds of monotonic elapsed time**, with **50 devices / 5 clients**, **14,618 system samples**, **4,470 WebSocket messages**, p95 sample latency **3.0633 s**, p95 query latency **0.0375 s**, maximum payload **151,668 bytes**, and **zero client errors**. Seven system, two SMART and three service paths were deliberately delayed by eight seconds; all four periodically unavailable devices recovered. The 26-hour / 15,600-sample seeded maintenance backlog was processed; final expired raw samples were zero, with rollup cursor lags 56.1/236.1 seconds. The instrumented checks passed.
- **Fault-run limit:** five wall-clock advances exceeded their monotonic intervals, totaling about 5,891 seconds. Sleep or clock adjustment was not independently diagnosed. This is **not evidence of an uninterrupted 30-minute wall-clock soak**; the reference-server 24-hour gate and uninterrupted sustained-load acceptance remain open. Peak RSS was **404.1 MiB**, final RSS **256.45 MiB** versus 120.47 MiB initially; DB+WAL ended at **120,382,520 bytes**. Backlog processing increased memory/database usage; long-term memory stability is not established. Evidence: `.runtime/validation/fault-final-30min.json` and `fault-final-30min-analysis.json`; backend/migration source hashes match the current implementation. The interrupted intermediate run is not counted as passed.
- Final targeted Settings checks also passed (**2 scenarios**) after diagnostic counters were exposed; setup help now points to the documented CLI. The real-API/Compose evidence above predates the final frontend-only temperature renderer/setup-help/diagnostic presentation changes; the backend snapshot is unchanged. Final production and static demo were rebuilt.

## Earlier mixed hardware follow-up — 2026-09-09

- 35 SQLite tests passed, including seven new hardware cases for CPU-only output, separate GPU rows, unsupported values, discovery and whole-disk counters. PostgreSQL was not rerun for this parser/UI-only iteration; the earlier 48-test result remains historical.
- 15 browser scenarios passed, including mixed CPU-only/dedicated/multi-GPU rendering. Production/demo builds and Ruff lint/format (29 files) passed. No real-device or deployment acceptance is claimed.
- Live memory labels describe system RAM; available GPU-reported memory is shown separately. GPU count/names are discovered. Multi-GPU metrics use row indices; default legacy GPU alarm rules do not yet cover those indices. Stable UUIDs, per-GPU alarms and hardware-specific threshold policy remain open. CPU-only means no detected NVIDIA telemetry in this UI, not proof that no accelerator is installed.
- Remote system collection requires Linux; NVIDIA telemetry is optional. AMD/Intel GPU and Windows/macOS remote collectors and non-NVMe SMART remain unsupported. Mixed-demo hardware identities and samples are synthetic.

## Earlier follow-up — live monitoring and history, 2026-09-09

- History correctness/capability changes and explicit cluster membership: **28 SQLite tests passed** and **48 tests passed with SQLite/PostgreSQL parametrization**. New history cases run on both engines; cluster create/edit/clear and role checks are covered. Two existing dependency warnings remain.
- **14 Playwright scenarios passed**: the existing five, history gaps/units/zero/single/empty/Ollama/keyboard/touch, mocked HTTP loading/refresh failure and timestamp spacing, live expansion and persistent chart colors, explicit clusters vs groups, TV page rotation/Escape, mobile stale data, and equal alarm/healthy card heights and metric baselines. The six-device TV page fits 1920×1080 without document overflow; static-demo measurement was 1920×1080 document size at that viewport.
- The HTTP browser scenario uses mocked API responses. It verifies frontend behavior but does not close the real browser → backend authentication/onboarding acceptance gap.
- Ruff lint/format (28 files), frontend Prettier, production build and regenerated static demo passed. One intermediate backend run overlapped production asset rebuilding and hit a missing directory; sequential rerun passed. Initial browser test harness issues (touch context and React StrictMode's duplicate requests) were corrected before the passing run.
- Live charts use real received snapshots buffered for up to five minutes in the current browser session; they are not persisted history. Offline demo readings stop advancing. Chart color preferences are browser-local and do not alter alarm severity colors.
- Cluster membership is explicit metadata stored in Device.info; no schema migration, cluster configuration/probing or device-state operation was performed. No derived cluster-link, distributed inference or pooled-memory health is claimed.
- Additional local screenshots/results are under Git-ignored `.runtime/validation/` (`history-*`, `queue-*`, `ollama-*`, `live-*`, `monitor-browser-results.json`). Desktop/mobile inspections use synthetic data; the local application still has no administrator or devices and was restarted on 8010 with the new backend.
- The earlier 60-second smoke result is historical evidence; it was not rerun for this UI/capability iteration. Real hardware, sustained load and deployment/restore gates below remain open. No commit, push or publication occurred.

## New Mac rerun — 2026-09-09

- **Environment:** arm64, macOS 27.0 (26A5425a); user-local Python 3.12.14, uv 0.12.11, Node.js 22.23.2, npm 10.9.8; Playwright Chromium 153.0.8010.12 (build 1243). No global package upgrades.
- **Checkout audit:** the copied project directory, `feature/sparkscope-fleet`, expected GitHub origin. Listed source, tests, migrations, CI, deployment files and both lockfiles are present. No applicable AGENTS.md was found. Removed legacy demo JS/CSS files correspond to the new generated `docs/assets/` layout. No reset, clean, remote overwrite, commit or push was used.
- **Transferred environments:** the old `.venv` referenced `/opt/homebrew/opt/python@3.14/bin`. It and `frontend/node_modules` were moved intact to `~/.local/share/sparkscope-migration/20260909-155851/`; fresh dependencies were installed using `uv sync --locked --python 3.12`, followed by `uv sync --locked`, and `npm ci --prefix frontend`. Lockfiles were not changed.
- **Data:** the default `~/.sparkscope/` was absent before setup. No SparkScope database/key or custom data configuration was found in the project, environment, checked shell/LaunchAgent references or searched user data locations (Documents, Desktop, Downloads, `.config`, `.local/share`, Application Support and the legacy default directory). Other projects' configuration files were left untouched. There is no transferred credential/key pair to validate. Explicit migration created schema `0001`; SQLite integrity is `ok`, users/devices are both zero. Startup generated `master.secret` and `setup.secret` with mode 0600 under the mode-0700 data directory. The new key passed an in-memory encryption/decryption round-trip without printing any secret values; no administrator was invented.
- **Backend:** SQLite alone: **16 passed**; then SQLite plus PostgreSQL 17.11: **27 passed**. The first sandboxed run could not bind the loopback AsyncSSH test server; rerunning with local networking permitted passed. The two previously noted dependency deprecation warnings remain. PostgreSQL used the separate `colima-sparkscope-test` Docker context and `sparkscope-postgres-test` container on `127.0.0.1:55432`, with test-only credentials and disposable per-test databases. The application database was never a test target. The test container and Colima VM were stopped after verification, with their files retained.
- **Static checks/builds:** Python Ruff lint and format (25 files), frontend Prettier, TypeScript/production build and `python3 scripts/build_demo.py` passed. npm installation reported zero dependency vulnerabilities. This is the install-time result, not a continuing security guarantee.
- **Browser:** all **five Playwright scenarios passed**. Additional Chromium inspection covered the static 50-device demo overview/inventory and the real application's first-run screen at 1440×1000 and 390×844. No JavaScript page errors. Inspection found that the visually hidden table heading escaped its scroll container, expanding the mobile document to 803 px. Adding a positioning context to `.table-scroll` restored 390 px document width while retaining table scrolling; the existing mobile test now checks both behaviors. Production and demo outputs were rebuilt after the fix.
- **Local servers:** backend `http://127.0.0.1:8010/`, Vite `http://127.0.0.1:5178/`, static demo `http://127.0.0.1:8012/?hosts=50`. Both direct and proxied `/api/v1/auth/status` returned `setup_required: true`. Browser checks did not create a local administrator. Demo data are explicitly synthetic; live hardware telemetry remains unverified.
- **Evidence:** local, Git-ignored `.runtime/validation/` contains browser results, six desktop/mobile screenshots, the visual-check script and `smoke.json`. The screenshots were inspected, not just generated.

The new-Mac synthetic run lasted **60.11 s**, with **50 devices**, **5 clients**, **5 expected offline devices**, **543 samples**, **150 WebSocket messages**, p95 latency **1.8931 s**, p95 queries **0.0378 s**, maximum payload **137,392 bytes**, peak process RSS **194.3 MB**, and no client errors. It passed the short smoke thresholds; `full_24h_gate` remains false. It used temporary synthetic data, not the local application database or real SSH devices.

To repeat the isolated database check on this Mac (the credentials below are only for this dedicated local test container):

```bash
colima start sparkscope-test --activate=false
docker --context colima-sparkscope-test start sparkscope-postgres-test
# Wait until pg_isready reports accepting connections.
docker --context colima-sparkscope-test exec sparkscope-postgres-test pg_isready -U sparkscope_test -d postgres
SPARKSCOPE_TEST_POSTGRES_URL=postgresql://sparkscope_test:test_only@127.0.0.1:55432/postgres uv run pytest -q
docker --context colima-sparkscope-test stop sparkscope-postgres-test
colima stop sparkscope-test
```

## Previous Mac completed checks (reported)

- 27 backend tests passed against SQLite and PostgreSQL 17, including authentication/roles/CSRF, onboarding/trust, encrypted credentials and rotation, legacy import, incident recovery, history aggregation, collector isolation and single-collector ownership.
- A local AsyncSSH server exercised real protocol authentication, host-key mismatch rejection, bounded command output and timeout handling. This is a protocol integration test, not a GB10 hardware test.
- Five browser scenarios cover 50-device pagination/search/history, empty-inventory onboarding, acknowledgement and command failure, viewer/mobile layout, and keyboard dialog focus.
- Production and shared-source demo builds, Python lint/format and frontend formatting are checked locally. CI definitions repeat database and browser checks; hosted CI has not run for these unpushed changes.

The backend test run emitted two dependency deprecation warnings from Starlette's test-client integrations; tests passed.

## Previous Mac short synthetic load result (reported)

A 60.25-second SQLite run used 50 simulated devices, 5 simultaneous viewers and 5 deliberately unavailable devices. It collected 558 samples and delivered 150 WebSocket messages. Observed p95 sample-to-client latency was 1.95 seconds; p95 inventory/history request time was 0.028 seconds; maximum payload was 137,391 bytes and peak process RSS was 208.4 MB. There were no client errors. This result tests application behavior on the development machine, not SSH capacity or a 24-hour retention workload.

Reproduce a smoke check:

```bash
uv run python -m sparkscope.load_test --duration 60 --devices 50 --clients 5 --output /tmp/sparkscope-smoke.json
```

## Remaining release gates

- **Real mixed hardware (GB10, CPU-only Linux and dual H200):** verify password and key onboarding, compare the displayed fingerprint, validate GB10 unified-memory/N/A metrics, all installed runtime providers, SMART permissions, interface/disk discovery, reconnect after reboot and actual operation outcomes. Test state-changing operations only in an agreed maintenance window.
- **24-hour reference-server soak:** use the intended server and a dedicated empty PostgreSQL test database; record CPU/RAM/disk/OS/database versions. Run the harness with `--duration 86400 --devices 50 --clients 5 --database-url postgresql+asyncpg://… --output /secure/test/soak.json`. It seeds test records and leaves them in that dedicated database. Require p95 latency ≤10 seconds, p95 queries ≤1 second, no unexpected client errors, and inspect memory, database growth, retention/rollups and outage recovery over time. The harness's `passed` flag alone does not validate all of these gates.
- **Deployment acceptance:** local isolated Compose/HTTPS/restart/restore and same-image data rollback passed as recorded above. The intended deployment server and host-reboot persistence still need validation. Rolling back to an identified previous application binary with its matching database/key backup remains open.
- **Publication tracking:** source verification runs in [GitHub Actions](https://github.com/canberkys/sparkscope/actions/workflows/ci.yml). The public synthetic demo is published from `main:/docs`; confirm the Pages build and served assets for the selected commit. GitHub publication is separate from installation on a real monitoring server.

Distributed collectors, high availability, bulk/network discovery and model installation/start/stop are outside this release's scope.
