// [SECURITY] Singleton wrapper around the embedding worker. All public API
// is async + returns a Promise. Worker is spawned only when isEnabled() and
// the user has opted in (managed via settings). No background activity if
// the flag is off.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	let worker = null;
	let nextId = 1;
	const pending = new Map();
	const progressListeners = new Set();
	let initialized = false;
	let initMeta = null;

	function call(message, transfer) {
		const w = ensureWorker();
		if (!w) return Promise.reject(new Error('embedding worker unavailable'));
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			try {
				w.postMessage({ ...message, proto: 'cc-embed', id }, transfer || []);
			} catch (e) {
				pending.delete(id);
				reject(e);
			}
		});
	}

	function ensureWorker() {
		if (worker) return worker;
		const runtime = getRuntime();
		if (!runtime?.getURL) return null;
		try {
			worker = new Worker(runtime.getURL('src/workers/embedding-worker.js'));
			worker.addEventListener('message', (event) => {
				const msg = event.data;
				if (!msg || msg.proto !== 'cc-embed') return;
				if (msg.type === 'PROGRESS') {
					for (const fn of progressListeners) {
						try { fn(msg); } catch { /* swallow */ }
					}
					return;
				}
				const h = pending.get(msg.id);
				if (!h) return;
				pending.delete(msg.id);
				if (msg.ok) h.resolve(msg);
				else h.reject(new Error(msg.error || 'worker error'));
			});
			worker.addEventListener('error', () => {
				for (const h of pending.values()) { try { h.reject(new Error('worker crashed')); } catch { /* noop */ } }
				pending.clear();
				worker = null;
				initialized = false;
			});
		} catch (e) {
			return null;
		}
		return worker;
	}

	async function init() {
		if (initialized && initMeta) return initMeta;
		const runtime = getRuntime();
		if (!runtime?.getURL) throw new Error('runtime unavailable');
		// [SECURITY] The runtime URL is rooted at the extension origin. If a
		// real Transformers.js bundle is dropped in, point this at it instead
		// of the shim.
		const shimUrl = runtime.getURL('src/vendor/cc-embed-shim.js');
		const realUrl = runtime.getURL('src/vendor/transformers-adapter.js');
		// Probe for the real adapter first by attempting to fetch it; if the
		// resource is missing the request 404s and we fall back to the shim.
		let runtimeUrl = shimUrl;
		try {
			const resp = await fetch(realUrl, { method: 'HEAD' });
			if (resp.ok) runtimeUrl = realUrl;
		} catch { /* shim it is */ }

		const res = await call({ type: 'init', runtimeUrl });
		initialized = true;
		initMeta = res.meta;
		// Persist model state so the UI can render the "running on shim"
		// banner without re-init.
		try {
			if (CC.utils?.db?.setModelState) {
				await CC.utils.db.setModelState({
					modelId: initMeta?.modelId || 'unknown',
					dim: initMeta?.dim || 384,
					vendor: initMeta?.vendor || 'unknown',
					runtime: initMeta?.runtime || 'unknown'
				});
			}
		} catch { /* noop */ }
		return initMeta;
	}

	async function isReady() {
		if (initialized) return true;
		try { await init(); return true; }
		catch { return false; }
	}

	async function embed(text) {
		if (!await isReady()) return null;
		const res = await call({ type: 'embed', text: String(text || '').slice(0, 8000) });
		return res.vector;
	}

	async function embedPin(pin) {
		if (!pin || 'string' !== typeof pin.id) return null;
		const text = pin.content || '';
		const vec = await embed(text);
		if (!vec) return null;
		if (CC.utils?.db?.updatePinEmbedding) {
			await CC.utils.db.updatePinEmbedding(pin.id, vec, initMeta);
		}
		return vec;
	}

	/**
	 * Embed every pin lacking an embedding. Returns an observable-ish
	 * `{ promise, onProgress, abort }` so the options page can drive UI.
	 */
	function backfillAll(pins) {
		const targets = (pins || []).filter((p) => !p?.embedding);
		const total = targets.length;
		const listeners = new Set();
		let aborted = false;

		const promise = (async () => {
			let done = 0;
			for (const pin of targets) {
				if (aborted) return { done, total, aborted: true };
				try {
					await embedPin(pin);
				} catch { /* continue; pin will retry on next backfill */ }
				done++;
				for (const fn of listeners) { try { fn({ done, total }); } catch { /* noop */ } }
			}
			return { done, total, aborted: false };
		})();

		return {
			promise,
			onProgress(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
			abort() { aborted = true; try { call({ type: 'abort' }).catch(() => {}); } catch { /* noop */ } }
		};
	}

	function onProgress(fn) {
		if (typeof fn === 'function') progressListeners.add(fn);
		return () => progressListeners.delete(fn);
	}

	function terminate() {
		if (!worker) return;
		try { worker.terminate(); } catch { /* noop */ }
		worker = null;
		initialized = false;
		initMeta = null;
		pending.clear();
	}

	function status() {
		return { initialized, initMeta, queued: pending.size };
	}

	CC.embedding = {
		init,
		isReady,
		embed,
		embedPin,
		backfillAll,
		onProgress,
		terminate,
		status
	};
})();
