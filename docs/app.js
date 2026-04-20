/**
 * GB10 Cluster Dashboard — Alpine.js + Chart.js + WebSocket client
 */

document.addEventListener('alpine:init', () => {
    Alpine.data('dashboard', () => ({
        // State
        connected: false,
        reconnecting: false,
        loading: true,
        hosts: {},
        alerts: { active: [], recent: [] },
        commands: {},
        commandHistory: [],
        showAlerts: false,
        showCommandModal: false,
        showOutputModal: false,
        commandModalData: null,
        commandOutput: null,
        commandRunning: false,
        selectedHost: 'all',
        commandTab: 'System',
        toasts: [],
        highlightedHost: null,
        currentTime: '',
        clockTimer: null,

        // Collapsible widget state — procs default collapsed
        collapsed: {
            // Default collapsed panels — keys match host names in config
            
        },

        // Time range for charts
        timeRange: 'live',  // 'live', '5m', '15m', '1h', '6h', '24h'
        timeRangeOptions: [
            { value: 'live', label: 'Live', seconds: 120 },
            { value: '5m', label: '5m', seconds: 300 },
            { value: '15m', label: '15m', seconds: 900 },
            { value: '1h', label: '1h', seconds: 3600 },
            { value: '6h', label: '6h', seconds: 21600 },
            { value: '24h', label: '24h', seconds: 86400 },
        ],

        // Sparkline data (last 30 values per metric)
        sparklines: {},

        // Chart instances
        charts: {},

        // WebSocket
        ws: null,
        wsRetryCount: 0,
        heartbeatTimer: null,

        // --- TV / NOC mode ---
        tvMode: false,
        tvRotateTimer: null,
        tvReloadTimer: null,

        _tvEscHandler: null,

        enterTvMode() {
            if (this.tvMode) return;
            if (window.innerWidth < 1024) {
                // Gracefully no-op on narrow viewports — TV mode needs wide display
                console.warn('TV mode requires viewport ≥ 1024px');
                return;
            }
            this.tvMode = true;
            document.body.classList.add('tv-mode');

            // Auto-rotate host highlight every 30s
            let i = 0;
            this.tvRotateTimer = setInterval(() => {
                const activeNames = Object.keys(this.hosts);
                if (activeNames.length === 0) return;
                const target = activeNames[i % activeNames.length];
                this.highlightHost(target);
                i++;
            }, 30000);

            // Auto-reload every 30 min (wall display freshness)
            this.tvReloadTimer = setTimeout(() => location.reload(), 30 * 60 * 1000);

            // Esc to exit
            this._tvEscHandler = (e) => {
                if (e.key === 'Escape' && this.tvMode) this.exitTvMode();
            };
            document.addEventListener('keydown', this._tvEscHandler);

            // Reflect in URL for deep-linking
            const url = new URL(location.href);
            url.searchParams.set('mode', 'tv');
            history.replaceState({}, '', url.toString());
        },

        exitTvMode() {
            this.tvMode = false;
            document.body.classList.remove('tv-mode');
            if (this.tvRotateTimer) { clearInterval(this.tvRotateTimer); this.tvRotateTimer = null; }
            if (this.tvReloadTimer) { clearTimeout(this.tvReloadTimer); this.tvReloadTimer = null; }
            if (this._tvEscHandler) { document.removeEventListener('keydown', this._tvEscHandler); this._tvEscHandler = null; }
            // Clear URL params
            const url = new URL(location.href);
            url.searchParams.delete('mode');
            url.searchParams.delete('tv');
            history.replaceState({}, '', url.toString());
        },

        toggleTvMode() {
            this.tvMode ? this.exitTvMode() : this.enterTvMode();
        },

        initTvMode() {
            // Auto-enter via ?mode=tv or ?tv=1 query param
            const params = new URLSearchParams(location.search);
            if (params.get('mode') === 'tv' || params.get('tv') === '1') {
                this.enterTvMode();
            }
        },

        async init() {
            this.loadHostExpansion();
            this.updateClock();
            this.clockTimer = setInterval(() => this.updateClock(), 1000);
            await this.loadCommands();
            await this.loadAlerts();
            await this.loadCommandHistory();
            this.connectWS();
            // Load last 5 min history after first data arrives
            setTimeout(() => {
                this.loadHistoricalCharts();
                this.loadHostInfo();
                // TV mode init after first data so hosts are populated
                this.initTvMode();
            }, 1000);
        },

        hostInfo: {},
        showHostInfo: {},

        // --- Host expansion state (persists in localStorage) ---
        hostExpansionStates: {},   // { neo: true, trinity: false, ... }
        _hostExpansionInitialized: false,

        loadHostExpansion() {
            try {
                const raw = localStorage.getItem('sparkscope.hostExpansion');
                if (raw) this.hostExpansionStates = JSON.parse(raw) || {};
            } catch { this.hostExpansionStates = {}; }
            this._hostExpansionInitialized = true;
        },
        saveHostExpansion() {
            if (!this._hostExpansionInitialized) return;
            try { localStorage.setItem('sparkscope.hostExpansion', JSON.stringify(this.hostExpansionStates)); } catch {}
        },
        isHostExpanded(name) {
            // Default: expanded (undefined means never toggled)
            return this.hostExpansionStates[name] !== false;
        },
        toggleHostExpanded(name) {
            const next = !this.isHostExpanded(name);
            // Reassign to new object to guarantee Alpine reactivity
            this.hostExpansionStates = { ...this.hostExpansionStates, [name]: next };
            this.saveHostExpansion();
        },

        // --- Health Dial ---
        // Arc length of semicircle with r=65: π × 65 ≈ 204.20
        DIAL_ARC_LENGTH: 204.2,

        computeHealthScore() {
            // Starts at 100; penalties stack. Only drives the hero dial.
            if (!this.hosts || Object.keys(this.hosts).length === 0) return 0;
            let score = 100;
            for (const host of Object.values(this.hosts)) {
                if (!host.online) { score -= 30; continue; }
                const m = host.metrics || {};
                const cpuTemp = m['cpu.temp_max_c'] || 0;
                if (cpuTemp >= 85) score -= 15;
                else if (cpuTemp >= 75) score -= 5;
                const gpuTemp = m['gpu.temp_c'] || 0;
                if (gpuTemp >= 90) score -= 15;
                else if (gpuTemp >= 80) score -= 5;
                if ((m['gpu.ecc_uncorrected'] || 0) > 0) score -= 20;
                if (m['gpu.throttle_active']) score -= 8;
                const diskPct = m['disk.root_used_pct'] || 0;
                if (diskPct >= 95) score -= 10;
                else if (diskPct >= 80) score -= 3;
                if ((m['memory.used_pct'] || 0) >= 90) score -= 5;
            }
            const activeAlerts = (this.alerts?.active || []).length;
            score -= activeAlerts * 5;
            return Math.max(0, Math.min(100, Math.round(score)));
        },

        get healthScore() { return this.computeHealthScore(); },

        get healthLevel() {
            const hosts = Object.values(this.hosts || {});
            if (!hosts.length || hosts.every(h => !h.online)) return 'dead';
            const s = this.healthScore;
            if (s >= 90) return 'ok';
            if (s >= 75) return 'ok';   // cyan / healthy band
            if (s >= 50) return 'warn';
            return 'crit';
        },

        get healthLabel() {
            return {
                ok: 'HEALTHY',
                warn: 'WARNING',
                crit: 'CRITICAL',
                dead: 'OFFLINE',
            }[this.healthLevel];
        },

        get healthDashOffset() {
            // 0 score → 204.2 offset (nothing drawn); 100 → 0 (full arc)
            return this.DIAL_ARC_LENGTH * (1 - this.healthScore / 100);
        },

        // --- Threshold-cross flash watcher ---
        // Tracks severity "bands" per metric and flashes the card when crossing.
        _prevBands: {},   // { 'neo.cpu_temp': 'ok' | 'warn' | 'crit', ... }
        _prevHealthLevel: null,

        _band(value, warn, crit) {
            if (value >= crit) return 'crit';
            if (value >= warn) return 'warn';
            return 'ok';
        },

        checkThresholdCrossings() {
            const flashes = [];   // list of DOM selectors to animate
            for (const [name, host] of Object.entries(this.hosts || {})) {
                if (!host.online || !host.metrics) continue;
                const m = host.metrics;
                const checks = [
                    { key: `${name}.cpu_temp`, sel: `#host-${name} [data-hero="cpu-temp"]`, val: m['cpu.temp_max_c'] || 0, warn: 75, crit: 85 },
                    { key: `${name}.gpu_temp`, sel: `#host-${name} [data-hero="gpu-temp"]`, val: m['gpu.temp_c'] || 0, warn: 80, crit: 90 },
                    { key: `${name}.power`,    sel: `#host-${name} [data-hero="power"]`,   val: m['gpu.power_draw_w'] || 0, warn: 150, crit: 200 },
                    { key: `${name}.cpu_usage`, sel: `#host-${name} [data-hero="cpu"]`,    val: m['cpu.usage_pct'] || 0, warn: 70, crit: 90 },
                    { key: `${name}.gpu_util`, sel: `#host-${name} [data-hero="gpu"]`,     val: m['gpu.util_pct'] || 0, warn: 70, crit: 90 },
                ];
                for (const c of checks) {
                    const band = this._band(c.val, c.warn, c.crit);
                    const prev = this._prevBands[c.key];
                    if (prev !== undefined && prev !== band) {
                        flashes.push(c.sel);
                    }
                    this._prevBands[c.key] = band;
                }
            }
            // Dial-level flash on health level change
            const curLvl = this.healthLevel;
            if (this._prevHealthLevel !== null && this._prevHealthLevel !== curLvl) {
                flashes.push('.health-dial-wrap');
            }
            this._prevHealthLevel = curLvl;

            // Apply animation — add class, remove after 800ms so it can re-trigger
            for (const sel of flashes) {
                document.querySelectorAll(sel).forEach(el => {
                    el.classList.remove('metric-flash', 'dial-flash');
                    // Force reflow to restart animation
                    void el.offsetWidth;
                    if (sel === '.health-dial-wrap') el.classList.add('dial-flash');
                    else el.classList.add('metric-flash');
                    setTimeout(() => el.classList.remove('metric-flash', 'dial-flash'), 900);
                });
            }
        },

        async loadHostInfo() {
            for (const name of Object.keys(this.hosts)) {
                try {
                    const r = await fetch(`/api/hosts/${name}/info`);
                    this.hostInfo = { ...this.hostInfo, [name]: await r.json() };
                } catch {}
            }
        },

        toggleHostInfo(name) {
            this.showHostInfo = { ...this.showHostInfo, [name]: !this.showHostInfo[name] };
        },

        async changeTimeRange(newRange) {
            this.timeRange = newRange;
            // Reset in-memory series so historical reload takes effect
            this.chartSeries = {};
            await this.loadHistoricalCharts();
        },

        async loadHistoricalCharts() {
            // Load data from DB based on selected time range
            const rangeOpt = this.timeRangeOptions.find(r => r.value === this.timeRange) || this.timeRangeOptions[0];
            const now = Math.floor(Date.now() / 1000);
            const from = now - rangeOpt.seconds;
            const hostNames = Object.keys(this.hosts);
            if (hostNames.length === 0) return;

            // Downsample if too many points (max 120 on chart)
            const downsample = (data, maxPoints) => {
                if (data.length <= maxPoints) return data.map(d => d.value);
                const step = Math.ceil(data.length / maxPoints);
                const result = [];
                for (let i = 0; i < data.length; i += step) {
                    const chunk = data.slice(i, i + step);
                    const avg = chunk.reduce((s, d) => s + d.value, 0) / chunk.length;
                    result.push(avg);
                }
                return result;
            };

            const fetchMetric = async (host, cat, metric) => {
                try {
                    const r = await fetch(`/api/metrics/history?host=${host}&category=${cat}&metric=${metric}&from_ts=${from}&to_ts=${now}`);
                    return await r.json();
                } catch { return []; }
            };

            for (const host of hostNames) {
                // CPU
                const cpuData = await fetchMetric(host, 'cpu', 'usage_pct');
                if (cpuData.length > 0) {
                    this.chartSeries[`cpu-${host}`] = {
                        datasets: [downsample(cpuData, 120)],
                        colors: ['#22d3ee'],
                        dashed: [false],
                        suggestedMax: 15,
                    };
                    this.renderBigChart(`cpu-${host}`);
                }

                // GPU (util + power)
                const [gpuUtil, gpuPower] = await Promise.all([
                    fetchMetric(host, 'gpu', 'util_pct'),
                    fetchMetric(host, 'gpu', 'power_draw_w'),
                ]);
                if (gpuUtil.length > 0 || gpuPower.length > 0) {
                    this.chartSeries[`gpu-${host}`] = {
                        datasets: [downsample(gpuUtil, 120), downsample(gpuPower, 120)],
                        colors: ['#a78bfa', '#fb923c'],
                        dashed: [false, true],
                        suggestedMax: 15,
                    };
                    this.renderBigChart(`gpu-${host}`);
                }

                // Disk (read + write)
                const [dRead, dWrite] = await Promise.all([
                    fetchMetric(host, 'disk', 'read_mbps'),
                    fetchMetric(host, 'disk', 'write_mbps'),
                ]);
                if (dRead.length > 0 || dWrite.length > 0) {
                    this.chartSeries[`disk-${host}`] = {
                        datasets: [downsample(dRead, 120), downsample(dWrite, 120)],
                        colors: ['#22d3ee', '#f87171'],
                        dashed: [false, false],
                        suggestedMax: 5,
                    };
                    this.renderBigChart(`disk-${host}`);
                }

                // Network (WiFi + Link0 + Link1)
                const [nWifiRx, nWifiTx, nL0Rx, nL0Tx, nL1Rx, nL1Tx] = await Promise.all([
                    fetchMetric(host, 'network', 'wifi_rx_mbps'),
                    fetchMetric(host, 'network', 'wifi_tx_mbps'),
                    fetchMetric(host, 'network', 'link0_rx_mbps'),
                    fetchMetric(host, 'network', 'link0_tx_mbps'),
                    fetchMetric(host, 'network', 'link1_rx_mbps'),
                    fetchMetric(host, 'network', 'link1_tx_mbps'),
                ]);
                if (nWifiRx.length > 0) {
                    this.chartSeries[`net-${host}`] = {
                        datasets: [
                            downsample(nWifiRx, 120), downsample(nWifiTx, 120),
                            downsample(nL0Rx, 120), downsample(nL0Tx, 120),
                            downsample(nL1Rx, 120), downsample(nL1Tx, 120),
                        ],
                        colors: ['#22d3ee', '#67e8f9', '#34d399', '#6ee7b7', '#c084fc', '#d8b4fe'],
                        dashed: [false, true, false, true, false, true],
                        suggestedMax: 10,
                    };
                    this.renderBigChart(`net-${host}`);
                }
            }
        },

        get isLiveMode() { return this.timeRange === 'live'; },

        updateClock() {
            const now = new Date();
            this.currentTime = now.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) +
                ' ' + now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        },

        // --- Collapsible ---
        isCollapsed(hostName, widget) {
            return this.collapsed[`${hostName}.${widget}`] ?? false;
        },
        toggleDetails(id) {
            const el = document.getElementById(id);
            if (el) el.open = !el.open;
        },

        renderChart(canvasId) {
            // Called from <details @toggle> when widget opens — re-render so canvas gets proper dimensions
            setTimeout(() => this.renderBigChart(canvasId), 50);
        },

        // --- WebSocket ---
        connectWS() {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            this.ws = new WebSocket(`${proto}//${location.host}/ws/live`);

            this.ws.onopen = () => {
                this.connected = true;
                this.reconnecting = false;
                this.wsRetryCount = 0;
                this.startHeartbeat();
            };

            this.ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data.type === 'metrics') {
                    this.hosts = data.hosts;
                    this.loading = false;
                    this.updateSparklines();
                    this.updateCharts();
                    this.checkThresholdCrossings();
                    // Refresh command history every 10 seconds
                    const now = Date.now();
                    if (!this._lastHistoryFetch || now - this._lastHistoryFetch > 10000) {
                        this._lastHistoryFetch = now;
                        this.loadCommandHistory();
                    }
                }
            };

            this.ws.onclose = () => {
                this.connected = false;
                this.stopHeartbeat();
                this.reconnect();
            };

            this.ws.onerror = () => { this.ws.close(); };
        },

        reconnect() {
            this.reconnecting = true;
            const delay = Math.min(5000 * Math.pow(1.5, this.wsRetryCount), 30000);
            this.wsRetryCount++;
            setTimeout(() => this.connectWS(), delay);
        },

        startHeartbeat() {
            this.heartbeatTimer = setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
            }, 15000);
        },

        stopHeartbeat() {
            if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        },

        // --- Data loading ---
        async loadCommands() {
            const r = await fetch('/api/commands');
            this.commands = await r.json();
        },
        async loadAlerts() {
            const r = await fetch('/api/alerts');
            this.alerts = await r.json();
        },
        async loadCommandHistory() {
            const r = await fetch('/api/commands/history');
            this.commandHistory = await r.json();
        },

        // --- Sparklines ---
        updateSparklines() {
            const keys = ['cpu.usage_pct', 'gpu.util_pct', 'gpu.power_draw_w', 'cpu.temp_max_c'];
            for (const key of keys) {
                if (!this.sparklines[key]) this.sparklines[key] = [];
                let val = 0;
                let count = 0;
                for (const h of Object.values(this.hosts)) {
                    if (h.online && h.metrics) {
                        val += (h.metrics[key] ?? 0);
                        count++;
                    }
                }
                const avg = count > 0 ? val / count : 0;
                this.sparklines[key].push(avg);
                if (this.sparklines[key].length > 30) this.sparklines[key].shift();
            }
            // Render sparkline canvases
            this.$nextTick(() => {
                for (const key of keys) {
                    this.renderSparkline(`spark-${key.replace('.', '-')}`, this.sparklines[key], key);
                }
            });
        },

        renderSparkline(canvasId, data, metric) {
            const canvas = document.getElementById(canvasId);
            if (!canvas || !data || data.length < 2) return;
            const ctx = canvas.getContext('2d');
            const w = canvas.width = canvas.offsetWidth * 2;
            const h = canvas.height = canvas.offsetHeight * 2;
            ctx.clearRect(0, 0, w, h);

            const max = Math.max(...data, 1);
            const min = Math.min(...data, 0);
            const range = max - min || 1;
            const step = w / (data.length - 1);

            // Color based on metric
            const colors = {
                'cpu.usage_pct': '#22d3ee',
                'gpu.util_pct': '#a78bfa',
                'gpu.power_draw_w': '#fb923c',
                'cpu.temp_max_c': '#34d399',
            };
            const color = colors[metric] || '#22d3ee';

            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            data.forEach((v, i) => {
                const x = i * step;
                const y = h - ((v - min) / range) * h * 0.8 - h * 0.1;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Fill
            const last = data.length - 1;
            ctx.lineTo(last * step, h);
            ctx.lineTo(0, h);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, color + '30');
            grad.addColorStop(1, color + '05');
            ctx.fillStyle = grad;
            ctx.fill();
        },

        // --- Raw canvas charts (replaces Chart.js to avoid bugs) ---
        chartSeries: {}, // {canvasId: {datasets: [[...], [...]], colors: [...], labels: [...], suggestedMax: num}}

        pushSeriesData(canvasId, values, colors, suggestedMax = 15, dashed = []) {
            // Only append live data when in live mode
            if (this.timeRange !== 'live') {
                // Just re-render what's loaded from history
                if (this.chartSeries[canvasId]) this.renderBigChart(canvasId);
                return;
            }
            if (!this.chartSeries[canvasId]) {
                this.chartSeries[canvasId] = {
                    datasets: values.map(() => []),
                    colors,
                    dashed,
                    suggestedMax,
                };
            }
            const series = this.chartSeries[canvasId];
            values.forEach((v, i) => {
                if (!series.datasets[i]) series.datasets[i] = [];
                series.datasets[i].push(v);
                if (series.datasets[i].length > 120) series.datasets[i].shift();
            });
            this.renderBigChart(canvasId);
        },

        toggleInfo(hostName) {
            const d = document.getElementById('info-' + hostName);
            if (d) d.open = !d.open;
        },

        _showChartTooltip(canvas, evt) {
            const series = this.chartSeries[canvas.id];
            if (!series || !series.datasets[0] || series.datasets[0].length < 2) return;

            const rect = canvas.getBoundingClientRect();
            const x = evt.clientX - rect.left;
            const padX = 40, chartW = rect.width - 50;
            if (x < padX || x > padX + chartW) return;

            const len = series.datasets[0].length;
            const step = chartW / (len - 1);
            const idx = Math.round((x - padX) / step);
            if (idx < 0 || idx >= len) return;

            let tip = document.getElementById('chart-tooltip');
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'chart-tooltip';
                tip.style.cssText = 'position:fixed;z-index:9999;background:#0f172aee;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:11px;font-family:Inter,sans-serif;color:#f1f5f9;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
                document.body.appendChild(tip);
            }

            const labels = this._getSeriesLabels(canvas.id);
            let html = '';
            series.datasets.forEach((ds, i) => {
                if (ds[idx] === undefined) return;
                const color = series.colors[i];
                const label = labels[i] || `Series ${i+1}`;
                html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:8px;height:8px;background:${color};border-radius:50%;display:inline-block;"></span><span style="color:#94a3b8;">${label}:</span><span style="font-weight:600;color:#f1f5f9;">${ds[idx].toFixed(2)}</span></div>`;
            });
            tip.innerHTML = html;
            tip.style.display = 'block';
            tip.style.left = (evt.clientX + 14) + 'px';
            tip.style.top = (evt.clientY - 10) + 'px';
        },

        _handleChartHover_DISABLED(canvas, evt) {
            // Store latest event, schedule rAF if not already scheduled
            canvas._lastEvent = evt;
            if (canvas._hoverRAF) return;
            canvas._hoverRAF = requestAnimationFrame(() => {
                canvas._hoverRAF = null;
                this._drawHoverOverlay(canvas, canvas._lastEvent);
            });
        },

        _drawHoverOverlay(canvas, evt) {
            const series = this.chartSeries[canvas.id];
            const geom = canvas._geom;
            if (!series || !geom || !evt) return;

            const rect = canvas.getBoundingClientRect();
            const x = evt.clientX - rect.left;
            if (x < geom.padX || x > geom.padX + geom.chartW) { this._hideTooltip(canvas); return; }

            const firstDs = series.datasets[0] || [];
            if (firstDs.length < 2) return;
            const step = geom.chartW / (firstDs.length - 1);
            const idx = Math.round((x - geom.padX) / step);
            if (idx < 0 || idx >= firstDs.length) return;

            // Restore from cached base image (no full redraw!)
            if (canvas._baseImage) {
                const ctx = canvas.getContext('2d');
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.putImageData(canvas._baseImage, 0, 0);
                ctx.scale(2, 2);

                // Compute max (same as renderBigChart)
                let max = series.suggestedMax;
                for (const d of series.datasets) for (const v of d) if (v > max) max = v;
                max = Math.ceil(max * 1.1);

                const lineX = geom.padX + idx * step;
                // Vertical crosshair
                ctx.strokeStyle = 'rgba(148,163,184,0.5)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(lineX, geom.padY);
                ctx.lineTo(lineX, geom.padY + geom.chartH);
                ctx.stroke();
                ctx.setLineDash([]);

                // Dots at intersection
                series.datasets.forEach((ds, i) => {
                    if (ds[idx] === undefined) return;
                    const dotY = geom.padY + geom.chartH - (ds[idx] / max) * geom.chartH;
                    ctx.fillStyle = series.colors[i];
                    ctx.beginPath();
                    ctx.arc(lineX, dotY, 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = '#0f172a';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                });
            }

            // Tooltip
            let tip = document.getElementById('chart-tooltip');
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'chart-tooltip';
                tip.style.cssText = 'position:fixed;z-index:9999;background:#0f172aee;border:1px solid #334155;border-radius:8px;padding:8px 12px;font-size:11px;font-family:Inter,sans-serif;color:#f1f5f9;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.4);backdrop-filter:blur(8px);';
                document.body.appendChild(tip);
            }
            const labels = this._getSeriesLabels(canvas.id);
            let html = '';
            series.datasets.forEach((ds, i) => {
                if (ds[idx] === undefined) return;
                const color = series.colors[i];
                const label = labels[i] || `Series ${i+1}`;
                html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:8px;height:8px;background:${color};border-radius:50%;display:inline-block;"></span><span style="color:#94a3b8;">${label}:</span><span style="font-weight:600;">${ds[idx].toFixed(2)}</span></div>`;
            });
            tip.innerHTML = html;
            tip.style.display = 'block';
            tip.style.left = (evt.clientX + 12) + 'px';
            tip.style.top = (evt.clientY - 10) + 'px';
        },

        _hideTooltip(canvas) {
            const tip = document.getElementById('chart-tooltip');
            if (tip) tip.style.display = 'none';
            // Restore base image (no redraw)
            if (canvas && canvas._baseImage) {
                const ctx = canvas.getContext('2d');
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.putImageData(canvas._baseImage, 0, 0);
            }
        },

        _getSeriesLabels(canvasId) {
            const m = {
                cpu: ['CPU %'],
                gpu: ['GPU %', 'Power W'],
                net: ['WiFi RX', 'WiFi TX', 'Link0 RX', 'Link0 TX', 'Link1 RX', 'Link1 TX'],
                disk: ['Read MB/s', 'Write MB/s'],
            };
            const prefix = canvasId.split('-')[0];
            return m[prefix] || [];
        },

        renderBigChart(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const series = this.chartSeries[canvasId];
            if (!series) return;

            // Attach hover listeners once (safe — doesn't touch canvas state)
            if (!canvas._hoverSetup) {
                canvas._hoverSetup = true;
                const self = this;
                canvas.addEventListener('mousemove', function(e) {
                    self._showChartTooltip(canvas, e);
                });
                canvas.addEventListener('mouseleave', function() {
                    const tip = document.getElementById('chart-tooltip');
                    if (tip) tip.style.display = 'none';
                });
            }

            // Use offsetWidth/Height directly (same approach as working sparklines)
            let w = canvas.offsetWidth;
            let h = canvas.offsetHeight;

            // Fallback: if canvas hasn't laid out yet, use parent
            if (w === 0 || h === 0) {
                const parent = canvas.parentElement;
                if (parent) {
                    const r = parent.getBoundingClientRect();
                    w = r.width - 8;
                    h = r.height - 8;
                }
            }
            if (w <= 10 || h <= 10) return;

            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            canvas.width = w * 2;
            canvas.height = h * 2;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.scale(2, 2);

            // Store render geometry for hover handler
            canvas._geom = { w, h, padX: 40, padY: 20, chartW: w - 50, chartH: h - 40 };
            const padX = 40;
            const padY = 20;
            const chartW = w - padX - 10;
            const chartH = h - padY - 20;

            ctx.clearRect(0, 0, w, h);

            // Find max value across all datasets
            let max = series.suggestedMax;
            let min = 0;
            for (const ds of series.datasets) {
                for (const v of ds) {
                    if (v > max) max = v;
                }
            }
            max = Math.ceil(max * 1.1);
            const range = max - min;

            // Draw grid
            ctx.strokeStyle = 'rgba(51,65,85,0.3)';
            ctx.lineWidth = 0.5;
            ctx.font = '10px Inter, sans-serif';
            ctx.fillStyle = '#475569';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';

            // Y axis lines + labels
            const ySteps = 4;
            for (let i = 0; i <= ySteps; i++) {
                const y = padY + (chartH * i) / ySteps;
                const val = max - (range * i) / ySteps;
                ctx.beginPath();
                ctx.moveTo(padX, y);
                ctx.lineTo(w - 10, y);
                ctx.stroke();
                ctx.fillText(val.toFixed(0), padX - 6, y);
            }

            // Draw each dataset
            series.datasets.forEach((data, dsIdx) => {
                if (data.length < 1) return;
                const color = series.colors[dsIdx];
                const isDashed = series.dashed[dsIdx];
                const step = data.length > 1 ? chartW / (data.length - 1) : 0;

                // Fill (only first dataset)
                if (dsIdx === 0 && data.length > 1) {
                    ctx.beginPath();
                    data.forEach((v, i) => {
                        const x = padX + i * step;
                        const y = padY + chartH - ((v - min) / range) * chartH;
                        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    });
                    ctx.lineTo(padX + (data.length - 1) * step, padY + chartH);
                    ctx.lineTo(padX, padY + chartH);
                    ctx.closePath();
                    const grad = ctx.createLinearGradient(0, padY, 0, padY + chartH);
                    grad.addColorStop(0, color + '60');
                    grad.addColorStop(1, color + '05');
                    ctx.fillStyle = grad;
                    ctx.fill();
                }

                // Line
                ctx.strokeStyle = color;
                ctx.lineWidth = 2.5;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.setLineDash(isDashed ? [6, 4] : []);
                ctx.beginPath();
                data.forEach((v, i) => {
                    const x = padX + i * step;
                    const y = padY + chartH - ((v - min) / range) * chartH;
                    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                });
                ctx.stroke();
                ctx.setLineDash([]);

                // Last point dot
                if (data.length > 0) {
                    const lastV = data[data.length - 1];
                    const lastX = padX + (data.length - 1) * step;
                    const lastY = padY + chartH - ((lastV - min) / range) * chartH;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            });

        },

        // --- Old Chart.js (kept for compatibility, now no-op) ---
        _baseOptions(yMin, yMax, showLegend = false) {
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: showLegend, position: 'top', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 10 } },
                    tooltip: { enabled: true },
                },
                scales: {
                    x: {
                        type: 'category',
                        grid: { color: 'rgba(51,65,85,0.2)' },
                        ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 5, autoSkip: true },
                    },
                    y: {
                        min: yMin,
                        suggestedMax: yMax === 'auto' ? 15 : undefined,
                        max: yMax !== 'auto' ? yMax : undefined,
                        grid: { color: 'rgba(51,65,85,0.2)' },
                        ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 4 },
                    },
                },
            };
        },

        initChart(canvasId, label, color, yMin = 0, yMax = 100) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return null;
            if (this.charts[canvasId]) this.charts[canvasId].destroy();

            const chart = new Chart(canvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label,
                        data: [],
                        borderColor: color,
                        backgroundColor: color + '33',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: 2.5,
                    }]
                },
                options: this._baseOptions(yMin, yMax, false),
            });
            this.charts[canvasId] = chart;
            return chart;
        },

        initMultiChart(canvasId, datasets, yMin = 0, yMax = 'auto') {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return null;
            if (this.charts[canvasId]) this.charts[canvasId].destroy();

            const chart = new Chart(canvas, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: datasets.map((d, i) => ({
                        label: d.label,
                        data: [],
                        borderColor: d.color,
                        backgroundColor: i === 0 ? d.color + '33' : 'transparent',
                        fill: i === 0,
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: d.dash ? 1.5 : 2.5,
                        borderDash: d.dash || [],
                    })),
                },
                options: this._baseOptions(yMin, yMax, true),
            });
            this.charts[canvasId] = chart;
            return chart;
        },

        _timeLabel() {
            const n = new Date();
            return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
        },

        pushChartData(canvasId, value) {
            const chart = this.charts[canvasId];
            if (!chart) return;
            chart.data.labels.push(this._timeLabel());
            chart.data.datasets[0].data.push(value);
            if (chart.data.labels.length > 150) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
            chart.update('none');
        },

        pushMultiChartData(canvasId, values) {
            const chart = this.charts[canvasId];
            if (!chart) return;
            chart.data.labels.push(this._timeLabel());
            chart.data.datasets.forEach((ds, i) => ds.data.push(values[i] ?? 0));
            if (chart.data.labels.length > 150) {
                chart.data.labels.shift();
                chart.data.datasets.forEach(ds => ds.data.shift());
            }
            chart.update('none');
        },

        updateCharts() {
            // Defer chart init so Alpine finishes rendering templates first
            setTimeout(() => this._doUpdateCharts(), 200);
        },

        _doUpdateCharts() {
            for (const [name, host] of Object.entries(this.hosts)) {
                if (!host.online || !host.metrics) continue;
                const m = host.metrics;

                this.pushSeriesData(`cpu-${name}`, [m['cpu.usage_pct'] ?? 0], ['#22d3ee'], 15, [false]);
                this.pushSeriesData(`gpu-${name}`,
                    [m['gpu.util_pct'] ?? 0, m['gpu.power_draw_w'] ?? 0],
                    ['#a78bfa', '#fb923c'], 15, [false, true]);
                this.pushSeriesData(`net-${name}`,
                    [
                        m['network.wifi_rx_mbps'] ?? 0, m['network.wifi_tx_mbps'] ?? 0,
                        m['network.link0_rx_mbps'] ?? 0, m['network.link0_tx_mbps'] ?? 0,
                        m['network.link1_rx_mbps'] ?? 0, m['network.link1_tx_mbps'] ?? 0,
                    ],
                    ['#22d3ee', '#67e8f9', '#34d399', '#6ee7b7', '#c084fc', '#d8b4fe'],
                    10, [false, true, false, true, false, true]);
                this.pushSeriesData(`disk-${name}`,
                    [m['disk.read_mbps'] ?? 0, m['disk.write_mbps'] ?? 0],
                    ['#22d3ee', '#f87171'], 5, [false, false]);
            }
        },

        // --- Commands ---
        async executeCommand(key, host) {
            const cmd = Object.values(this.commands).flat().find(c => c.key === key);
            if (!cmd) return;
            if (cmd.destructive) {
                this.commandModalData = { key, host, cmd };
                this.showCommandModal = true;
                return;
            }
            await this.runCommand(key, host);
        },

        async confirmCommand() {
            if (!this.commandModalData) return;
            await this.runCommand(this.commandModalData.key, this.commandModalData.host);
            this.showCommandModal = false;
            this.commandModalData = null;
        },

        async runCommand(key, host) {
            this.commandRunning = true;
            this.commandOutput = null;
            try {
                const r = await fetch('/api/commands/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host: host || this.selectedHost, key }),
                });
                const result = await r.json();
                this.commandOutput = result;
                this.showOutputModal = true;
                this.addToast(r.ok ? 'success' : 'error', `${key} — ${r.ok ? 'Success' : 'Error'}`);
                await this.loadCommandHistory();
            } catch (e) {
                this.addToast('error', `Command error: ${e.message}`);
            }
            this.commandRunning = false;
        },

        // --- Alerts ---
        async resolveAlert(id) {
            await fetch(`/api/alerts/${id}/resolve`, { method: 'POST' });
            await this.loadAlerts();
        },
        get activeAlertCount() { return this.alerts.active?.length || 0; },

        // --- Helpers ---
        formatUptime(seconds) {
            if (!seconds) return '—';
            const d = Math.floor(seconds / 86400);
            const h = Math.floor((seconds % 86400) / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            if (d > 0) return `${d}d ${h}h ${m}m`;
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        },
        formatBytes(kb) {
            if (!kb) return '0';
            const gb = kb / 1048576;
            if (gb >= 1) return gb.toFixed(1) + ' GB';
            return (kb / 1024).toFixed(0) + ' MB';
        },
        formatMB(mb) {
            if (!mb) return '0';
            const gb = mb / 1024;
            return gb >= 1 ? gb.toFixed(1) + ' GB' : mb.toFixed(0) + ' MB';
        },
        formatDiskBytes(bytes) {
            if (!bytes) return '0';
            const tb = bytes / 1e12;
            return tb >= 1 ? tb.toFixed(2) + ' TB' : (bytes / 1e9).toFixed(1) + ' GB';
        },
        tempColor(temp) {
            if (temp >= 85) return 'text-red-400';
            if (temp >= 75) return 'text-yellow-400';
            return 'text-green-400';
        },
        usageColor(pct) {
            if (pct >= 90) return '#f87171';
            if (pct >= 70) return '#fbbf24';
            return '#34d399';
        },
        m(host, key) { return this.hosts[host]?.metrics?.[key] ?? 0; },
        clusterTotal(key) {
            let sum = 0;
            for (const h of Object.values(this.hosts)) {
                if (h.online && h.metrics) sum += (h.metrics[key] ?? 0);
            }
            return sum;
        },
        clusterAvg(key) {
            let sum = 0, count = 0;
            for (const h of Object.values(this.hosts)) {
                if (h.online && h.metrics) { sum += (h.metrics[key] ?? 0); count++; }
            }
            return count > 0 ? sum / count : 0;
        },
        clusterMax(key) {
            let max = 0;
            for (const h of Object.values(this.hosts)) {
                if (h.online && h.metrics) { const v = h.metrics[key] ?? 0; if (v > max) max = v; }
            }
            return max;
        },
        highlightHost(name) {
            this.highlightedHost = name;
            document.getElementById(`host-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => { this.highlightedHost = null; }, 3000);
        },
        addToast(type, message) {
            const id = Date.now();
            this.toasts.push({ id, type, message });
            setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 4000);
        },
        timeAgo(ts) {
            if (!ts) return '—';
            const diff = Math.floor(Date.now() / 1000) - ts;
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            return `${Math.floor(diff / 3600)}h ago`;
        },
        get commandCategories() { return Object.keys(this.commands); },
        get filteredCommands() { return this.commands[this.commandTab] || []; },
        get recentCommands() { return (this.commandHistory || []).slice(0, 5); },

        lastCommandFor(hostName) {
            return (this.commandHistory || []).find(c => c.host === hostName);
        },
    }));
});
