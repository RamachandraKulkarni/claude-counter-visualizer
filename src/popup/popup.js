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
		MESSAGES_FOR_CONVERSATION: 'messages.forConversation'
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

	async function refreshHeaviest() {
		if (!tabsApi?.query) return;
		try {
			const tabs = await new Promise((resolve) => {
				const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
			});
			const tab = tabs[0];
			if (!tab) { renderHeaviest([], null); return; }
			const res = await new Promise((resolve) => {
				try {
					const cb = (response) => resolve(response);
					const ret = tabsApi.sendMessage(tab.id, { kind: KIND.HEAVIEST_MESSAGES_GET, payload: {} }, cb);
					if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null));
				} catch { resolve(null); }
			});
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
		const res = await send(KIND.STATE_GET);
		if (res?.state) renderState(res.state);
		else renderState(null);

		// 3. Per-model card from rollups.
		renderModelsBar(lastRollups);

		// 4. Pull heaviest list from active claude.ai tab if any.
		refreshHeaviest();

		// 5. Per-chat model breakdown — read messages_meta for the active chat
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
})();
