// [SECURITY] Forensics page reads messages_meta from IndexedDB (via SW) and
// renders pure SVG charts. No user content is rendered through innerHTML; all
// labels are set with textContent.
(() => {
	'use strict';

	const KIND = Object.freeze({
		MESSAGES_FOR_CONVERSATION: 'messages.forConversation'
	});

	const SVG_NS = 'http://www.w3.org/2000/svg';
	const CONTEXT_LIMIT = 200_000;

	const MODEL_COLORS = Object.freeze({
		opus: 'var(--model-opus)',
		sonnet: 'var(--model-sonnet)',
		haiku: 'var(--model-haiku)',
		other: 'var(--model-other)',
		unknown: 'var(--model-unknown)'
	});

	const MODEL_LABELS = Object.freeze({
		opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other', unknown: 'Unknown'
	});

	const ROLE_COLORS = Object.freeze({
		human: 'var(--accent-cyan)',
		user: 'var(--accent-cyan)',
		assistant: 'var(--accent-purple)'
	});

	const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;

	function send(kind, payload) {
		return new Promise((resolve) => {
			if (!runtime?.sendMessage) { resolve(null); return; }
			try {
				const cb = (r) => { if (runtime.lastError) { resolve(null); return; } resolve(r); };
				const ret = runtime.sendMessage({ kind, payload }, cb);
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null));
			} catch { resolve(null); }
		});
	}

	const el = (id) => document.getElementById(id);
	const refs = {
		title: el('cc-fx-title'),
		back: el('cc-fx-back'),
		meta: el('cc-fx-meta'),
		bar: el('cc-fx-bar'),
		line: el('cc-fx-line'),
		empty: el('cc-fx-empty'),
		togModel: el('cc-fx-tog-model'),
		togAttach: el('cc-fx-tog-attach'),
		details: el('cc-fx-details'),
		detailsTitle: el('cc-fx-details-title'),
		detailsClose: el('cc-fx-details-close'),
		detailsBody: el('cc-fx-details-body')
	};

	function getChatId() {
		const params = new URLSearchParams(window.location.search);
		const id = params.get('chatId');
		return typeof id === 'string' && id.length > 0 ? id : null;
	}

	function formatCompact(v) {
		if ('number' !== typeof v) return '—';
		if (v >= 1000) return `${(Math.round(v / 100) / 10).toLocaleString()}k`;
		return v.toLocaleString();
	}

	function formatDate(ms) {
		if (typeof ms !== 'number') return '—';
		try { return new Date(ms).toLocaleString(); } catch { return '—'; }
	}

	function ensureChartSize(svg, count) {
		// Scale width with message count for readability above 80 messages.
		const minBars = 80;
		const px = count > minBars ? Math.min(2400, 12 * count) : 600;
		svg.style.minWidth = `${px}px`;
		svg.setAttribute('viewBox', `0 0 ${px} 220`);
		return px;
	}

	function clearSvg(svg) {
		while (svg.firstChild) svg.removeChild(svg.firstChild);
	}

	function renderBarChart(messages) {
		const svg = refs.bar;
		clearSvg(svg);
		if (!messages.length) return;

		const w = ensureChartSize(svg, messages.length);
		const h = 220;
		const padL = 38;
		const padR = 10;
		const padT = 12;
		const padB = 28;
		const chartW = w - padL - padR;
		const chartH = h - padT - padB;

		const maxTokens = Math.max(1, ...messages.map((m) => m.tokens || 0));
		const stepX = chartW / messages.length;
		const barW = Math.max(2, stepX - 1);

		// Y axis grid lines + labels (4 ticks).
		for (let i = 0; i <= 4; i++) {
			const value = (maxTokens * (4 - i)) / 4;
			const y = padT + (chartH * i) / 4;
			const grid = document.createElementNS(SVG_NS, 'line');
			grid.setAttribute('x1', String(padL));
			grid.setAttribute('y1', String(y));
			grid.setAttribute('x2', String(w - padR));
			grid.setAttribute('y2', String(y));
			grid.setAttribute('class', 'cc-fx-grid');
			svg.appendChild(grid);

			const label = document.createElementNS(SVG_NS, 'text');
			label.setAttribute('x', String(padL - 6));
			label.setAttribute('y', String(y + 3));
			label.setAttribute('text-anchor', 'end');
			label.setAttribute('class', 'cc-fx-axis-label');
			label.textContent = formatCompact(Math.round(value));
			svg.appendChild(label);
		}

		messages.forEach((m, i) => {
			const x = padL + i * stepX;
			const value = m.tokens || 0;
			const hPx = (value / maxTokens) * chartH;
			const y = padT + chartH - hPx;

			const rect = document.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', x.toFixed(2));
			rect.setAttribute('y', y.toFixed(2));
			rect.setAttribute('width', barW.toFixed(2));
			rect.setAttribute('height', Math.max(1, hPx).toFixed(2));
			rect.setAttribute('fill', ROLE_COLORS[m.role] || '#888');
			rect.setAttribute('tabindex', '0');
			rect.setAttribute('role', 'img');
			rect.setAttribute('aria-label',
				`Message ${i + 1} of ${messages.length}. ${m.role}. ${formatCompact(value)} tokens.`);

			const title = document.createElementNS(SVG_NS, 'title');
			title.textContent = `#${i + 1} · ${m.role} · ${formatCompact(value)} tok · ${MODEL_LABELS[m.model] || 'Unknown'}`;
			rect.appendChild(title);

			rect.addEventListener('click', () => showDetails(m, i + 1, messages.length));
			rect.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					showDetails(m, i + 1, messages.length);
				}
			});
			svg.appendChild(rect);
		});

		renderEventOverlays(messages, svg, padL, padT, chartH, stepX, w, padR);
	}

	function renderEventOverlays(messages, svg, padL, padT, chartH, stepX, w, padR) {
		const showModel = !!refs.togModel?.checked;
		const showAttach = !!refs.togAttach?.checked;

		// Model switches: detect transitions in m.model.
		if (showModel) {
			let prev = null;
			messages.forEach((m, i) => {
				if (i === 0) { prev = m.model; return; }
				if (m.model && m.model !== prev) {
					const x = padL + i * stepX;
					const line = document.createElementNS(SVG_NS, 'line');
					line.setAttribute('x1', x.toFixed(2));
					line.setAttribute('y1', String(padT));
					line.setAttribute('x2', x.toFixed(2));
					line.setAttribute('y2', String(padT + chartH));
					line.setAttribute('class', 'cc-fx-event cc-fx-event--model');
					svg.appendChild(line);

					const label = document.createElementNS(SVG_NS, 'text');
					label.setAttribute('x', (x + 3).toFixed(2));
					label.setAttribute('y', String(padT + 10));
					label.setAttribute('class', 'cc-fx-event-label');
					label.textContent = `→ ${MODEL_LABELS[m.model] || m.model}`;
					svg.appendChild(label);
					prev = m.model;
				}
			});
		}

		if (showAttach) {
			messages.forEach((m, i) => {
				if (!m.hasAttachments) return;
				const x = padL + i * stepX;
				const tri = document.createElementNS(SVG_NS, 'polygon');
				const cx = x + 1;
				tri.setAttribute('points', `${cx - 4},${padT - 1} ${cx + 4},${padT - 1} ${cx},${padT + 4}`);
				tri.setAttribute('fill', 'var(--accent-yellow)');
				const title = document.createElementNS(SVG_NS, 'title');
				title.textContent = `Attachment on message #${i + 1}`;
				tri.appendChild(title);
				svg.appendChild(tri);
			});
		}
		void w; void padR; // reserved for future right-axis labels
	}

	function renderCumulativeLine(messages) {
		const svg = refs.line;
		clearSvg(svg);
		if (!messages.length) return;

		const w = ensureChartSize(svg, messages.length);
		const h = 220;
		const padL = 38;
		const padR = 10;
		const padT = 12;
		const padB = 28;
		const chartW = w - padL - padR;
		const chartH = h - padT - padB;

		let cum = 0;
		const points = messages.map((m, i) => {
			cum += m.tokens || 0;
			return { i, value: cum };
		});

		const maxCum = Math.max(CONTEXT_LIMIT, ...points.map((p) => p.value));
		const stepX = chartW / Math.max(1, messages.length - 1);

		// Reference lines at 90% and 100% of context.
		const yFor = (val) => padT + chartH - (val / maxCum) * chartH;

		for (const [val, klass, label] of [[CONTEXT_LIMIT * 0.9, 'cc-fx-ref-90', '90% context'], [CONTEXT_LIMIT, 'cc-fx-ref-100', '200k limit']]) {
			const y = yFor(val);
			const line = document.createElementNS(SVG_NS, 'line');
			line.setAttribute('x1', String(padL));
			line.setAttribute('y1', y.toFixed(2));
			line.setAttribute('x2', String(w - padR));
			line.setAttribute('y2', y.toFixed(2));
			line.setAttribute('class', klass);
			svg.appendChild(line);

			const txt = document.createElementNS(SVG_NS, 'text');
			txt.setAttribute('x', String(w - padR - 4));
			txt.setAttribute('y', (y - 3).toFixed(2));
			txt.setAttribute('text-anchor', 'end');
			txt.setAttribute('class', 'cc-fx-axis-label');
			txt.textContent = label;
			svg.appendChild(txt);
		}

		// Y axis ticks.
		for (let i = 0; i <= 4; i++) {
			const value = (maxCum * (4 - i)) / 4;
			const y = padT + (chartH * i) / 4;
			const grid = document.createElementNS(SVG_NS, 'line');
			grid.setAttribute('x1', String(padL));
			grid.setAttribute('y1', String(y));
			grid.setAttribute('x2', String(w - padR));
			grid.setAttribute('y2', String(y));
			grid.setAttribute('class', 'cc-fx-grid');
			svg.appendChild(grid);

			const label = document.createElementNS(SVG_NS, 'text');
			label.setAttribute('x', String(padL - 6));
			label.setAttribute('y', String(y + 3));
			label.setAttribute('text-anchor', 'end');
			label.setAttribute('class', 'cc-fx-axis-label');
			label.textContent = formatCompact(Math.round(value));
			svg.appendChild(label);
		}

		const pathD = points.map((p, i) => {
			const x = padL + i * stepX;
			const y = yFor(p.value);
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
		}).join(' ');

		const fillD = `${pathD} L${(padL + (points.length - 1) * stepX).toFixed(2)},${(padT + chartH).toFixed(2)} L${padL},${(padT + chartH).toFixed(2)} Z`;

		const fill = document.createElementNS(SVG_NS, 'path');
		fill.setAttribute('d', fillD);
		fill.setAttribute('class', 'cc-fx-cum-fill');
		svg.appendChild(fill);

		const line = document.createElementNS(SVG_NS, 'path');
		line.setAttribute('d', pathD);
		line.setAttribute('class', 'cc-fx-cum-line');
		svg.appendChild(line);

		// Crossing annotation at 90%.
		const crossing = points.find((p) => p.value >= CONTEXT_LIMIT * 0.9);
		if (crossing) {
			const x = padL + crossing.i * stepX;
			const y = yFor(CONTEXT_LIMIT * 0.9);
			const txt = document.createElementNS(SVG_NS, 'text');
			txt.setAttribute('x', (x + 6).toFixed(2));
			txt.setAttribute('y', (y - 6).toFixed(2));
			txt.setAttribute('class', 'cc-fx-axis-label');
			txt.textContent = 'Approaching compaction here';
			svg.appendChild(txt);
		}
	}

	function showDetails(m, idx, total) {
		if (!refs.details || !refs.detailsBody) return;
		refs.details.hidden = false;
		refs.detailsTitle.textContent = `Message ${idx} of ${total}`;
		while (refs.detailsBody.firstChild) refs.detailsBody.removeChild(refs.detailsBody.firstChild);
		const rows = [
			['Role', m.role || 'unknown'],
			['Model', MODEL_LABELS[m.model] || m.model || 'Unknown'],
			['Tokens', formatCompact(m.tokens || 0)],
			['Created', formatDate(m.createdAt)],
			['Attachments', m.hasAttachments ? 'yes' : 'no'],
			['Snippet', m.snippet || '(no snippet stored)']
		];
		for (const [k, v] of rows) {
			const dt = document.createElement('dt');
			dt.textContent = k;
			const dd = document.createElement('dd');
			// [SECURITY] textContent — never innerHTML.
			dd.textContent = v;
			refs.detailsBody.appendChild(dt);
			refs.detailsBody.appendChild(dd);
		}
	}

	if (refs.detailsClose) {
		refs.detailsClose.addEventListener('click', () => { refs.details.hidden = true; });
	}

	function refreshOverlays(messages) {
		// Re-render bar to keep overlays in sync with toggles.
		renderBarChart(messages);
	}

	function startClock() {
		const el = document.getElementById('cc-fx-clock');
		if (!el) return;
		const tick = () => {
			try { el.textContent = `${new Date().toISOString().slice(0, 19)}Z`; } catch { /* noop */ }
		};
		tick();
		setInterval(tick, 1000);
	}

	function setForensicsCmd(text) {
		const el = document.getElementById('cc-fx-cmd');
		if (el && text) el.textContent = text;
	}

	function setForensicsStatus(count) {
		const el = document.getElementById('cc-fx-statusbar-count');
		if (el) el.textContent = `${count} msgs`;
	}

	async function boot() {
		startClock();
		const chatId = getChatId();
		if (!chatId) {
			refs.meta.textContent = 'No chat selected. Open this page from the Claude Counter popup.';
			refs.empty.hidden = false;
			return;
		}
		setForensicsCmd(`cc --inspect ${chatId.slice(0, 8)}`);

		if (refs.back) {
			refs.back.href = `https://claude.ai/chat/${encodeURIComponent(chatId)}`;
		}

		const res = await send(KIND.MESSAGES_FOR_CONVERSATION, { conversationId: chatId });
		const messages = res?.ok ? (res.messages || []) : [];

		if (!messages.length) {
			refs.meta.textContent = `Chat ${chatId.slice(0, 8)}… · no messages stored yet.`;
			refs.empty.hidden = false;
			setForensicsStatus(0);
			return;
		}
		refs.empty.hidden = true;
		setForensicsStatus(messages.length);

		// Compute summary.
		const total = messages.reduce((acc, m) => acc + (m.tokens || 0), 0);
		const modelsUsed = new Set();
		for (const m of messages) modelsUsed.add(m.model || 'unknown');
		const modelList = Array.from(modelsUsed).map((id) => MODEL_LABELS[id] || id).join(' / ');
		const start = messages[0].createdAt;
		const end = messages[messages.length - 1].createdAt;

		refs.meta.textContent =
			`${messages.length} messages · ${formatCompact(total)} tokens cumulative · ${modelList}` +
			(start && end ? ` · ${formatDate(start)} → ${formatDate(end)}` : '');

		renderBarChart(messages);
		renderCumulativeLine(messages);

		if (refs.togModel) refs.togModel.addEventListener('change', () => refreshOverlays(messages));
		if (refs.togAttach) refs.togAttach.addEventListener('change', () => refreshOverlays(messages));
	}

	boot();
})();
