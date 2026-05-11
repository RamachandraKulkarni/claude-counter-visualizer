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
		HEAVIEST_MESSAGES_GET: 'heaviest.get'
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
		claudeLink: el('cc-claude-link')
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

	// ---- Sparkline rendering (pure SVG path) ----
	function renderSparkline(svg, series) {
		if (!svg) return;
		// Wipe children deterministically.
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		if (!Array.isArray(series) || series.length < 2) return;

		const w = 100;
		const h = 24;
		const max = Math.max(100, ...series.filter((v) => Number.isFinite(v)));
		const min = 0;
		const range = Math.max(1, max - min);
		const stepX = w / Math.max(1, series.length - 1);

		const points = series.map((v, i) => {
			const y = h - ((v - min) / range) * h;
			return [i * stepX, Math.max(0, Math.min(h, y))];
		});

		const pathD = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
		const fillD = `${pathD} L${w},${h} L0,${h} Z`;

		const ns = 'http://www.w3.org/2000/svg';
		const fill = document.createElementNS(ns, 'path');
		fill.setAttribute('d', fillD);
		fill.setAttribute('class', 'cc-spark-fill');
		svg.appendChild(fill);

		const line = document.createElementNS(ns, 'path');
		line.setAttribute('d', pathD);
		svg.appendChild(line);
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

	// ---- Render full state ----
	const inSessionHistory = [];
	const inSessionWeekly = [];
	const MAX_HISTORY = 60;

	function pushHistory(state) {
		if (!state?.snapshot) return;
		const s = state.snapshot;
		if ('number' === typeof s.sessionPct) {
			inSessionHistory.push(s.sessionPct);
			if (inSessionHistory.length > MAX_HISTORY) inSessionHistory.shift();
		}
		if ('number' === typeof s.weeklyPct) {
			inSessionWeekly.push(s.weeklyPct);
			if (inSessionWeekly.length > MAX_HISTORY) inSessionWeekly.shift();
		}
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

		// History
		pushHistory(state);
		renderSparkline(refs.sparkSession, inSessionHistory);
		renderSparkline(refs.sparkWeekly, inSessionWeekly);
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

	// ---- Boot ----
	async function boot() {
		// 1. Pull cached state from service worker (no claude.ai tab required).
		const res = await send(KIND.STATE_GET);
		if (res?.state) renderState(res.state);
		else renderState(null);

		// 2. Pull heaviest list from active claude.ai tab if any.
		refreshHeaviest();

		// 3. Subscribe to live state updates via long-lived port.
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
