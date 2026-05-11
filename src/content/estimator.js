// [SECURITY] Reads only the composer's plain text — never injects untrusted
// content via innerHTML, and never sends content off-device.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;
	const cleanup = CC.utils?.cleanup;

	// [CONFIG] Debounce window for keystroke -> tokenize.
	const DEBOUNCE_MS = 200;
	const PASTE_THRESHOLD_CHARS = 12000;

	let composerEl = null;
	let indicatorEl = null;
	let tooltipEl = null;
	let breakdownEl = null;
	let inputListenerEl = null;
	let inputListener = null;
	let debounceTimer = null;
	let lastText = null;
	let lastAttachmentChars = 0;
	let composerObserver = null;
	let attachmentsObserver = null;
	let trunkTokens = 0;
	let contextLimit = (CC.CONST && CC.CONST.CONTEXT_LIMIT_TOKENS) || 200000;
	let detached = false;
	let lastEstimate = 0;
	let initialized = false;

	function pickComposer() {
		// Claude's composer is a contenteditable ProseMirror inside the chat input.
		// Prefer the role-textbox surface within the grid container.
		const grid = document.querySelector('[data-testid="chat-input-grid-container"]')
			|| document.querySelector('[data-testid="chat-input-grid-area"]');
		if (grid) {
			const editable = grid.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
			if (editable) return editable;
		}
		return document.querySelector('[contenteditable="true"][data-testid]')
			|| document.querySelector('div.ProseMirror[contenteditable="true"]')
			|| document.querySelector('[contenteditable="true"]');
	}

	function pickSendButton() {
		return document.querySelector('button[aria-label="Send message"]')
			|| document.querySelector('[data-testid="send-button"]')
			|| document.querySelector('button[aria-label="Send Message"]')
			|| document.querySelector('button[aria-label*="Send"]');
	}

	function getComposerText(el) {
		if (!el) return '';
		// [EDGE] textContent preserves text only — never HTML, never attributes.
		return el.textContent || '';
	}

	function getAttachmentText() {
		// Heuristic: count visible attachment chip filenames/sizes as a tiny proxy.
		// Real extracted_content tokens are accounted for on the next conversation
		// refresh, so this estimator only handles the composer text precisely.
		try {
			const chips = document.querySelectorAll('[data-testid*="attachment"], [aria-label*="attachment"]');
			let chars = 0;
			chips.forEach((c) => { chars += (c.textContent || '').length; });
			return chars;
		} catch {
			return 0;
		}
	}

	function setIndicatorState(stateClass) {
		if (!indicatorEl) return;
		indicatorEl.classList.remove('cc-est--warn', 'cc-est--crit');
		if (stateClass) indicatorEl.classList.add(stateClass);
	}

	function renderIndicator(addedTokens, attachmentChars) {
		if (!indicatorEl) return;

		const remaining = Math.max(0, contextLimit - trunkTokens);
		const pctOfRemaining = remaining > 0 ? (addedTokens / remaining) * 100 : 0;
		const projectedPct = ((trunkTokens + addedTokens) / contextLimit) * 100;

		const compactTokens = addedTokens >= 1000
			? `${(Math.round(addedTokens / 100) / 10).toLocaleString()}k`
			: addedTokens.toLocaleString();

		const pctText = remaining > 0
			? `· ${pctOfRemaining < 1 ? '<1' : Math.round(pctOfRemaining)}% of remaining`
			: '';

		indicatorEl.querySelector('.cc-estCount').textContent = `+ ~${compactTokens} tokens`;
		indicatorEl.querySelector('.cc-estContext').textContent = pctText;

		if (projectedPct >= 95) setIndicatorState('cc-est--crit');
		else if (projectedPct >= 80) setIndicatorState('cc-est--warn');
		else setIndicatorState(null);

		// Tooltip breakdown
		if (breakdownEl) {
			breakdownEl.textContent =
				`Composer: ${addedTokens.toLocaleString()} · Attachments: ${attachmentChars > 0 ? '~' + Math.ceil(attachmentChars / 4) : 0}`;
		}

		// [ACCESSIBILITY] aria-label keeps screen readers informed.
		indicatorEl.setAttribute('aria-label',
			`Estimated cost of next message: ${addedTokens.toLocaleString()} tokens. ${remaining > 0 ? Math.round(pctOfRemaining) + ' percent of remaining context.' : ''}`);
	}

	async function recompute() {
		if (detached || !composerEl || !indicatorEl) return;
		const text = getComposerText(composerEl);
		const attachChars = getAttachmentText();
		if (text === lastText && attachChars === lastAttachmentChars) {
			renderIndicator(lastEstimate, attachChars);
			return;
		}
		lastText = text;
		lastAttachmentChars = attachChars;

		if (0 === text.length) {
			lastEstimate = 0;
			renderIndicator(0, attachChars);
			return;
		}

		try {
			let count = 0;
			if (text.length > PASTE_THRESHOLD_CHARS && CC.utils?.workerTokenizer?.tokenize) {
				count = await CC.utils.workerTokenizer.tokenize(text);
			} else if (globalThis.GPTTokenizer_o200k_base?.countTokens) {
				count = globalThis.GPTTokenizer_o200k_base.countTokens(text);
			} else if (CC.utils?.workerTokenizer?.tokenize) {
				count = await CC.utils.workerTokenizer.tokenize(text);
			}
			lastEstimate = count;
			renderIndicator(count, attachChars);
		} catch (e) {
			if (errs?.warn) errs.warn('estimator.recompute failed', { error: e?.message });
		}
	}

	function scheduleRecompute() {
		if (debounceTimer) {
			cleanup?.releaseTimer?.(debounceTimer);
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			recompute().catch((e) => {
				if (errs?.reportError) errs.reportError(e, 'estimator.scheduleRecompute');
			});
		}, DEBOUNCE_MS);
		cleanup?.trackTimer?.(debounceTimer);
	}

	function buildIndicator() {
		const wrap = document.createElement('div');
		wrap.className = 'cc-est';
		wrap.setAttribute('role', 'status');
		wrap.setAttribute('aria-live', 'polite');
		wrap.setAttribute('tabindex', '0');

		const count = document.createElement('span');
		count.className = 'cc-estCount';
		count.textContent = '+ ~0 tokens';

		const context = document.createElement('span');
		context.className = 'cc-estContext';
		context.textContent = '';

		wrap.appendChild(count);
		wrap.appendChild(context);

		const tip = document.createElement('div');
		tip.className = 'cc-tooltip cc-est-tooltip';
		const title = document.createElement('div');
		title.className = 'cc-tooltipTitle';
		title.textContent = 'Estimated message cost';
		const line = document.createElement('div');
		line.className = 'cc-tooltipLine';
		line.textContent = 'Composer: 0 · Attachments: 0';
		tip.appendChild(title);
		tip.appendChild(line);
		document.body.appendChild(tip);

		breakdownEl = line;
		tooltipEl = tip;

		// Minimal hover tooltip (CSS-driven; positioning handled by JS).
		const showTip = () => {
			tip.style.opacity = '1';
			const rect = wrap.getBoundingClientRect();
			tip.style.left = `${rect.left + rect.width / 2}px`;
			tip.style.top = `${rect.top - 8}px`;
			tip.style.transform = 'translate(-50%, -100%)';
		};
		const hideTip = () => { tip.style.opacity = '0'; };

		wrap.addEventListener('pointerenter', showTip);
		wrap.addEventListener('pointerleave', hideTip);
		wrap.addEventListener('focus', showTip);
		wrap.addEventListener('blur', hideTip);

		return wrap;
	}

	function attachIndicator() {
		const sendBtn = pickSendButton();
		if (!sendBtn) return false;
		if (indicatorEl && document.contains(indicatorEl)) return true;
		indicatorEl = buildIndicator();
		const host = sendBtn.parentElement || sendBtn;
		// Place to the left of send when possible.
		if (host.firstElementChild === sendBtn) {
			host.insertBefore(indicatorEl, sendBtn);
		} else {
			host.appendChild(indicatorEl);
		}
		return true;
	}

	function bindComposer(el) {
		if (!el) return;
		if (inputListenerEl === el && inputListener) return; // already bound
		releaseListener();
		inputListenerEl = el;
		inputListener = () => scheduleRecompute();
		el.addEventListener('input', inputListener, { passive: true });
		// Initial render once bound.
		scheduleRecompute();
	}

	function releaseListener() {
		if (inputListenerEl && inputListener) {
			try { inputListenerEl.removeEventListener('input', inputListener); } catch { /* noop */ }
		}
		inputListenerEl = null;
		inputListener = null;
	}

	function discoverComposer() {
		const el = pickComposer();
		if (el && el !== composerEl) {
			composerEl = el;
			bindComposer(el);
		}
		attachIndicator();
	}

	function setupObservers() {
		composerObserver = new MutationObserver(() => {
			if (!composerEl || !document.contains(composerEl)) {
				composerEl = null;
				releaseListener();
				discoverComposer();
			} else if (!indicatorEl || !document.contains(indicatorEl)) {
				indicatorEl = null;
				attachIndicator();
			}
		});
		composerObserver.observe(document.body, { childList: true, subtree: true });
		cleanup?.trackObserver?.(composerObserver);

		attachmentsObserver = new MutationObserver(() => scheduleRecompute());
		attachmentsObserver.observe(document.body, { childList: true, subtree: true });
		cleanup?.trackObserver?.(attachmentsObserver);
	}

	/**
	 * Update the trunk-tokens reference used to color/percent the indicator.
	 */
	function setTrunkTokens(n) {
		if ('number' === typeof n && Number.isFinite(n)) {
			trunkTokens = Math.max(0, n);
			scheduleRecompute();
		}
	}

	function destroy() {
		detached = true;
		releaseListener();
		try { composerObserver?.disconnect(); } catch { /* noop */ }
		try { attachmentsObserver?.disconnect(); } catch { /* noop */ }
		if (indicatorEl) { try { indicatorEl.remove(); } catch { /* noop */ } indicatorEl = null; }
		if (tooltipEl) { try { tooltipEl.remove(); } catch { /* noop */ } tooltipEl = null; }
	}

	function initialize() {
		if (initialized) return;
		initialized = true;
		discoverComposer();
		setupObservers();
	}

	CC.estimator = { initialize, setTrunkTokens, destroy };
})();
