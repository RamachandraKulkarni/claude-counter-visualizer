// [SECURITY] Pure local computation over IndexedDB rows. No DOM, no network.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;

	// [CONFIG] Rolling-window size for burn rate.
	const WINDOW_MS = 60 * 60 * 1000;        // 60 minutes
	const MIN_SAMPLES = 3;                    // matches PRD F3 acceptance
	const EMA_ALPHA = 0.4;                    // [CONFIG] EMA smoothing factor.

	/**
	 * Compute exponential moving average of message token counts over the window.
	 * [EDGE] Returns { perTurn: null, perHour: null, samples: 0 } when insufficient data.
	 * @param {Array<{tokens:number, createdAt:number, role?:string}>} messages
	 * @param {number} [nowMs]
	 */
	function compute(messages, nowMs = Date.now()) {
		if (!Array.isArray(messages) || 0 === messages.length) {
			return { perTurn: null, perHour: null, samples: 0, windowMs: WINDOW_MS };
		}

		const since = nowMs - WINDOW_MS;
		const recent = messages
			.filter((m) => m && 'number' === typeof m.tokens && 'number' === typeof m.createdAt && m.createdAt >= since)
			.sort((a, b) => a.createdAt - b.createdAt);

		if (recent.length < MIN_SAMPLES) {
			return { perTurn: null, perHour: null, samples: recent.length, windowMs: WINDOW_MS };
		}

		let ema = recent[0].tokens;
		let total = 0;
		for (const m of recent) {
			ema = EMA_ALPHA * m.tokens + (1 - EMA_ALPHA) * ema;
			total += m.tokens;
		}

		const spanMs = Math.max(1, recent[recent.length - 1].createdAt - recent[0].createdAt);
		// Use elapsed-vs-recent window: rate over actual observed span (extrapolation handled by caller).
		const perHour = total * (60 * 60 * 1000 / spanMs);

		return {
			perTurn: Math.max(0, Math.round(ema)),
			perHour: Math.max(0, Math.round(perHour)),
			samples: recent.length,
			windowMs: WINDOW_MS
		};
	}

	/**
	 * Read messages_meta for the current conversation and compute rate.
	 * Returns null on storage failure (caller treats as "Need more data").
	 */
	async function computeForConversation(conversationId) {
		if ('string' !== typeof conversationId || 0 === conversationId.length) {
			return compute([]);
		}
		try {
			const rows = await CC.utils?.db?.getMessagesByConversation(conversationId);
			return compute(rows || []);
		} catch (e) {
			if (errs?.reportError) errs.reportError(e, 'burn-rate.computeForConversation');
			return compute([]);
		}
	}

	CC.burnRate = { compute, computeForConversation, WINDOW_MS };
})();
