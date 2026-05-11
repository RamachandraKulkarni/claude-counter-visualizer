// [SECURITY] Popup runs in its own context. Only consumes data from the
// service worker via runtime messages; never injects untrusted HTML.
(() => {
	'use strict';

	const KIND = Object.freeze({
		SNAPSHOT_PUT: 'snapshot.put',
		STATE_GET: 'state.get',
		STATE_CHANGED: 'state.changed',
		SETTINGS_GET: 'settings.get',
		SETTINGS_SET: 'settings.set',
		PING: 'ping',
		FOCUS_CHAT: 'focus.chat',
		SCROLL_TO_MESSAGE: 'scroll.to.message',
		HEAVIEST_MESSAGES_GET: 'heaviest.get',
		ROLLUPS_GET: 'rollups.get',
		OPEN_FORENSICS: 'open.forensics',
		MESSAGES_FOR_CONVERSATION: 'messages.forConversation',
		LIVE_STATE_GET: 'live.state.get',
		COMPOSER_INSERT: 'composer.insert'
	});

	const MODEL_COLORS = Object.freeze({
		opus: '#b04df0',
		sonnet: '#2c84db',
		haiku: '#4a9b5f',
		other: '#8a8a87',
		unknown: 'rgba(140,140,140,0.5)'
	});

	const MODEL_LABELS = Object.freeze({
		opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other', unknown: 'Unknown'
	});

	const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	const tabsApi = globalThis.browser?.tabs || globalThis.chrome?.tabs || null;

	// ---- DOM refs ----
	const el = (id) => document.getElementById(id);
	const refs = {
		stale: el('cc-stale'),
		version: el('cc-version'),
		nowContext: el('cc-now-context'),
		nowBar: el('cc-now-bar'),
		nowHealth: el('cc-now-health'),
		nowCache: el('cc-now-cache'),
		heaviestList: el('cc-heaviest-list'),
		sessionPct: el('cc-session-pct'),
		sessionBar: el('cc-session-bar'),
		sessionReset: el('cc-session-reset'),
		weeklyPct: el('cc-weekly-pct'),
		weeklyBar: el('cc-weekly-bar'),
		weeklyReset: el('cc-weekly-reset'),
		forecastSession: el('cc-forecast-session'),
		forecastWeekly: el('cc-forecast-weekly'),
		burnRate: el('cc-burn-rate'),
		sparkSession: el('cc-spark-session'),
		sparkWeekly: el('cc-spark-weekly'),
		openChat: el('cc-open-chat'),
		openOptions: el('cc-open-options'),
		claudeLink: el('cc-claude-link'),
		// Phase 2
		chatModels: el('cc-chat-models'),
		chatModelsText: el('cc-chat-models-text'),
		openForensics: el('cc-open-forensics'),
		modelsCard: el('cc-card-models'),
		modelsBar: el('cc-models-bar'),
		modelsLegend: el('cc-models-legend'),
		modelsSample: el('cc-models-sample'),
		modelsRatio: el('cc-models-ratio'),
		modelsRatioText: el('cc-models-ratio-text')
	};

	// ---- Version from manifest ----
	(function setVersion() {
		try {
			const v = runtime?.getManifest?.()?.version;
			if (v && refs.version) refs.version.textContent = `v${v}`;
		} catch { /* noop */ }
	})();

	// ---- Helpers ----
	function send(kind, payload) {
		return new Promise((resolve) => {
			if (!runtime?.sendMessage) { resolve(null); return; }
			try {
				const cb = (response) => {
					if (runtime.lastError) { resolve(null); return; }
					resolve(response);
				};
				const ret = runtime.sendMessage({ kind, payload }, cb);
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null));
			} catch { resolve(null); }
		});
	}

	/**
	 * Send to a specific tab's content script. Returns null when the tab has no
	 * receiver (e.g. claude.ai still loading) instead of leaving an unchecked
	 * runtime.lastError on the console.
	 */
	function sendToTab(tabId, kind, payload) {
		return new Promise((resolve) => {
			if (!tabsApi?.sendMessage || 'number' !== typeof tabId) { resolve(null); return; }
			try {
				const cb = (response) => {
					// [EDGE] Must read lastError on the callback to consume it.
					if (runtime?.lastError) { resolve(null); return; }
					resolve(response);
				};
				const ret = tabsApi.sendMessage(tabId, { kind, payload }, cb);
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null));
			} catch { resolve(null); }
		});
	}

	function formatPct(v) {
		if ('number' !== typeof v) return '—';
		return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
	}

	function formatCompact(v) {
		if ('number' !== typeof v) return '—';
		if (v >= 1000) return `${(Math.round(v / 100) / 10).toLocaleString()}k`;
		return v.toLocaleString();
	}

	function formatReset(ms) {
		if ('number' !== typeof ms) return '—';
		const diff = ms - Date.now();
		if (diff <= 0) return 'resets soon';
		const totalMin = Math.round(diff / 60000);
		if (totalMin < 60) return `resets in ${totalMin}m`;
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		if (h < 24) return `resets in ${h}h ${m}m`;
		const d = Math.floor(h / 24);
		const rh = h % 24;
		return `resets in ${d}d ${rh}h`;
	}

	function formatEta(ms) {
		if ('number' !== typeof ms || ms <= 0) return '—';
		const totalMin = Math.round(ms / 60000);
		if (totalMin < 60) return `${totalMin}m`;
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		if (h < 24) return `${h}h ${m}m`;
		const d = Math.floor(h / 24);
		const rh = h % 24;
		return `${d}d ${rh}h`;
	}

	function setBarClass(elBar, pct) {
		if (!elBar) return;
		elBar.classList.remove('cc-warn', 'cc-near', 'cc-crit');
		if (pct >= 95) elBar.classList.add('cc-crit');
		else if (pct >= 90) elBar.classList.add('cc-near');
		else if (pct >= 75) elBar.classList.add('cc-warn');
	}

	function setHealthChip(elChip, health) {
		if (!elChip) return;
		const klass = health === 'Extremely high' ? 'cc-chip-crit'
			: health === 'Nearing context' ? 'cc-chip-near'
				: health === 'Moderate' ? 'cc-chip-warn'
					: 'cc-chip-good';
		elChip.className = `cc-chip ${klass}`;
		elChip.textContent = health || '—';
	}

	function renderStale(state) {
		if (!refs.stale) return;
		if (!state?.lastUpdatedMs) { refs.stale.hidden = true; return; }
		const ageMs = Date.now() - state.lastUpdatedMs;
		const fiveMin = 5 * 60 * 1000;
		if (ageMs > fiveMin) {
			const min = Math.round(ageMs / 60000);
			refs.stale.hidden = false;
			refs.stale.textContent = `Stale — last updated ${min}m ago`;
		} else {
			refs.stale.hidden = true;
		}
	}

	// ---- Sparkline rendering (pure SVG; supports interactive points) ----
	const SVG_NS = 'http://www.w3.org/2000/svg';

	/**
	 * @param {SVGSVGElement} svg
	 * @param {Array<number|{value:number, dateKey?:string, isToday?:boolean, meta?:object}>} series
	 */
	function renderSparkline(svg, series) {
		if (!svg) return;
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		if (!Array.isArray(series) || series.length < 2) return;

		const w = 100;
		const h = 24;
		const points = series.map((s, i) => {
			const value = typeof s === 'number' ? s : (typeof s?.value === 'number' ? s.value : 0);
			return { value, meta: typeof s === 'number' ? null : s };
		});
		const max = Math.max(100, ...points.map((p) => p.value).filter(Number.isFinite));
		const range = Math.max(1, max);
		const stepX = w / Math.max(1, points.length - 1);

		const xy = points.map((p, i) => {
			const y = h - (p.value / range) * h;
			return [i * stepX, Math.max(0, Math.min(h, y))];
		});

		const pathD = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
		const fillD = `${pathD} L${w},${h} L0,${h} Z`;

		const fill = document.createElementNS(SVG_NS, 'path');
		fill.setAttribute('d', fillD);
		fill.setAttribute('class', 'cc-spark-fill');
		svg.appendChild(fill);

		const line = document.createElementNS(SVG_NS, 'path');
		line.setAttribute('d', pathD);
		svg.appendChild(line);

		// Interactive dots only for rollup-backed series (meta present).
		const interactive = points.some((p) => p.meta);
		if (!interactive) return;

		const tooltip = ensureSparkTooltip();
		xy.forEach(([x, y], i) => {
			const p = points[i];
			const dot = document.createElementNS(SVG_NS, 'circle');
			dot.setAttribute('cx', x.toFixed(2));
			dot.setAttribute('cy', y.toFixed(2));
			dot.setAttribute('r', '1.6');
			dot.setAttribute('class', `cc-spark-dot${p.meta?.isToday ? ' cc-spark-dot--today' : ''}`);
			dot.setAttribute('tabindex', '0');
			dot.setAttribute('role', 'img');
			dot.setAttribute('aria-label', describeRollupPoint(p.meta));

			const show = (event) => {
				const rect = svg.getBoundingClientRect();
				tooltip.hidden = false;
				tooltip.textContent = describeRollupPoint(p.meta);
				const px = rect.left + (x / 100) * rect.width;
				const py = rect.top + (y / 24) * rect.height - 4;
				tooltip.style.left = `${px}px`;
				tooltip.style.top = `${py}px`;
				void event; // not used
			};
			const hide = () => { tooltip.hidden = true; };
			dot.addEventListener('mouseenter', show);
			dot.addEventListener('mouseleave', hide);
			dot.addEventListener('focus', show);
			dot.addEventListener('blur', hide);
			svg.appendChild(dot);
		});
	}

	function ensureSparkTooltip() {
		let el = document.getElementById('cc-spark-tooltip');
		if (el) return el;
		el = document.createElement('div');
		el.id = 'cc-spark-tooltip';
		el.className = 'cc-spark-tooltip';
		el.hidden = true;
		el.setAttribute('role', 'tooltip');
		document.body.appendChild(el);
		return el;
	}

	function describeRollupPoint(meta) {
		if (!meta) return '—';
		const date = meta.dateKey || '';
		const peak = typeof meta.value === 'number' ? `peak ${Math.round(meta.value)}%` : '';
		const msgs = typeof meta.messageCount === 'number' ? `${meta.messageCount} msgs` : '';
		const tokens = typeof meta.totalTokens === 'number' ? `${formatCompact(meta.totalTokens)} tok` : '';
		const breakdown = renderModelBreakdownInline(meta.modelBreakdown);
		return [date, peak, msgs, tokens, breakdown].filter(Boolean).join(' · ');
	}

	function renderModelBreakdownInline(bd) {
		if (!bd) return '';
		const total = Object.values(bd).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
		if (total <= 0) return '';
		const order = ['opus', 'sonnet', 'haiku', 'other'];
		const parts = [];
		for (const id of order) {
			const t = bd[id] || 0;
			if (t <= 0) continue;
			parts.push(`${Math.round((t / total) * 100)}% ${MODEL_LABELS[id]}`);
		}
		return parts.join(' / ');
	}

	// ---- Heaviest messages list ----
	function renderHeaviest(items, conversationId) {
		const list = refs.heaviestList;
		if (!list) return;
		while (list.firstChild) list.removeChild(list.firstChild);
		if (!Array.isArray(items) || 0 === items.length) {
			const li = document.createElement('li');
			li.className = 'cc-empty';
			li.textContent = 'All messages are similarly sized.';
			list.appendChild(li);
			return;
		}
		for (const m of items) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.setAttribute('aria-label', `${m.tokens} tokens, ${m.role}`);

			const tokens = document.createElement('span');
			tokens.className = 'cc-heaviest-tokens';
			tokens.textContent = `~${formatCompact(m.tokens)}`;

			const snippet = document.createElement('span');
			snippet.className = 'cc-heaviest-snippet';
			// [SECURITY] textContent — never innerHTML — keeps message text safe.
			snippet.textContent = m.snippet || '(empty)';

			const role = document.createElement('span');
			role.className = 'cc-heaviest-role';
			role.textContent = m.role === 'assistant' ? 'A' : m.role === 'human' ? 'U' : '·';

			btn.appendChild(tokens);
			btn.appendChild(snippet);
			btn.appendChild(role);

			btn.addEventListener('click', () => {
				send(KIND.SCROLL_TO_MESSAGE, { messageId: m.id, conversationId });
				// Best-effort: close the popup so the user sees the chat.
				try { window.close(); } catch { /* noop */ }
			});

			li.appendChild(btn);
			list.appendChild(li);
		}
	}

	// ---- Per-model stacked bar (F9) ----
	function renderModelsBar(rollups) {
		if (!refs.modelsCard || !refs.modelsBar) return;
		const totals = aggregateModelBreakdown(rollups);
		const total = Object.values(totals).reduce((a, b) => a + b, 0);
		const usedIds = Object.keys(totals).filter((id) => totals[id] > 0);

		// Hide entire card when only one model (or zero) appears.
		if (total <= 0 || usedIds.length <= 1) {
			refs.modelsCard.hidden = true;
			return;
		}
		refs.modelsCard.hidden = false;

		// Clear and re-render segments.
		while (refs.modelsBar.firstChild) refs.modelsBar.removeChild(refs.modelsBar.firstChild);
		const order = ['opus', 'sonnet', 'haiku', 'other'];
		let x = 0;
		for (const id of order) {
			const t = totals[id] || 0;
			if (t <= 0) continue;
			const wPct = (t / total) * 100;
			const rect = document.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', x.toFixed(3));
			rect.setAttribute('y', '0');
			rect.setAttribute('width', wPct.toFixed(3));
			rect.setAttribute('height', '14');
			rect.setAttribute('fill', MODEL_COLORS[id]);
			rect.setAttribute('tabindex', '0');
			rect.setAttribute('role', 'img');
			rect.setAttribute('aria-label',
				`${MODEL_LABELS[id]}: ${Math.round(wPct)} percent, ${formatCompact(t)} tokens`);
			rect.dataset.id = id;
			// Native SVG title for hover.
			const title = document.createElementNS(SVG_NS, 'title');
			title.textContent = `${MODEL_LABELS[id]}: ${Math.round(wPct)}% · ${formatCompact(t)} tokens`;
			rect.appendChild(title);
			refs.modelsBar.appendChild(rect);
			x += wPct;
		}

		// Legend.
		const legend = refs.modelsLegend;
		while (legend.firstChild) legend.removeChild(legend.firstChild);
		for (const id of order) {
			if ((totals[id] || 0) <= 0) continue;
			const span = document.createElement('span');
			const dot = document.createElement('span');
			dot.className = 'cc-legend-dot';
			dot.style.background = MODEL_COLORS[id];
			const label = document.createElement('span');
			label.textContent = `${MODEL_LABELS[id]} · ${Math.round((totals[id] / total) * 100)}%`;
			span.appendChild(dot);
			span.appendChild(label);
			legend.appendChild(span);
		}

		// Sample size hint.
		if (refs.modelsSample) {
			const samples = rollups.reduce((acc, r) => acc + (r.messageCount || 0), 0);
			refs.modelsSample.textContent = `${samples} msgs`;
		}

		// Cost-comparison line — empirical ratio between the two most-used models.
		renderModelRatio(totals, rollups);
	}

	function aggregateModelBreakdown(rollups) {
		const out = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
		for (const r of rollups || []) {
			const bd = r?.modelBreakdown;
			if (!bd) continue;
			for (const id of Object.keys(out)) {
				out[id] += typeof bd[id] === 'number' ? bd[id] : 0;
			}
		}
		return out;
	}

	function renderModelRatio(totals, rollups) {
		if (!refs.modelsRatio || !refs.modelsRatioText) return;
		// Approximate per-model average from rollup totals using message-count.
		// We need msgCount per model to make this fair; aggregate from rollups.
		const counts = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
		// Best-effort: rollups currently track token totals per model but not
		// per-model message counts. Skip the ratio when we can't do it honestly.
		// (model-stats.js is reserved for content-script context, not popup.)
		void counts; void rollups;

		// Compute pairwise token-per-day ratio between the top two non-zero buckets.
		const sorted = Object.entries(totals)
			.filter(([, v]) => v > 0)
			.sort((a, b) => b[1] - a[1]);
		if (sorted.length < 2) { refs.modelsRatio.hidden = true; return; }
		const [topId, topVal] = sorted[0];
		const [, secondVal] = sorted[1];
		const [bottomId, bottomVal] = sorted[sorted.length - 1];
		if (bottomVal <= 0 || topVal <= 0 || topId === bottomId) { refs.modelsRatio.hidden = true; return; }

		const ratio = topVal / bottomVal;
		if (!Number.isFinite(ratio) || ratio < 1.05) { refs.modelsRatio.hidden = true; return; }
		const r = ratio >= 10 ? Math.round(ratio) : (Math.round(ratio * 10) / 10).toFixed(1);
		refs.modelsRatio.hidden = false;
		refs.modelsRatioText.textContent =
			`${MODEL_LABELS[topId]} burned ~${r}× the tokens of ${MODEL_LABELS[bottomId]} (your data, last 7d).`;
		// secondVal unused — kept for symmetry / future "top vs second" copy.
		void secondVal;
	}

	// ---- Per-chat model breakdown (F9 in Now card) ----
	function renderChatModels(rows) {
		if (!refs.chatModels || !refs.chatModelsText) return;
		if (!Array.isArray(rows) || 0 === rows.length) { refs.chatModels.hidden = true; return; }
		const buckets = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
		let total = 0;
		for (const m of rows) {
			const t = typeof m.tokens === 'number' ? m.tokens : 0;
			total += t;
			const id = ['opus', 'sonnet', 'haiku'].includes(m.model) ? m.model : 'other';
			buckets[id] += t;
		}
		if (total <= 0) { refs.chatModels.hidden = true; return; }
		const usedIds = Object.keys(buckets).filter((id) => buckets[id] > 0);
		if (usedIds.length <= 1) { refs.chatModels.hidden = true; return; }

		const parts = [];
		for (const id of ['opus', 'sonnet', 'haiku', 'other']) {
			if (buckets[id] <= 0) continue;
			parts.push(`${Math.round((buckets[id] / total) * 100)}% ${MODEL_LABELS[id]}`);
		}
		refs.chatModels.hidden = false;
		refs.chatModelsText.textContent = parts.join(' · ');
	}

	/**
	 * Query the active claude.ai tab for its live state. Returns null when no
	 * such tab exists or the content script doesn't answer.
	 */
	async function fetchLiveStateFromActiveTab() {
		if (!tabsApi?.query) return null;
		try {
			const tabs = await new Promise((resolve) => {
				const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
			});
			let tab = tabs[0];
			if (!tab) {
				// Fall back to any claude.ai tab — last-active wins per content script.
				const all = await new Promise((resolve) => {
					const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
					if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
				});
				tab = all[0];
			}
			if (!tab) return null;
			const res = await sendToTab(tab.id, KIND.LIVE_STATE_GET, {});
			return res?.ok && res.state ? res.state : null;
		} catch { return null; }
	}

	async function refreshHeaviest() {
		if (!tabsApi?.query) return;
		try {
			const tabs = await new Promise((resolve) => {
				const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
			});
			const tab = tabs[0];
			if (!tab) { renderHeaviest([], null); return; }
			const res = await sendToTab(tab.id, KIND.HEAVIEST_MESSAGES_GET, {});
			if (res?.ok) renderHeaviest(res.heaviest || [], res.conversationId);
			else renderHeaviest([], null);
		} catch { renderHeaviest([], null); }
	}

	// ---- 7-day rollup series for sparklines (Phase 2 F8) ----
	let lastRollups = [];

	function buildRollupSeries(rollups, key, currentLiveValue) {
		// Show last 7 days. Pad missing dates with zero so the sparkline always
		// renders a coherent 7-bar shape, and highlight today with current value.
		const days = 7;
		const today = new Date();
		const series = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
			const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
			const isToday = (i === 0);
			const row = rollups.find((r) => r.date === dateKey);
			const peak = isToday && typeof currentLiveValue === 'number'
				? currentLiveValue
				: (row && typeof row[key] === 'number' ? row[key] : 0);
			series.push({
				value: peak,
				dateKey,
				isToday,
				messageCount: row?.messageCount,
				totalTokens: row?.totalTokens,
				modelBreakdown: row?.modelBreakdown
			});
		}
		return series;
	}

	function renderState(state) {
		renderStale(state);
		if (!state?.snapshot) {
			refs.nowContext.textContent = '—';
			refs.sessionPct.textContent = '—';
			refs.weeklyPct.textContent = '—';
			refs.burnRate.textContent = '—';
			return;
		}
		const s = state.snapshot;

		// Now card
		if ('number' === typeof s.contextTokens) {
			refs.nowContext.textContent = `~${formatCompact(s.contextTokens)} of 200k`;
			const pct = Math.max(0, Math.min(100, s.contextPct || 0));
			refs.nowBar.style.width = `${pct}%`;
			setBarClass(refs.nowBar, pct);
		} else {
			refs.nowContext.textContent = '—';
			refs.nowBar.style.width = '0%';
		}
		setHealthChip(refs.nowHealth, s.contextHealth || 'Healthy');
		// Cache state — approximated: derived elsewhere from cachedUntil; here we just
		// show "cold" without a tab-side hint. (Phase 2 will surface the cache timer.)
		refs.nowCache.textContent = '—';

		// Session card
		if ('number' === typeof s.sessionPct) {
			refs.sessionPct.textContent = formatPct(s.sessionPct);
			const pct = Math.max(0, Math.min(100, s.sessionPct));
			refs.sessionBar.style.width = `${pct}%`;
			setBarClass(refs.sessionBar, pct);
			refs.sessionReset.textContent = formatReset(s.sessionResetMs);
		} else {
			refs.sessionPct.textContent = '—';
			refs.sessionBar.style.width = '0%';
			refs.sessionReset.textContent = '—';
		}

		// Weekly card
		if ('number' === typeof s.weeklyPct) {
			refs.weeklyPct.textContent = formatPct(s.weeklyPct);
			const pct = Math.max(0, Math.min(100, s.weeklyPct));
			refs.weeklyBar.style.width = `${pct}%`;
			setBarClass(refs.weeklyBar, pct);
			refs.weeklyReset.textContent = formatReset(s.weeklyResetMs);
		} else {
			refs.weeklyPct.textContent = '—';
			refs.weeklyBar.style.width = '0%';
			refs.weeklyReset.textContent = '—';
		}

		// Forecast
		const f = state.forecast || {};
		refs.forecastSession.textContent = describeForecast(f.session, s.sessionResetMs);
		refs.forecastWeekly.textContent = describeForecast(f.weekly, s.weeklyResetMs);

		// Burn rate readout — derived from forecast tokensPerTurn if SW provided it,
		// else fall back to a friendly placeholder.
		refs.burnRate.textContent = formatBurnRate(f);

		// History sparklines — backed by daily_rollups when available.
		renderSparkline(
			refs.sparkSession,
			buildRollupSeries(lastRollups, 'peakSessionPct', s.sessionPct)
		);
		renderSparkline(
			refs.sparkWeekly,
			buildRollupSeries(lastRollups, 'peakWeeklyPct', s.weeklyPct)
		);
	}

	function describeForecast(etaMs, resetMs) {
		if (etaMs === 0) return 'already capped';
		if ('number' !== typeof etaMs) return 'Need more data.';
		if ('number' === typeof resetMs && etaMs >= (resetMs - Date.now() - 1000)) {
			return `resets in ~${formatEta(etaMs)} before capping`;
		}
		return `caps in ~${formatEta(etaMs)} at current pace`;
	}

	function formatBurnRate(forecast) {
		if (!forecast) return '—';
		if ('number' === typeof forecast.tokensPerTurn && forecast.tokensPerTurn > 0) {
			return `~${formatCompact(forecast.tokensPerTurn)} tok/turn`;
		}
		return '—';
	}

	// ---- Footer actions ----
	if (refs.openChat) {
		refs.openChat.addEventListener('click', async () => {
			await send(KIND.FOCUS_CHAT);
			try { window.close(); } catch { /* noop */ }
		});
	}

	if (refs.openOptions) {
		refs.openOptions.addEventListener('click', () => {
			try { runtime?.openOptionsPage?.(); } catch { /* noop */ }
		});
	}

	if (refs.openForensics) {
		refs.openForensics.addEventListener('click', async () => {
			// Pull the active chat id so the forensics page can scope to it.
			let conversationId = null;
			try {
				const tabs = await new Promise((resolve) => {
					if (!tabsApi?.query) { resolve([]); return; }
					const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
					if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
				});
				const url = tabs[0]?.url || '';
				const m = url.match(/\/chat\/([^/?#]+)/);
				if (m) conversationId = m[1];
			} catch { /* noop */ }
			await send(KIND.OPEN_FORENSICS, { conversationId });
			try { window.close(); } catch { /* noop */ }
		});
	}

	// ---- Boot ----
	async function boot() {
		// 1. Pull 7d rollups before first render so sparklines have data.
		try {
			const rRes = await send(KIND.ROLLUPS_GET, { days: 7 });
			if (rRes?.ok && Array.isArray(rRes.rollups)) lastRollups = rRes.rollups;
		} catch { /* noop */ }

		// 2. Pull cached state from service worker (no claude.ai tab required).
		let state = null;
		const res = await send(KIND.STATE_GET);
		if (res?.state?.snapshot) state = res.state;

		// 3. Fallback: ask the active claude.ai tab for its live state. Covers
		//    the case where the SW cache is empty (first install, just-installed
		//    upgrade) but the content script already has usage + context data.
		if (!state) {
			const liveTabState = await fetchLiveStateFromActiveTab();
			if (liveTabState) state = liveTabState;
		}

		renderState(state);

		// 4. Per-model card from rollups.
		renderModelsBar(lastRollups);

		// 5. Pull heaviest list from active claude.ai tab if any.
		refreshHeaviest();

		// Per-chat model breakdown — read messages_meta for the active chat
		//    through the service worker (works even when the tab is closed).
		try {
			let conversationId = null;
			if (tabsApi?.query) {
				const tabs = await new Promise((resolve) => {
					const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
					if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
				});
				const url = tabs[0]?.url || '';
				const m = url.match(/\/chat\/([^/?#]+)/);
				if (m) conversationId = m[1];
			}
			if (conversationId) {
				const mRes = await send(KIND.MESSAGES_FOR_CONVERSATION, { conversationId });
				if (mRes?.ok) renderChatModels(mRes.messages || []);
			}
		} catch { /* noop */ }

		// 6. Subscribe to live state updates via long-lived port.
		try {
			const port = runtime?.connect?.({ name: 'cc-popup' });
			if (port) {
				port.onMessage.addListener((msg) => {
					if (msg?.kind === KIND.STATE_CHANGED) {
						renderState(msg.payload);
					}
				});
			}
		} catch { /* SW may be asleep; one-shot state above is enough */ }
	}

	boot();

	// =====================================================================
	// Phase 3 — Memory tab
	// =====================================================================

	const memRefs = {
		dashboardPanel: document.getElementById('cc-tab-dashboard'),
		memoryPanel: document.getElementById('cc-tab-memory'),
		dashboardTab: document.getElementById('cc-tab-dashboard-btn'),
		memoryTab: document.getElementById('cc-tab-memory-btn'),
		pinCount: document.getElementById('cc-pin-count'),
		search: document.getElementById('cc-mem-search'),
		project: document.getElementById('cc-mem-project'),
		range: document.getElementById('cc-mem-range'),
		tags: document.getElementById('cc-mem-tags'),
		activeFilters: document.getElementById('cc-mem-active-filters'),
		list: document.getElementById('cc-mem-list'),
		empty: document.getElementById('cc-mem-empty'),
		selectAll: document.getElementById('cc-mem-selectall'),
		countLabel: document.getElementById('cc-mem-count'),
		bulk: document.getElementById('cc-mem-bulk'),
		bulkCount: document.getElementById('cc-mem-bulk-count'),
		bulkCopy: document.getElementById('cc-mem-bulk-copy'),
		bulkExport: document.getElementById('cc-mem-bulk-export'),
		bulkInsert: document.getElementById('cc-mem-bulk-insert'),
		bulkUnpin: document.getElementById('cc-mem-bulk-unpin'),
		// Modal
		modal: document.getElementById('cc-inject-modal'),
		modalClose: document.getElementById('cc-inject-close'),
		modalCancel: document.getElementById('cc-inject-cancel'),
		modalConfirm: document.getElementById('cc-inject-confirm'),
		modalBackdrop: document.getElementById('cc-inject-backdrop'),
		modalPreview: document.getElementById('cc-inject-preview'),
		modalMeta: document.getElementById('cc-inject-meta')
	};

	const memState = {
		allPins: [],
		selectedTags: new Set(),
		selectedIds: new Set(),
		expandedIds: new Set(),
		undoTimer: null
	};

	function switchTab(which) {
		const isMemory = which === 'memory';
		memRefs.dashboardPanel.hidden = isMemory;
		memRefs.memoryPanel.hidden = !isMemory;
		memRefs.dashboardTab.classList.toggle('cc-tab--active', !isMemory);
		memRefs.memoryTab.classList.toggle('cc-tab--active', isMemory);
		memRefs.dashboardTab.setAttribute('aria-selected', String(!isMemory));
		memRefs.memoryTab.setAttribute('aria-selected', String(isMemory));
		if (isMemory) refreshMemory();
	}

	memRefs.dashboardTab?.addEventListener('click', () => switchTab('dashboard'));
	memRefs.memoryTab?.addEventListener('click', () => switchTab('memory'));

	// ---------- Pin data fetch (popup reads IndexedDB directly) ----------

	function openPinsDb() {
		return new Promise((resolve) => {
			try {
				const req = indexedDB.open('claude_counter_v1');
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(null);
			} catch { resolve(null); }
		});
	}

	async function fetchAllPins() {
		const db = await openPinsDb();
		if (!db) return [];
		if (!db.objectStoreNames.contains('pins')) return [];
		return new Promise((resolve) => {
			try {
				const tx = db.transaction('pins', 'readonly');
				const req = tx.objectStore('pins').getAll();
				req.onsuccess = () => resolve(req.result || []);
				req.onerror = () => resolve([]);
			} catch { resolve([]); }
		});
	}

	async function deletePinById(id) {
		const db = await openPinsDb();
		if (!db || !db.objectStoreNames.contains('pins')) return false;
		return new Promise((resolve) => {
			try {
				const tx = db.transaction('pins', 'readwrite');
				const req = tx.objectStore('pins').delete(id);
				req.onsuccess = () => resolve(true);
				req.onerror = () => resolve(false);
			} catch { resolve(false); }
		});
	}

	async function putPinRow(row) {
		const db = await openPinsDb();
		if (!db || !db.objectStoreNames.contains('pins')) return false;
		return new Promise((resolve) => {
			try {
				const tx = db.transaction('pins', 'readwrite');
				const req = tx.objectStore('pins').put(row);
				req.onsuccess = () => resolve(true);
				req.onerror = () => resolve(false);
			} catch { resolve(false); }
		});
	}

	async function refreshMemory() {
		memState.allPins = await fetchAllPins();
		memState.allPins.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		// Update pin count badge in tab.
		if (memRefs.pinCount) {
			if (memState.allPins.length > 0) {
				memRefs.pinCount.hidden = false;
				memRefs.pinCount.textContent = String(memState.allPins.length);
			} else {
				memRefs.pinCount.hidden = true;
			}
		}

		hydrateFilters();
		renderPinList();
	}

	// ---------- Filters ----------

	function hydrateFilters() {
		// Project (chat) options
		const seen = new Map();
		for (const p of memState.allPins) {
			const key = p.conversationId || 'unknown';
			if (!seen.has(key)) seen.set(key, p.chatTitle || key.slice(0, 8));
		}
		const projectEl = memRefs.project;
		const currentValue = projectEl.value;
		while (projectEl.children.length > 1) projectEl.removeChild(projectEl.lastChild);
		for (const [id, title] of seen.entries()) {
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = title.length > 30 ? title.slice(0, 30) + '…' : title;
			projectEl.appendChild(opt);
		}
		projectEl.value = currentValue || '';

		// Tag chips — sorted by frequency
		const tagCounts = new Map();
		for (const p of memState.allPins) {
			for (const t of p.tags || []) {
				tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
			}
		}
		const sortedTags = Array.from(tagCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 40);
		const tagsEl = memRefs.tags;
		while (tagsEl.firstChild) tagsEl.removeChild(tagsEl.firstChild);
		for (const [tag, count] of sortedTags) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'cc-mem-tag' + (memState.selectedTags.has(tag) ? ' cc-mem-tag--active' : '');
			chip.textContent = `${tag} · ${count}`;
			chip.dataset.tag = tag;
			chip.addEventListener('click', () => {
				if (memState.selectedTags.has(tag)) memState.selectedTags.delete(tag);
				else memState.selectedTags.add(tag);
				hydrateFilters();
				renderPinList();
			});
			tagsEl.appendChild(chip);
		}

		renderActiveFilterChips();
	}

	function renderActiveFilterChips() {
		const node = memRefs.activeFilters;
		while (node.firstChild) node.removeChild(node.firstChild);
		const chips = [];
		if (memRefs.search.value.trim()) chips.push({ label: `search: "${memRefs.search.value.trim()}"`, clear: () => { memRefs.search.value = ''; } });
		if (memRefs.project.value) {
			const title = memRefs.project.options[memRefs.project.selectedIndex]?.text || memRefs.project.value;
			chips.push({ label: `chat: ${title}`, clear: () => { memRefs.project.value = ''; } });
		}
		if (memRefs.range.value !== 'all') chips.push({ label: `range: ${memRefs.range.value}`, clear: () => { memRefs.range.value = 'all'; } });
		for (const t of memState.selectedTags) chips.push({ label: `#${t}`, clear: () => memState.selectedTags.delete(t) });

		if (chips.length === 0) { node.hidden = true; return; }
		node.hidden = false;
		for (const c of chips) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = `${c.label} ✕`;
			btn.addEventListener('click', () => {
				c.clear();
				hydrateFilters();
				renderPinList();
			});
			node.appendChild(btn);
		}
	}

	function applyFilters(pins) {
		const search = memRefs.search.value.trim().toLowerCase();
		const project = memRefs.project.value;
		const range = memRefs.range.value;
		const tags = memState.selectedTags;

		let lowerTs = -Infinity;
		const now = Date.now();
		if (range === 'today') {
			const d = new Date(); d.setHours(0, 0, 0, 0);
			lowerTs = d.getTime();
		} else if (range === '7d') lowerTs = now - 7 * 86_400_000;
		else if (range === '30d') lowerTs = now - 30 * 86_400_000;

		return pins.filter((p) => {
			if (lowerTs > -Infinity && !(p.createdAt >= lowerTs)) return false;
			if (project && p.conversationId !== project) return false;
			if (tags.size > 0) {
				const pt = p.tags || [];
				for (const t of tags) if (!pt.includes(t)) return false;
			}
			if (search) {
				const hay = `${p.content || ''}\n${p.chatTitle || ''}`.toLowerCase();
				if (!hay.includes(search)) return false;
			}
			return true;
		});
	}

	// ---------- List rendering ----------

	const MEM_VIRTUAL_CAP = 200;

	function formatDateShort(ts) {
		if (typeof ts !== 'number') return '—';
		try { return new Date(ts).toISOString().slice(0, 10); } catch { return '—'; }
	}

	const MODEL_LABEL_SHORT = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', unknown: '·', other: '·' };
	const MODEL_COLOR_MEM = { opus: '#b04df0', sonnet: '#2c84db', haiku: '#4a9b5f', other: '#8a8a87', unknown: 'rgba(140,140,140,0.5)' };

	function renderPinList() {
		const filtered = applyFilters(memState.allPins);
		memRefs.countLabel.textContent = `${filtered.length} pin${filtered.length === 1 ? '' : 's'}`;
		memRefs.empty.hidden = filtered.length > 0;

		const list = memRefs.list;
		while (list.firstChild) list.removeChild(list.firstChild);

		const slice = filtered.slice(0, MEM_VIRTUAL_CAP);
		for (const pin of slice) list.appendChild(buildPinRow(pin));
		if (filtered.length > MEM_VIRTUAL_CAP) {
			const more = document.createElement('li');
			more.style.color = 'var(--cc-text-muted)';
			more.style.fontSize = '11px';
			more.style.textAlign = 'center';
			more.style.padding = '8px';
			more.textContent = `Showing first ${MEM_VIRTUAL_CAP} of ${filtered.length}. Narrow filters to see the rest.`;
			list.appendChild(more);
		}

		updateBulkBar();
	}

	function buildPinRow(pin) {
		const li = document.createElement('li');
		li.className = 'cc-mem-row';
		if (memState.selectedIds.has(pin.id)) li.classList.add('cc-mem-row--selected');
		if (memState.expandedIds.has(pin.id)) li.classList.add('cc-mem-row--expanded');
		li.dataset.id = pin.id;

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = memState.selectedIds.has(pin.id);
		checkbox.setAttribute('aria-label', 'Select pin');
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) memState.selectedIds.add(pin.id);
			else memState.selectedIds.delete(pin.id);
			li.classList.toggle('cc-mem-row--selected', checkbox.checked);
			updateBulkBar();
		});

		const main = document.createElement('div');
		main.className = 'cc-mem-row-main';

		const head = document.createElement('div');
		head.className = 'cc-mem-row-head';
		const modelDot = document.createElement('span');
		modelDot.className = 'cc-model-badge';
		modelDot.style.background = MODEL_COLOR_MEM[pin.model] || MODEL_COLOR_MEM.unknown;
		modelDot.title = MODEL_LABEL_SHORT[pin.model] || pin.model || 'Unknown';
		const title = document.createElement('span');
		title.className = 'cc-mem-row-title';
		title.textContent = pin.chatTitle || 'Untitled chat';
		const meta = document.createElement('span');
		meta.className = 'cc-mem-row-meta';
		meta.textContent = `${formatDateShort(pin.createdAt)} · ${formatCompact(pin.tokenCount || 0)} tok`;
		head.appendChild(modelDot);
		head.appendChild(title);
		head.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'cc-mem-row-body';
		body.textContent = pin.content || '(empty)';
		body.tabIndex = 0;
		body.setAttribute('role', 'button');
		body.setAttribute('aria-expanded', memState.expandedIds.has(pin.id) ? 'true' : 'false');
		const toggleExpand = () => {
			if (memState.expandedIds.has(pin.id)) memState.expandedIds.delete(pin.id);
			else memState.expandedIds.add(pin.id);
			li.classList.toggle('cc-mem-row--expanded');
			body.setAttribute('aria-expanded', memState.expandedIds.has(pin.id) ? 'true' : 'false');
		};
		body.addEventListener('click', toggleExpand);
		body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } });

		const tagWrap = document.createElement('div');
		tagWrap.className = 'cc-mem-row-tags';
		for (const t of (pin.tags || []).slice(0, 10)) {
			const tag = document.createElement('span');
			tag.className = 'cc-mem-row-tag';
			tag.textContent = `#${t}`;
			tagWrap.appendChild(tag);
		}

		const actions = document.createElement('div');
		actions.className = 'cc-mem-row-actions';

		const copyBtn = document.createElement('button');
		copyBtn.type = 'button'; copyBtn.textContent = 'Copy';
		copyBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			try { await navigator.clipboard.writeText(pin.content || ''); }
			catch { /* permission denied */ }
		});

		const openBtn = document.createElement('button');
		openBtn.type = 'button'; openBtn.textContent = 'Open chat';
		openBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (pin.sourceUrl) {
				try { runtime?.openOptionsPage; const tabs = globalThis.browser?.tabs || globalThis.chrome?.tabs; tabs?.create?.({ url: pin.sourceUrl }); }
				catch { /* noop */ }
			}
		});

		const unpinBtn = document.createElement('button');
		unpinBtn.type = 'button'; unpinBtn.textContent = 'Unpin';
		unpinBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			await unpinWithUndo(pin);
		});

		actions.appendChild(copyBtn);
		actions.appendChild(openBtn);
		actions.appendChild(unpinBtn);

		main.appendChild(head);
		main.appendChild(body);
		if ((pin.tags || []).length > 0) main.appendChild(tagWrap);
		main.appendChild(actions);

		li.appendChild(checkbox);
		li.appendChild(main);
		return li;
	}

	async function unpinWithUndo(pin) {
		const snapshot = JSON.parse(JSON.stringify(pin));
		const ok = await deletePinById(pin.id);
		if (!ok) return;
		// Optimistic removal from in-memory state.
		memState.allPins = memState.allPins.filter((p) => p.id !== pin.id);
		memState.selectedIds.delete(pin.id);
		renderPinList();
		hydrateFilters();
		showInlineToast(`Unpinned "${(pin.chatTitle || 'pin').slice(0, 30)}"`, {
			actionLabel: 'Undo',
			onAction: async () => {
				const restored = await putPinRow(snapshot);
				if (restored) await refreshMemory();
			},
			duration: 10_000
		});
	}

	// ---------- Bulk actions ----------

	function updateBulkBar() {
		const selected = memState.selectedIds.size;
		memRefs.bulk.hidden = selected === 0;
		memRefs.bulkCount.textContent = `${selected} selected`;
	}

	function selectedPins() {
		return memState.allPins.filter((p) => memState.selectedIds.has(p.id));
	}

	memRefs.selectAll?.addEventListener('change', () => {
		const filtered = applyFilters(memState.allPins).slice(0, MEM_VIRTUAL_CAP);
		if (memRefs.selectAll.checked) {
			for (const p of filtered) memState.selectedIds.add(p.id);
		} else {
			for (const p of filtered) memState.selectedIds.delete(p.id);
		}
		renderPinList();
	});

	memRefs.bulkCopy?.addEventListener('click', async () => {
		const text = selectedPins().map((p) => `## ${p.chatTitle || ''}\n${p.content || ''}`).join('\n\n---\n\n');
		try { await navigator.clipboard.writeText(text); showInlineToast(`Copied ${memState.selectedIds.size} pin${memState.selectedIds.size === 1 ? '' : 's'}`); }
		catch { showInlineToast('Clipboard permission denied'); }
	});

	memRefs.bulkUnpin?.addEventListener('click', async () => {
		const ok = window.confirm(`Unpin ${memState.selectedIds.size} pin(s)? This cannot be undone after 10 seconds.`);
		if (!ok) return;
		const targets = selectedPins();
		for (const p of targets) await deletePinById(p.id);
		memState.selectedIds.clear();
		await refreshMemory();
		showInlineToast(`Unpinned ${targets.length} pin${targets.length === 1 ? '' : 's'}`);
	});

	memRefs.bulkExport?.addEventListener('click', () => exportPins(selectedPins()));

	memRefs.bulkInsert?.addEventListener('click', () => openInsertPreview(selectedPins()));

	// ---------- Export to ZIP (Obsidian-flavored markdown) ----------

	function slugify(text) {
		return String(text || 'pin').toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'pin';
	}

	function formatPinAsMarkdown(pin, sameChatPins) {
		const date = formatDateShort(pin.createdAt);
		const firstWords = (pin.content || '').trim().split(/\s+/).slice(0, 8).join(' ');
		const title = `${pin.chatTitle || 'Untitled'} — ${firstWords || 'pin'}`;
		const tags = Array.isArray(pin.tags) ? pin.tags : [];
		const related = sameChatPins.filter((p) => p.id !== pin.id);
		const frontmatter = [
			'---',
			`title: ${JSON.stringify(title)}`,
			`date: ${date}`,
			`model: ${pin.model || 'unknown'}`,
			`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
			pin.sourceUrl ? `chat_url: ${pin.sourceUrl}` : '',
			`cc_pin_id: ${pin.id}`,
			'cc_schema_version: 3',
			'---'
		].filter(Boolean).join('\n');

		const tagLinks = tags.length > 0 ? `\n\nTags: ${tags.map((t) => `[[${t}]]`).join(' ')}` : '';
		const relatedLinks = related.length > 0
			? `\n\nRelated: ${related.slice(0, 8).map((p) => `[[${formatDateShort(p.createdAt)}-${slugify(p.chatTitle)}-${(p.id || '').slice(0, 6)}]]`).join(' ')}`
			: '';

		return `${frontmatter}\n\n${pin.content || ''}${tagLinks}${relatedLinks}\n`;
	}

	async function exportPins(pins) {
		const list = pins.length > 0 ? pins : memState.allPins;
		if (list.length === 0) { showInlineToast('No pins to export'); return; }
		if (!globalThis.ClaudeCounter?.zip?.build) {
			showInlineToast('ZIP writer unavailable');
			return;
		}

		// Group sibling pins by conversationId for cross-linking.
		const byChat = new Map();
		for (const p of list) {
			const key = p.conversationId || 'unknown';
			if (!byChat.has(key)) byChat.set(key, []);
			byChat.get(key).push(p);
		}

		const files = {};
		const indexLines = [`# Claude Counter pins`, '', `Exported ${new Date().toISOString()}`, `Total pins: ${list.length}`, ''];
		for (const pin of list) {
			const siblings = byChat.get(pin.conversationId || 'unknown') || [];
			const name = `${formatDateShort(pin.createdAt)}-${slugify(pin.chatTitle)}-${(pin.id || '').slice(0, 6)}.md`;
			files[name] = formatPinAsMarkdown(pin, siblings);
			indexLines.push(`- [[${name.replace(/\.md$/, '')}]]`);
		}
		files['index.md'] = indexLines.join('\n') + '\n';
		files['README.md'] =
			`# Claude Counter — Pin Export\n\n` +
			`Schema version 3.\n\n` +
			`Drop this folder into your Obsidian vault. Each .md file is one pinned\n` +
			`Claude conversation excerpt. Wikilinks (\`[[...]]\`) cross-reference tags\n` +
			`and sibling pins within the same chat.\n\n` +
			`Re-export is idempotent — filenames are deterministic from the pin id.\n`;

		try {
			const blob = globalThis.ClaudeCounter.zip.build(files);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `claude-counter-pins-${formatDateShort(Date.now())}.zip`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 5000);
			showInlineToast(`Exported ${list.length} pin${list.length === 1 ? '' : 's'}`);
		} catch (e) {
			showInlineToast('Export failed');
		}
	}

	// ---------- Re-injection modal ----------

	function buildInjectionBundle(pins) {
		const blocks = pins.map((p, i) => {
			const date = formatDateShort(p.createdAt);
			const title = p.chatTitle || 'Untitled chat';
			const content = (p.content || '').trim();
			return `${i > 0 ? '---\n' : ''}## From: ${title}, ${date}\n${content}`;
		});
		return `<memory>\n${blocks.join('\n\n')}\n</memory>`;
	}

	let injectPending = null;

	async function openInsertPreview(pins) {
		if (pins.length === 0) return;
		const bundle = buildInjectionBundle(pins);
		const tokens = await tokenizePreview(bundle);
		// Read remaining context from cached state if we have it.
		let remaining = null;
		try {
			const res = await send(KIND.STATE_GET);
			const snapshot = res?.state?.snapshot;
			if (snapshot && typeof snapshot.contextRemaining === 'number') remaining = snapshot.contextRemaining;
		} catch { /* noop */ }

		injectPending = bundle;

		memRefs.modalPreview.textContent = bundle;
		const pctOfRemaining = remaining && remaining > 0 ? (tokens / remaining) * 100 : null;
		memRefs.modalMeta.classList.remove('cc-meta--warn', 'cc-meta--crit');
		if (pctOfRemaining !== null) {
			memRefs.modalMeta.textContent = `~${formatCompact(tokens)} tokens · ${pctOfRemaining.toFixed(1)}% of remaining context`;
			if (pctOfRemaining >= 95) memRefs.modalMeta.classList.add('cc-meta--crit');
			else if (pctOfRemaining >= 80) memRefs.modalMeta.classList.add('cc-meta--warn');
		} else {
			memRefs.modalMeta.textContent = `~${formatCompact(tokens)} tokens · open a chat to see % of context`;
		}

		// Detect "would exceed 200k total" — refuse insertion in that case.
		const limit = 200_000;
		const consumed = remaining !== null ? (limit - remaining) : 0;
		const wouldExceed = consumed + tokens > limit;
		memRefs.modalConfirm.disabled = wouldExceed;
		if (wouldExceed) {
			memRefs.modalMeta.classList.add('cc-meta--crit');
			memRefs.modalMeta.textContent = `Insertion would push context past 200k. Select fewer pins.`;
		}

		showModal();
	}

	async function tokenizePreview(text) {
		// No tokenizer in popup context. Approximate via 4 chars/token (matches
		// OpenAI/Anthropic English heuristic). The estimator on the content side
		// re-tokenizes once the bundle hits the composer.
		return Math.max(1, Math.ceil(text.length / 4));
	}

	function showModal() {
		memRefs.modal.hidden = false;
		setTimeout(() => memRefs.modalPreview?.focus(), 0);
	}

	function hideModal() {
		memRefs.modal.hidden = true;
		injectPending = null;
	}

	memRefs.modalClose?.addEventListener('click', hideModal);
	memRefs.modalCancel?.addEventListener('click', hideModal);
	memRefs.modalBackdrop?.addEventListener('click', hideModal);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && memRefs.modal && !memRefs.modal.hidden) hideModal();
	});

	memRefs.modalConfirm?.addEventListener('click', async () => {
		if (!injectPending) return;
		const res = await send(KIND.COMPOSER_INSERT, { text: injectPending });
		if (res?.ok) {
			hideModal();
			try { window.close(); } catch { /* noop */ }
		} else {
			showInlineToast(res?.error === 'no claude.ai tab' ? 'Open a chat in claude.ai first.' : 'Insert failed');
		}
	});

	// ---------- Inline toast for memory tab ----------

	function showInlineToast(text, opts = {}) {
		// Reuse a minimal in-popup toast — popup is its own document.
		const layer = (() => {
			let l = document.getElementById('cc-popup-toasts');
			if (l) return l;
			l = document.createElement('div');
			l.id = 'cc-popup-toasts';
			l.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:1100;display:flex;flex-direction:column;gap:6px;pointer-events:none;';
			document.body.appendChild(l);
			return l;
		})();
		const node = document.createElement('div');
		node.setAttribute('role', 'status');
		node.style.cssText = 'background:var(--cc-bg-card);color:var(--cc-text);border:1px solid var(--cc-border);padding:6px 12px;border-radius:8px;font-size:11px;box-shadow:0 6px 18px rgba(0,0,0,.25);pointer-events:auto;display:flex;align-items:center;gap:8px;';
		const span = document.createElement('span');
		span.textContent = text;
		node.appendChild(span);

		const remove = () => { try { node.remove(); } catch { /* noop */ } };

		if (opts.actionLabel && typeof opts.onAction === 'function') {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = opts.actionLabel;
			btn.style.cssText = 'background:transparent;border:1px solid var(--cc-border);color:inherit;border-radius:4px;padding:2px 8px;font:inherit;font-size:10px;cursor:pointer;';
			btn.addEventListener('click', () => { try { opts.onAction(); } catch { /* noop */ } remove(); });
			node.appendChild(btn);
		}

		layer.appendChild(node);
		setTimeout(remove, opts.duration || 2000);
	}

	// ---------- Filter event wiring ----------

	memRefs.search?.addEventListener('input', () => { renderPinList(); renderActiveFilterChips(); });
	memRefs.project?.addEventListener('change', () => { renderPinList(); renderActiveFilterChips(); });
	memRefs.range?.addEventListener('change', () => { renderPinList(); renderActiveFilterChips(); });

})();
