// [SECURITY] Reads only the displayed model label from claude.ai's selector.
// No content is sent off-device. The selector is namespaced under `CC.DOM` so
// it can be replaced in one place if claude.ai's DOM shifts.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;
	const cleanup = CC.utils?.cleanup;

	const CANONICAL = Object.freeze(['opus', 'sonnet', 'haiku']);

	function normalize(displayString) {
		if ('string' !== typeof displayString || 0 === displayString.length) return 'unknown';
		const lower = displayString.toLowerCase();
		for (const id of CANONICAL) {
			if (lower.includes(id)) return id;
		}
		return 'unknown';
	}

	function readFromDom() {
		try {
			const el = document.querySelector(CC.DOM.ACTIVE_MODEL_LABEL);
			if (!el) return 'unknown';
			// Prefer the visible textContent of the selector trigger.
			const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
			return normalize(text);
		} catch {
			return 'unknown';
		}
	}

	let currentModel = 'unknown';
	let observer = null;
	let initialized = false;
	const subscribers = new Set();

	function getCurrentModel() {
		return currentModel;
	}

	function _emitChange(prev, next) {
		for (const fn of subscribers) {
			try { fn(next, prev); }
			catch (e) { if (errs?.reportError) errs.reportError(e, 'model-detect.subscriber'); }
		}
		try {
			window.dispatchEvent(new CustomEvent('cc:model_changed', { detail: { model: next, previous: prev } }));
		} catch { /* CustomEvent shouldn't fail in modern browsers */ }
	}

	function refresh() {
		const next = readFromDom();
		if (next === currentModel) return;
		const prev = currentModel;
		currentModel = next;
		_emitChange(prev, next);
	}

	function onChange(fn) {
		if ('function' !== typeof fn) return () => { /* noop */ };
		subscribers.add(fn);
		return () => subscribers.delete(fn);
	}

	function bindSelectorObserver() {
		const target = document.querySelector(CC.DOM.ACTIVE_MODEL_LABEL);
		if (!target) {
			// Selector not in DOM yet — re-try when body changes.
			const bodyObs = new MutationObserver(() => {
				if (document.querySelector(CC.DOM.ACTIVE_MODEL_LABEL)) {
					try { bodyObs.disconnect(); } catch { /* noop */ }
					bindSelectorObserver();
				}
			});
			try {
				bodyObs.observe(document.body, { childList: true, subtree: true });
				cleanup?.trackObserver?.(bodyObs);
			} catch { /* noop */ }
			return;
		}

		// Tear down any previous observer before rebinding.
		if (observer) {
			try { observer.disconnect(); } catch { /* noop */ }
			cleanup?.releaseObserver?.(observer);
			observer = null;
		}

		observer = new MutationObserver(() => refresh());
		try {
			observer.observe(target, {
				childList: true,
				characterData: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['aria-label', 'title']
			});
			cleanup?.trackObserver?.(observer);
		} catch (e) {
			if (errs?.warn) errs.warn('model-detect.observe failed', { error: e?.message });
		}

		refresh();
	}

	function initialize() {
		if (initialized) return;
		initialized = true;
		bindSelectorObserver();
		// Also re-check on URL change in case Claude rebuilds the toolbar.
		window.addEventListener('cc:urlchange', refresh);
		window.addEventListener('popstate', refresh);
		cleanup?.trackCallback?.(() => {
			window.removeEventListener('cc:urlchange', refresh);
			window.removeEventListener('popstate', refresh);
		});
	}

	/**
	 * Extract the canonical model id from a conversation-payload message, if any.
	 * Claude's `chat_messages` sometimes includes `model` on assistant messages.
	 */
	function modelFromMessage(message) {
		if (!message || 'object' !== typeof message) return null;
		const candidate = message.model || message.model_name || message.model_id;
		if ('string' === typeof candidate) return normalize(candidate);
		return null;
	}

	CC.modelDetect = {
		initialize,
		getCurrentModel,
		onChange,
		refresh,
		normalize,
		modelFromMessage,
		CANONICAL
	};
})();
