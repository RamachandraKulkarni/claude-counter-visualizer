// [SECURITY] All cross-context messages share this contract. Unknown `kind`
// values are rejected at the boundary instead of being silently dispatched.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// [CONFIG] Message kinds. Keep in sync with ARCHITECTURE.md "Messaging contracts".
	const KIND = Object.freeze({
		SNAPSHOT_PUT: 'snapshot.put',
		STATE_GET: 'state.get',
		STATE_CHANGED: 'state.changed',
		SETTINGS_CHANGED: 'settings.changed',
		SETTINGS_GET: 'settings.get',
		SETTINGS_SET: 'settings.set',
		WIPE_ALL: 'wipe.all',
		PING: 'ping',
		FOCUS_CHAT: 'focus.chat',
		SCROLL_TO_MESSAGE: 'scroll.to.message',
		HEAVIEST_MESSAGES_GET: 'heaviest.get',
		FORECAST_GET: 'forecast.get',
		// Phase 2 — content-script-side queries used as popup fallbacks.
		LIVE_STATE_GET: 'live.state.get',
		ROLLUPS_GET: 'rollups.get',
		STORAGE_ESTIMATE: 'storage.estimate',
		OPEN_FORENSICS: 'open.forensics',
		MESSAGES_FOR_CONVERSATION: 'messages.forConversation'
	});

	const VALID_KINDS = new Set(Object.values(KIND));

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	function getTabs() {
		return globalThis.browser?.tabs || globalThis.chrome?.tabs || null;
	}

	function logWarn(msg, meta) {
		const errs = CC.utils?.errors;
		if (errs?.warn) errs.warn(msg, meta);
		else console.warn('[CC]', msg, meta);
	}

	/**
	 * Validate an incoming runtime message shape.
	 * [FAIL-FAST] Returns false on unknown kinds so callers can reject.
	 */
	function isValidMessage(msg) {
		if (null === msg || 'object' !== typeof msg) return false;
		if ('string' !== typeof msg.kind) return false;
		if (!VALID_KINDS.has(msg.kind)) return false;
		return true;
	}

	/**
	 * Send a one-shot message and await a response.
	 * @param {string} kind
	 * @param {any} [payload]
	 * @returns {Promise<any>}
	 */
	function send(kind, payload) {
		const runtime = getRuntime();
		if (!runtime?.sendMessage) {
			return Promise.reject(new Error('messaging.send: runtime unavailable'));
		}
		if ('string' !== typeof kind || !VALID_KINDS.has(kind)) {
			return Promise.reject(new Error(`messaging.send: invalid kind '${kind}'`));
		}

		return new Promise((resolve, reject) => {
			try {
				const cb = (response) => {
					const err = runtime.lastError;
					if (err) {
						// [EDGE] Service worker may be asleep. Caller can retry.
						reject(new Error(err.message || 'sendMessage failed'));
						return;
					}
					resolve(response);
				};
				const ret = runtime.sendMessage({ kind, payload }, cb);
				// [EDGE] Firefox returns a Promise; if so, defer to it.
				if (ret && typeof ret.then === 'function') {
					ret.then(resolve, reject);
				}
			} catch (e) {
				reject(e);
			}
		});
	}

	/**
	 * Subscribe to runtime messages with shape validation.
	 * @param {(msg: {kind:string, payload:any}, sender: any) => any|Promise<any>} handler
	 * @returns {() => void} unsubscribe
	 */
	function onMessage(handler) {
		const runtime = getRuntime();
		if (!runtime?.onMessage?.addListener) return () => { /* noop */ };
		if ('function' !== typeof handler) {
			logWarn('messaging.onMessage: handler must be a function');
			return () => { /* noop */ };
		}

		const listener = (msg, sender, sendResponse) => {
			if (!isValidMessage(msg)) {
				// [SECURITY] Reject unknown shapes without dispatching.
				return false;
			}
			try {
				const result = handler(msg, sender);
				if (result && typeof result.then === 'function') {
					result.then(
						(value) => { try { sendResponse(value); } catch { /* port closed */ } },
						(err) => { try { sendResponse({ error: err?.message || String(err) }); } catch { /* port closed */ } }
					);
					return true; // keep channel open for async response
				}
				try { sendResponse(result); } catch { /* port closed */ }
				return false;
			} catch (e) {
				try { sendResponse({ error: e?.message || String(e) }); } catch { /* port closed */ }
				return false;
			}
		};

		runtime.onMessage.addListener(listener);
		return () => {
			try { runtime.onMessage.removeListener(listener); } catch { /* noop */ }
		};
	}

	/**
	 * Open or connect to a long-lived port.
	 * Used by the popup to receive state updates without polling.
	 */
	function connect(name) {
		const runtime = getRuntime();
		if (!runtime?.connect) return null;
		try {
			return runtime.connect({ name: name || 'cc-port' });
		} catch (e) {
			logWarn('messaging.connect: failed', { error: e?.message });
			return null;
		}
	}

	function onConnect(handler) {
		const runtime = getRuntime();
		if (!runtime?.onConnect?.addListener) return () => { /* noop */ };
		const wrapped = (port) => {
			try { handler(port); } catch (e) { logWarn('onConnect handler threw', { error: e?.message }); }
		};
		runtime.onConnect.addListener(wrapped);
		return () => {
			try { runtime.onConnect.removeListener(wrapped); } catch { /* noop */ }
		};
	}

	CC.utils = CC.utils || {};
	CC.utils.messaging = {
		KIND,
		send,
		onMessage,
		connect,
		onConnect,
		isValidMessage,
		getRuntime,
		getTabs
	};
})();
