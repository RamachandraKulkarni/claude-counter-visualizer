// [SECURITY] Spawns a Worker from the extension origin only. Falls back to
// main-thread tokenization if the worker can't start.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	let worker = null;
	let nextId = 1;
	const pending = new Map();
	let initialized = false;
	let initError = null;

	function start() {
		if (worker || initError) return worker;
		const runtime = getRuntime();
		if (!runtime?.getURL) {
			initError = new Error('runtime.getURL unavailable');
			return null;
		}
		try {
			worker = new Worker(runtime.getURL('src/workers/tokenizer.worker.js'));
			worker.addEventListener('message', (event) => {
				const msg = event.data;
				if (!msg || msg.proto !== 'cc-tok') return;
				const handler = pending.get(msg.id);
				if (!handler) return;
				pending.delete(msg.id);
				if (msg.ok) handler.resolve(msg);
				else handler.reject(new Error(msg.error || 'worker error'));
			});
			worker.addEventListener('error', (event) => {
				if (CC.utils?.errors?.warn) {
					CC.utils.errors.warn('worker error', { message: event?.message });
				}
				// [EDGE] Reject all pending on hard failure.
				for (const h of pending.values()) {
					try { h.reject(new Error(event?.message || 'worker crashed')); } catch { /* noop */ }
				}
				pending.clear();
			});
		} catch (e) {
			initError = e;
			if (CC.utils?.errors?.reportError) {
				CC.utils.errors.reportError(e, 'worker-tokenizer.start');
			}
			return null;
		}
		return worker;
	}

	function call(type, payload, timeoutMs = 8000) {
		const w = start();
		if (!w) return Promise.reject(initError || new Error('worker unavailable'));

		const runtime = getRuntime();
		const vendorUrl = runtime?.getURL ? runtime.getURL('src/vendor/o200k_base.js') : null;
		if (!vendorUrl) return Promise.reject(new Error('vendor URL unavailable'));

		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`worker timeout (${type})`));
			}, timeoutMs);

			pending.set(id, {
				resolve: (val) => { clearTimeout(timer); resolve(val); },
				reject: (err) => { clearTimeout(timer); reject(err); }
			});

			try {
				w.postMessage({ proto: 'cc-tok', id, type, vendorUrl, ...payload });
			} catch (e) {
				clearTimeout(timer);
				pending.delete(id);
				reject(e);
			}
		});
	}

	/**
	 * Count tokens off the main thread.
	 * [EDGE] Falls back to main-thread tokenizer for short inputs when worker fails.
	 * @param {string} text
	 * @returns {Promise<number>}
	 */
	async function tokenize(text) {
		if ('string' !== typeof text || 0 === text.length) return 0;
		try {
			if (!initialized) {
				await call('init', {}, 10000);
				initialized = true;
			}
			const res = await call('count', { text });
			return 'number' === typeof res.count ? res.count : 0;
		} catch (e) {
			// [EDGE] fallback for short strings — keeps the estimator alive
			if (text.length <= 8000 && globalThis.GPTTokenizer_o200k_base?.countTokens) {
				try { return globalThis.GPTTokenizer_o200k_base.countTokens(text); }
				catch { return 0; }
			}
			if (CC.utils?.errors?.warn) {
				CC.utils.errors.warn('worker tokenize failed; returning 0', { error: e?.message });
			}
			return 0;
		}
	}

	function terminate() {
		if (!worker) return;
		try { worker.terminate(); } catch { /* noop */ }
		worker = null;
		initialized = false;
		pending.clear();
	}

	CC.utils = CC.utils || {};
	CC.utils.workerTokenizer = { tokenize, terminate };
})();
