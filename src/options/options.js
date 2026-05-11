// [SECURITY] Options page persists settings via the service worker so all
// content scripts stay in sync. Wipe-all-data is gated by a confirm prompt.
(() => {
	'use strict';

	const KIND = Object.freeze({
		SETTINGS_GET: 'settings.get',
		SETTINGS_SET: 'settings.set',
		WIPE_ALL: 'wipe.all'
	});

	const DEFAULTS = {
		display: {
			showTokens: true,
			showCache: true,
			showContext: true,
			showSession: true,
			showWeekly: true,
			showBurnRate: true,
			compact: false,
			themeOverride: 'auto'
		},
		notifications: {
			muted: false,
			enabled75: true,
			enabled90: true,
			enabled95: true
		},
		thresholds: {
			session: [75, 90, 95],
			weekly: [75, 90, 95],
			contextHealth: { moderate: 50, near: 75, critical: 90 }
		}
	};

	const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;

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

	function deepClone(v) {
		try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
	}

	function getByPath(obj, path) {
		const parts = path.split('.');
		let cur = obj;
		for (const p of parts) {
			if (cur === null || cur === undefined) return undefined;
			cur = cur[p];
		}
		return cur;
	}

	function setByPath(obj, path, value) {
		const parts = path.split('.');
		let cur = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			const p = parts[i];
			if (cur[p] === undefined || cur[p] === null) cur[p] = {};
			cur = cur[p];
		}
		cur[parts[parts.length - 1]] = value;
	}

	let current = deepClone(DEFAULTS);
	let saveTimer = null;

	function inputsBound() {
		return Array.from(document.querySelectorAll('[data-setting]'));
	}

	function showSaved() {
		const el = document.getElementById('cc-saved');
		if (!el) return;
		el.hidden = false;
		clearTimeout(showSaved._t);
		showSaved._t = setTimeout(() => { el.hidden = true; }, 1200);
	}

	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			saveTimer = null;
			await send(KIND.SETTINGS_SET, current);
			showSaved();
		}, 200);
	}

	function hydrate() {
		for (const input of inputsBound()) {
			const path = input.getAttribute('data-setting');
			if (!path) continue;
			const value = getByPath(current, path);
			if (input.type === 'checkbox') {
				input.checked = !!value;
			} else if (input.type === 'number') {
				if (typeof value === 'number') input.value = String(value);
			} else if (input.tagName === 'SELECT') {
				if (typeof value === 'string') input.value = value;
			} else {
				if (value !== undefined) input.value = String(value);
			}
		}
	}

	function bindInputs() {
		for (const input of inputsBound()) {
			const path = input.getAttribute('data-setting');
			if (!path) continue;
			input.addEventListener('change', () => {
				let value;
				if (input.type === 'checkbox') value = !!input.checked;
				else if (input.type === 'number') {
					const parsed = parseInt(input.value, 10);
					if (Number.isNaN(parsed)) return;
					// [VALIDATION] threshold range guard
					if (parsed < 1 || parsed > 99) return;
					value = parsed;
				}
				else value = input.value;
				setByPath(current, path, value);
				scheduleSave();
			});
		}

		const wipeBtn = document.getElementById('cc-wipe');
		const wipeStatus = document.getElementById('cc-wipe-status');
		if (wipeBtn) {
			wipeBtn.addEventListener('click', async () => {
				const ok = window.confirm('Wipe all Claude Counter data on this device? This cannot be undone.');
				if (!ok) return;
				wipeBtn.disabled = true;
				try {
					await send(KIND.WIPE_ALL);
					await wipeIndexedDb();
					current = deepClone(DEFAULTS);
					hydrate();
					if (wipeStatus) wipeStatus.textContent = 'Cleared.';
				} catch (e) {
					if (wipeStatus) wipeStatus.textContent = 'Wipe failed.';
				} finally {
					wipeBtn.disabled = false;
				}
			});
		}

		// Version label
		try {
			const v = runtime?.getManifest?.()?.version;
			const span = document.getElementById('cc-version');
			if (v && span) span.textContent = v;
		} catch { /* noop */ }
	}

	async function wipeIndexedDb() {
		// [SECURITY] IndexedDB is only reachable from a page context, so we
		// open the same database from this page and clear all stores.
		return new Promise((resolve) => {
			try {
				const req = indexedDB.deleteDatabase('claude_counter_v1');
				req.onsuccess = () => resolve();
				req.onerror = () => resolve();
				req.onblocked = () => resolve();
			} catch { resolve(); }
		});
	}

	async function boot() {
		const res = await send(KIND.SETTINGS_GET);
		if (res?.ok && res.settings) {
			current = mergeDefaults(deepClone(DEFAULTS), res.settings);
		}
		hydrate();
		bindInputs();
	}

	function mergeDefaults(base, override) {
		if (!override || typeof override !== 'object') return base;
		for (const key of Object.keys(override)) {
			const ov = override[key];
			if (Array.isArray(ov)) {
				base[key] = ov.slice();
			} else if (ov && typeof ov === 'object') {
				base[key] = mergeDefaults(base[key] || {}, ov);
			} else {
				base[key] = ov;
			}
		}
		return base;
	}

	boot();
})();
