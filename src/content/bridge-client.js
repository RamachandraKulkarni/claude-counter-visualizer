(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// [SECURITY] Strict origin validation for postMessage
	// Only accept/emit messages from/to claude.ai
	const ALLOWED_ORIGIN = 'https://claude.ai';

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	function makeRequestId() {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	class BridgeClient {
		constructor() {
			this._pending = new Map();
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				// [SECURITY] Validate message origin - reject unexpected origins
				if (event.origin !== ALLOWED_ORIGIN) {
					return;
				}

				// [SECURITY] Also validate source is window (prevents frame injection)
				if (event.source !== window) {
					return;
				}

				const data = event.data;
				if (!data || data.cc !== 'ClaudeCounter') return;

				if (data.type === 'cc:response') {
					const { requestId, ok, payload, error } = data;
					const pending = this._pending.get(requestId);
					if (!pending) return;
					this._pending.delete(requestId);
					clearTimeout(pending.timeoutId);
					if (ok) pending.resolve(payload);
					else pending.reject(new Error(error || 'Bridge request failed'));
					return;
				}

				// Events
				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of listeners) {
				fn(payload);
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}

		request(kind, payload, { timeoutMs = 10000 } = {}) {
			// [VALIDATION] Validate kind parameter
			if ('string' !== typeof kind || 0 === kind.length) {
				return Promise.reject(new Error('Invalid request kind'));
			}

			const requestId = makeRequestId();
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`Bridge request timed out (${kind})`));
				}, timeoutMs);

				this._pending.set(requestId, { resolve, reject, timeoutId });

				// [SECURITY] Use strict origin instead of '*' wildcard
				window.postMessage(
					{
						cc: 'ClaudeCounter',
						type: 'cc:request',
						requestId,
						kind,
						payload
					},
					ALLOWED_ORIGIN
				);
			});
		}

		async requestUsage(orgId) {
			return this.request('usage', { orgId }, { timeoutMs: 15000 });
		}

		async requestConversation(orgId, conversationId) {
			return this.request('conversation', { orgId, conversationId }, { timeoutMs: 20000 });
		}

		async requestHash(text) {
			return this.request('hash', { text }, { timeoutMs: 5000 });
		}
	}

	let bridgeReadyPromise = null;

	function injectBridgeOnce() {
		if (bridgeReadyPromise) return bridgeReadyPromise;

		const runtime = getRuntime();
		if (!runtime) return Promise.resolve(false);

		if (document.getElementById(CC.DOM.BRIDGE_SCRIPT_ID)) {
			return Promise.resolve(true);
		}

		bridgeReadyPromise = new Promise((resolve) => {
			const script = document.createElement('script');
			script.id = CC.DOM.BRIDGE_SCRIPT_ID;
			script.src = runtime.getURL('src/injected/bridge.js');
			script.onload = () => resolve(true);
			script.onerror = () => resolve(false);
			(document.head || document.documentElement).appendChild(script);
		});

		return bridgeReadyPromise;
	}

	CC.bridge = new BridgeClient();
	CC.injectBridgeOnce = injectBridgeOnce;
})();
