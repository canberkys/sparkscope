/**
 * sparkscope — Browser-only demo shim for GitHub Pages.
 *
 * Replaces window.fetch + window.WebSocket with in-memory mock implementations
 * that stream synthetic metrics for 2 fake GB10 hosts (Neo + Trinity) and one
 * simulated vLLM inference server. Zero backend required.
 */

(function () {
    const START = Date.now();

    // --- Host roster (change to test 1/2/3/4+ node scenarios) ---
    // Each host has: name, display_name, management_ip, cluster_ip, cluster_peer_ip,
    //                phase (sinusoid offset), has_vllm (bool)
    const HOSTS = [
        { name: 'neo',      display: 'Neo (Upper)',       mgmt: '10.0.0.10', cluster: '192.168.100.10', peer: '192.168.100.11', phase: 0,              vllm: true,  seed: 1000 },
        { name: 'trinity',  display: 'Trinity (Lower)',   mgmt: '10.0.0.11', cluster: '192.168.100.11', peer: '192.168.100.10', phase: Math.PI / 2,    vllm: false, seed: 2000 },
        { name: 'morpheus', display: 'Morpheus (Rack 3)', mgmt: '10.0.0.12', cluster: '192.168.100.12', peer: '192.168.100.10', phase: Math.PI,        vllm: false, seed: 3000 },
        { name: 'tank',     display: 'Tank (Rack 4)',     mgmt: '10.0.0.13', cluster: '192.168.100.13', peer: '192.168.100.10', phase: 3 * Math.PI / 2, vllm: false, seed: 4000 },
    ];
    // Number of simulated hosts. Default 2. Override with ?hosts=N in URL (1..4).
    const _qp = new URLSearchParams(location.search);
    const _requested = parseInt(_qp.get('hosts') || '2', 10);
    const ACTIVE_COUNT = Math.max(1, Math.min(HOSTS.length, isNaN(_requested) ? 2 : _requested));

    // --- Per-host evolving state ---
    function makeHostState(cfg) {
        let r = cfg.seed;
        const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
        return {
            name: cfg.name,
            display: cfg.display,
            mgmt: cfg.mgmt,
            cluster: cfg.cluster,
            peer: cfg.peer,
            phase: cfg.phase,
            has_vllm: cfg.vllm,
            rand,
            total_prompt_tokens: Math.floor(rand() * 48000) + 2000,
            total_gen_tokens: Math.floor(rand() * 192000) + 8000,
            prefix_cache_queries: Math.floor(rand() * 4500) + 500,
            prefix_cache_hits: 0,
            boot_time: Date.now() / 1000 - (Math.floor(rand() * 86400 * 3) + 3600),
        };
    }
    const hostStates = {};
    for (const cfg of HOSTS.slice(0, ACTIVE_COUNT)) {
        const s = makeHostState(cfg);
        s.prefix_cache_hits = Math.floor(s.prefix_cache_queries * 0.3);
        hostStates[cfg.name] = s;
    }

    function gaussian(rand, mean, sd) {
        const u = 1 - rand(), v = rand();
        return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function tickHost(state) {
        const t = (Date.now() - START) / 1000;
        const cpuBase = 20 + 15 * Math.sin(t / 40 + state.phase);
        const cpuUsage = Math.max(1, Math.min(99, cpuBase + gaussian(state.rand, 0, 3)));

        const isInferenceActive = (Math.floor(t / 30) % 7) < 1;
        let gpuUtil, gpuPower;
        if (isInferenceActive) {
            gpuUtil = Math.max(60, Math.min(99, 85 + gaussian(state.rand, 0, 8)));
            gpuPower = 180 + gaussian(state.rand, 0, 15);
        } else {
            gpuUtil = Math.max(0, gaussian(state.rand, 2, 2));
            gpuPower = 5 + gaussian(state.rand, 0, 2);
        }

        const cpuTemp = 45 + cpuUsage * 0.4 + gaussian(state.rand, 0, 1);
        const gpuTemp = 42 + gpuUtil * 0.3 + gaussian(state.rand, 0, 1);
        const pollInterval = 2;

        let genThisTick = 0, promptThisTick = 0;
        if (isInferenceActive) {
            genThisTick = Math.floor((80 + state.rand() * 40) * pollInterval);
            promptThisTick = Math.floor(50 + state.rand() * 150);
        }
        state.total_gen_tokens += genThisTick;
        state.total_prompt_tokens += promptThisTick;
        if (promptThisTick > 0) {
            state.prefix_cache_queries += 1;
            if (state.rand() < 0.3) state.prefix_cache_hits += 1;
        }
        const genTokensPerS = genThisTick / pollInterval;

        const metrics = {
            'cpu.usage_pct': +cpuUsage.toFixed(1),
            'cpu.load_1m': +(cpuUsage / 25).toFixed(2),
            'cpu.load_5m': +(cpuUsage / 28).toFixed(2),
            'cpu.load_15m': +(cpuUsage / 32).toFixed(2),
            'cpu.temp_max_c': +cpuTemp.toFixed(1),
            'memory.total_kb': 127535936,
            'memory.free_kb': 100000000 - Math.floor(gpuPower * 10000),
            'memory.available_kb': 110000000 - Math.floor(gpuPower * 8000),
            'memory.buffers_kb': 368548,
            'memory.cached_kb': 3891420 + Math.floor((state.rand() - 0.5) * 200000),
            'memory.used_pct': +(15 + gpuPower / 10).toFixed(1),
            'memory.swap_total_kb': 0,
            'memory.swap_free_kb': 0,
            'disk.root_total_bytes': 3922556002304,
            'disk.root_used_bytes': 40634650624 + Math.floor(t * 100),
            'disk.root_used_pct': 1.0,
            'disk.read_iops': isInferenceActive ? +(state.rand() * 5).toFixed(1) : 0,
            'disk.write_iops': isInferenceActive ? +(state.rand() * 3).toFixed(1) : 0,
            'disk.read_mbps': isInferenceActive ? +(state.rand() * 1.5).toFixed(2) : 0,
            'disk.write_mbps': isInferenceActive ? +(state.rand() * 0.8).toFixed(2) : 0,
            'network.wifi_rx_mbps': +(state.rand() * 0.5).toFixed(3),
            'network.wifi_tx_mbps': +(state.rand() * 0.2).toFixed(3),
            'network.wifi_rx_errors': 0,
            'network.wifi_tx_errors': 0,
            'network.link0_rx_mbps': isInferenceActive ? +(state.rand() * 2).toFixed(3) : 0,
            'network.link0_tx_mbps': isInferenceActive ? +(state.rand() * 2).toFixed(3) : 0,
            'network.link0_rx_errors': 0,
            'network.link0_tx_errors': 0,
            'network.link1_rx_mbps': isInferenceActive ? +(state.rand() * 1).toFixed(3) : 0,
            'network.link1_tx_mbps': isInferenceActive ? +(state.rand() * 1).toFixed(3) : 0,
            'network.link1_rx_errors': 0,
            'network.link1_tx_errors': 0,
            'system.uptime_seconds': Date.now() / 1000 - state.boot_time,
            'system.process_count': 500 + Math.floor((state.rand() - 0.5) * 20),
            'system.zombie_count': 0,
            'gpu.util_pct': +gpuUtil.toFixed(1),
            'gpu.mem_util_pct': +(gpuUtil * 0.8).toFixed(1),
            'gpu.mem_total_mb': 0,
            'gpu.mem_free_mb': 0,
            'gpu.mem_used_mb': 0,
            'gpu.temp_c': +gpuTemp.toFixed(1),
            'gpu.power_draw_w': +Math.max(3, gpuPower).toFixed(2),
            'gpu.power_limit_w': 0,
            'gpu.sm_clock_mhz': Math.round(208 + gpuUtil * 25),
            'gpu.mem_clock_mhz': 0,
            'gpu.ecc_corrected': 0,
            'gpu.ecc_uncorrected': 0,
            'gpu.throttle_active': 0,
            'gpu.pcie_gen': 5,
            'gpu.persistence_mode': 1,
        };

        const procNames = [
            isInferenceActive ? 'python3 -m vllm.entrypoints.openai.api_server' : 'idle',
            'dockerd', 'containerd', 'sshd', 'systemd', 'node_exporter', 'kworker', 'rcu_sched',
        ];
        const top_procs = procNames.map((c, i) => ({
            pid: 1234 + i,
            user: i % 2 === 0 ? 'canberk' : 'root',
            cpu_pct: +(i === 0 ? 20 + state.rand() * 60 : state.rand() * 20).toFixed(1),
            mem_pct: +(state.rand() * 5).toFixed(1),
            command: c,
        }));
        const gpu_procs = isInferenceActive
            ? [{ pid: 554137, name: 'VLLM::EngineCore', mem_mb: 104639 }]
            : [];

        let vllm = null;
        if (state.has_vllm) {
            vllm = {
                active: true,
                container: 'vllm-qwen36',
                port: 8000,
                image: 'nvcr.io/nvidia/vllm:26.03-py3',
                model: 'qwen3.6-35b',
                model_root: '/models/Qwen3.6-35B-A3B-FP8',
                max_model_len: 65536,
                models_count: 1,
                requests_running: isInferenceActive ? 1 : 0,
                requests_waiting: 0,
                kv_cache_pct: +(isInferenceActive ? (0.1 + state.rand() * 15) : 0.1).toFixed(2),
                prompt_tokens_total: state.total_prompt_tokens,
                generation_tokens_total: state.total_gen_tokens,
                gen_tokens_per_s: +genTokensPerS.toFixed(2),
                prompt_tokens_per_s: +(promptThisTick / pollInterval).toFixed(2),
                prefix_cache_hit_pct: +((state.prefix_cache_hits / Math.max(state.prefix_cache_queries, 1)) * 100).toFixed(1),
            };
        }

        return { metrics, top_procs, gpu_procs, vllm };
    }

    function buildWsPayload() {
        const hosts = {};
        for (const [name, state] of Object.entries(hostStates)) {
            const data = tickHost(state);
            hosts[name] = {
                display_name: state.display,
                online: true,
                metrics: data.metrics,
                gpu_procs: data.gpu_procs,
                top_procs: data.top_procs,
                vllm: data.vllm,
                ts: Math.floor(Date.now() / 1000),
            };
        }
        return { type: 'metrics', hosts, ts: Math.floor(Date.now() / 1000) };
    }

    // --- Pre-seeded historical data for time-range queries ---
    function generateHistory(seconds) {
        const points = [];
        const now = Math.floor(Date.now() / 1000);
        const step = Math.max(2, Math.floor(seconds / 120));
        for (let t = now - seconds; t <= now; t += step) {
            points.push({ ts: t });
        }
        return points;
    }

    // --- Fake fetch ---
    const originalFetch = window.fetch;
    window.fetch = async function (url, opts) {
        url = typeof url === 'string' ? url : url.toString();

        if (url.includes('/api/commands/history')) {
            return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/commands') && !url.includes('/execute') && !url.includes('/history')) {
            const commands = {
                'System': [
                    { key: 'uptime', label: 'Show Uptime', destructive: false },
                    { key: 'check_updates', label: 'Check Available Updates', destructive: false },
                    { key: 'kernel_info', label: 'Kernel Info', destructive: false },
                    { key: 'reboot', label: 'Reboot', destructive: true, confirmation_text: 'The device will reboot. Are you sure?' },
                    { key: 'shutdown', label: 'Shutdown', destructive: true, confirmation_text: 'The device will shut down. Are you sure?' },
                ],
                'GPU': [
                    { key: 'nvidia_smi_full', label: 'nvidia-smi Full Output', destructive: false },
                    { key: 'gpu_processes', label: 'GPU Processes', destructive: false },
                    { key: 'gpu_reset', label: 'Reset GPU', destructive: true, confirmation_text: 'GPU will be reset. Are you sure?' },
                ],
                'Network': [
                    { key: 'interface_status', label: 'Interface Status', destructive: false },
                    { key: 'ping_cluster_peer', label: 'Ping Cluster Peer', destructive: false },
                    { key: 'wifi_quality', label: 'WiFi Signal Quality', destructive: false },
                ],
                'Logs': [
                    { key: 'dmesg_tail', label: 'dmesg (last 50)', destructive: false },
                    { key: 'journal_errors', label: 'Journal Errors (last 30)', destructive: false },
                    { key: 'nvidia_kernel_logs', label: 'NVIDIA Kernel Messages', destructive: false },
                ],
                'Package': [
                    { key: 'apt_update', label: 'apt update', destructive: false },
                    { key: 'apt_upgrade', label: 'apt upgrade', destructive: true, confirmation_text: 'All packages will be upgraded. Are you sure?' },
                ],
            };
            return new Response(JSON.stringify(commands), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/commands/execute')) {
            const body = JSON.parse(opts?.body || '{}');
            const fakeOutputs = {
                'uptime': ' 08:57:24 up 3 days, 14:32, 2 users, load average: 0.52, 0.58, 0.65',
                'nvidia_smi_full': 'Mon Apr 20 08:57:24 2026\n+---------------------------------------------------------------------------------------+\n| NVIDIA-SMI 580.126.09             Driver Version: 580.126.09     CUDA Version: 13.0  |\n+-----------------------------------------+----------------------+----------------------+\n| GPU  Name                 Persistence-M | Bus-Id        Disp.A | Volatile Uncorr. ECC |\n| Fan  Temp   Perf          Pwr:Usage/Cap |         Memory-Usage | GPU-Util  Compute M. |\n|=========================================+======================+======================|\n|   0  NVIDIA GB10                    On  |   00000000:00:00.0 Off |                    0 |\n|  N/A   47C    P8            3.6W / N/A  |           N/A / N/A  |      0%      Default |\n+-----------------------------------------+----------------------+----------------------+',
                'kernel_info': 'Linux host 6.17.0-1014-nvidia #14~24.04.1-Ubuntu SMP aarch64 GNU/Linux\nPRETTY_NAME="Ubuntu 24.04.4 LTS"',
                'interface_status': 'lo               UNKNOWN        127.0.0.1/8\nenp1s0f0np0      UP             192.168.100.10/24\nwlP9s9           UP             10.0.0.10/24',
            };
            const host = body.host === 'all' ? 'neo' : body.host;
            const result = {};
            for (const h of (body.host === 'all' ? ['neo', 'trinity'] : [body.host])) {
                result[h] = {
                    exit_code: 0,
                    stdout: `[demo] ${fakeOutputs[body.key] || 'Command output simulated in demo mode.'}\n`,
                    stderr: '',
                    duration_ms: 42,
                };
            }
            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/alerts')) {
            return new Response(JSON.stringify({ active: [], recent: [] }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.match(/\/api\/hosts\/(\w+)\/info/)) {
            const name = url.match(/\/api\/hosts\/(\w+)\/info/)[1];
            const state = hostStates[name];
            return new Response(JSON.stringify({
                name,
                display_name: state ? state.display : name,
                ssh_alias: name,
                management_ip: state ? state.mgmt : '',
                cluster_ip: state ? state.cluster : '',
                cluster_peer_ip: state ? state.peer : '',
                hostname: name,
                ip: state ? state.cluster : '',
                kernel: '6.17.0-1014-nvidia',
                os: 'Ubuntu 24.04.4 LTS (DGX OS)',
                gpu: 'NVIDIA GB10, 580.126.09',
            }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/metrics/history')) {
            const params = new URL(url, location.href).searchParams;
            const from = parseInt(params.get('from_ts'));
            const to = parseInt(params.get('to_ts'));
            const span = to - from;
            const points = generateHistory(span);
            // Simulate realistic waveform
            const data = points.map((p, i) => {
                const t = i / points.length;
                return { ts: p.ts, value: 20 + 15 * Math.sin(t * Math.PI * 4) + (Math.random() - 0.5) * 5 };
            });
            return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        }
        // Fall through to original fetch (static assets, etc.)
        return originalFetch.apply(this, arguments);
    };

    // --- Fake WebSocket ---
    class MockWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0; // CONNECTING
            this.onopen = null;
            this.onmessage = null;
            this.onclose = null;
            this.onerror = null;
            setTimeout(() => {
                this.readyState = 1; // OPEN
                if (this.onopen) this.onopen({});
                // Immediately send first payload
                if (this.onmessage) this.onmessage({ data: JSON.stringify(buildWsPayload()) });
                // Keep streaming every 2s
                this._interval = setInterval(() => {
                    if (this.readyState === 1 && this.onmessage) {
                        this.onmessage({ data: JSON.stringify(buildWsPayload()) });
                    }
                }, 2000);
            }, 200);
        }
        send(msg) { /* ignore pings */ }
        close() {
            this.readyState = 3;
            clearInterval(this._interval);
            if (this.onclose) this.onclose({});
        }
    }
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    window.WebSocket = MockWebSocket;

    // --- Demo banner ---
    window.addEventListener('DOMContentLoaded', () => {
        const banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(34,211,238,0.12);border:1px solid rgba(34,211,238,0.4);color:#67e8f9;padding:7px 16px;border-radius:20px;font-size:0.75rem;font-family:Inter,sans-serif;z-index:10000;letter-spacing:0.05em;backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,0.3);';
        banner.innerHTML = '🎭 <b>DEMO MODE</b> — Synthetic data, no real cluster connected. <a href="https://github.com/canberkys/sparkscope" style="color:#22d3ee;text-decoration:underline;">Source on GitHub</a>';
        document.body.appendChild(banner);
    });
})();
