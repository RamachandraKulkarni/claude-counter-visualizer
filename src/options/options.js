// [SECURITY] Options page persists settings via the service worker so all
// content scripts stay in sync. Wipe-all-data is gated by a confirm prompt.
(() => {
	'use strict';

	const KIND = Object.freeze({
		SETTINGS_GET: 'settings.get',
		SETTINGS_SET: 'settings.set',
		WIPE_ALL: 'wipe.all',
		STORAGE_ESTIMATE: 'storage.estimate'
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
		},
		history: {
			retentionDays: 90
		},
		memory: {
			hotkey: 'Ctrl+Shift+P',
			autoTagChatTitle: true,
			autoTagDate: true,
			autoTagModel: true,
			defaultTags: [],
			exportFormat: 'flat'
		},
		graph: {
			forceLoadThreshold: 2000,
			showCooccur: true,
			showTag: true,
			showManual: true,
			palette: 'default'
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

			// Virtual setting: memory.defaultTagsRaw <-> memory.defaultTags[]
			if (path === 'memory.defaultTagsRaw') {
				const arr = getByPath(current, 'memory.defaultTags');
				input.value = Array.isArray(arr) ? arr.join(', ') : '';
				continue;
			}

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
			const handler = () => {
				let value;
				if (path === 'memory.defaultTagsRaw') {
					// Virtual: split on comma, trim, drop empties. Persist to defaultTags.
					value = input.value.split(',').map((s) => s.trim()).filter(Boolean);
					setByPath(current, 'memory.defaultTags', value);
					scheduleSave();
					return;
				}
				if (input.type === 'checkbox') value = !!input.checked;
				else if (input.type === 'number') {
					const parsed = parseInt(input.value, 10);
					if (Number.isNaN(parsed)) return;
					// [VALIDATION] threshold range guard: 1-99 for percent, 30-365 for retention.
					if (path.startsWith('thresholds.')) {
						if (parsed < 1 || parsed > 99) return;
					} else if (path === 'history.retentionDays') {
						if (parsed < 30 || parsed > 365) return;
					} else if (path === 'graph.forceLoadThreshold') {
						if (parsed < 500 || parsed > 5000) return;
					}
					value = parsed;
				}
				else value = input.value;
				setByPath(current, path, value);
				scheduleSave();
			};
			input.addEventListener('change', handler);
			if (input.type === 'text' || input.type === 'search' || input.type === 'number') {
				// `change` only fires on blur for text inputs; debounce on input too.
				input.addEventListener('input', handler);
			}
		}

		// Wipe-pins button (Phase 3).
		const wipePinsBtn = document.getElementById('cc-wipe-pins');
		const wipePinsStatus = document.getElementById('cc-wipe-pins-status');
		if (wipePinsBtn) {
			wipePinsBtn.addEventListener('click', async () => {
				const ok1 = window.confirm('Wipe ALL pinned messages? This cannot be undone.');
				if (!ok1) return;
				const ok2 = window.confirm('Are you absolutely sure? All pin data will be permanently deleted.');
				if (!ok2) return;
				try {
					await wipeAllPins();
					if (wipePinsStatus) wipePinsStatus.textContent = 'All pins cleared.';
				} catch {
					if (wipePinsStatus) wipePinsStatus.textContent = 'Wipe failed.';
				}
			});
		}

		// Shortcut rebind link — chrome:// URLs can't be opened from <a href>;
		// route through tabs.create instead.
		const shortcutLink = document.getElementById('cc-mem-shortcut-link');
		if (shortcutLink) {
			shortcutLink.addEventListener('click', (e) => {
				e.preventDefault();
				const tabs = globalThis.browser?.tabs || globalThis.chrome?.tabs;
				try { tabs?.create?.({ url: 'chrome://extensions/shortcuts' }); }
				catch { /* noop */ }
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

	async function wipeAllPins() {
		return new Promise((resolve) => {
			try {
				const req = indexedDB.open('claude_counter_v1');
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains('pins')) { resolve(); return; }
					try {
						const tx = db.transaction('pins', 'readwrite');
						const clear = tx.objectStore('pins').clear();
						clear.onsuccess = () => resolve();
						clear.onerror = () => resolve();
					} catch { resolve(); }
				};
				req.onerror = () => resolve();
			} catch { resolve(); }
		});
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

	async function refreshStorageReadout() {
		const out = document.getElementById('cc-storage-readout');
		if (!out) return;
		// Prefer the SW (covers worker-context paths); fall back to navigator.storage here.
		let estimate = null;
		try {
			const res = await send(KIND.STORAGE_ESTIMATE);
			if (res?.ok && res.estimate) estimate = res.estimate;
		} catch { /* noop */ }
		if (!estimate && navigator?.storage?.estimate) {
			try { estimate = await navigator.storage.estimate(); } catch { /* noop */ }
		}
		if (!estimate) { out.textContent = 'unavailable'; return; }
		const used = estimate.usage || 0;
		const quota = estimate.quota || 0;
		const fmt = (n) => {
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		};
		out.textContent = quota > 0
			? `${fmt(used)} of ${fmt(quota)} used`
			: `${fmt(used)} used`;
	}

	async function boot() {
		const res = await send(KIND.SETTINGS_GET);
		if (res?.ok && res.settings) {
			current = mergeDefaults(deepClone(DEFAULTS), res.settings);
		}
		hydrate();
		bindInputs();
		refreshStorageReadout();
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
