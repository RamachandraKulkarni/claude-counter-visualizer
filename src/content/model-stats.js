// [SECURITY] Pure local aggregation over IndexedDB rows. Never hardcodes model
// cost ratios — every figure is derived from the user's own message history.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;

	// [CONFIG] Minimum sample size before reporting a per-model burn rate.
	const MIN_SAMPLES = 5;
	const SUPPORTED = ['opus', 'sonnet', 'haiku'];

	/**
	 * Compute per-model averages from the user's messages_meta history.
	 *
	 * Returns:
	 *   { opus: { avgTokensPerMsg, msgCount, totalTokens } | { msgCount, state: 'insufficient_data' },
	 *     sonnet: ..., haiku: ..., other: ... }
	 *
	 * `avgTokensPerMsg` is the empirical "burn per turn" for that model.
	 * Callers compare ratios (e.g. `opus.avgTokensPerMsg / haiku.avgTokensPerMsg`)
	 * to present cost statements — but always qualified with "(your data)".
	 */
	function aggregate(messages) {
		const buckets = {};
		for (const id of SUPPORTED) buckets[id] = { tokens: 0, count: 0 };
		buckets.other = { tokens: 0, count: 0 };

		for (const m of Array.isArray(messages) ? messages : []) {
			if ('number' !== typeof m?.tokens || m.tokens < 0) continue;
			const id = SUPPORTED.includes(m.model) ? m.model : 'other';
			buckets[id].tokens += m.tokens;
			buckets[id].count++;
		}

		const out = {};
		for (const id of Object.keys(buckets)) {
			const b = buckets[id];
			if (b.count < MIN_SAMPLES) {
				out[id] = { msgCount: b.count, totalTokens: b.tokens, state: 'insufficient_data' };
			} else {
				out[id] = {
					msgCount: b.count,
					totalTokens: b.tokens,
					avgTokensPerMsg: b.tokens / b.count,
					state: 'ok'
				};
			}
		}
		return out;
	}

	/**
	 * Read recent messages (last `days` days) and aggregate.
	 */
	async function getModelStats({ days = 7 } = {}) {
		if (!CC.utils?.db?.getAll) return aggregate([]);
		const since = Date.now() - Math.max(1, days) * 86_400_000;
		try {
			const range = IDBKeyRange.lowerBound(since, false);
			const rows = await CC.utils.db.getAll(CC.utils.db.STORES.MESSAGES_META, {
				index: 'by-createdAt',
				query: range
			});
			return aggregate(rows);
		} catch (e) {
			if (errs?.reportError) errs.reportError(e, 'model-stats.getModelStats');
			return aggregate([]);
		}
	}

	/**
	 * Restrict aggregation to a single conversation.
	 */
	async function getStatsForConversation(conversationId) {
		if (!CC.utils?.db?.getMessagesByConversation) return aggregate([]);
		try {
			const rows = await CC.utils.db.getMessagesByConversation(conversationId);
			return aggregate(rows);
		} catch (e) {
			if (errs?.reportError) errs.reportError(e, 'model-stats.getStatsForConversation');
			return aggregate([]);
		}
	}

	/**
	 * Compute a cost ratio between two models from stats.
	 * Returns null when either side has insufficient data.
	 */
	function costRatio(stats, expensiveId, cheapId) {
		const a = stats?.[expensiveId];
		const b = stats?.[cheapId];
		if (!a || !b || a.state !== 'ok' || b.state !== 'ok') return null;
		if (b.avgTokensPerMsg <= 0) return null;
		return a.avgTokensPerMsg / b.avgTokensPerMsg;
	}

	/**
	 * For UI: which models actually appear with usable sample sizes.
	 */
	function activeModels(stats) {
		const list = [];
		for (const id of Object.keys(stats || {})) {
			const s = stats[id];
			if (s && s.state === 'ok' && s.msgCount > 0) list.push(id);
		}
		return list;
	}

	CC.modelStats = {
		aggregate,
		getModelStats,
		getStatsForConversation,
		costRatio,
		activeModels,
		MIN_SAMPLES,
		SUPPORTED
	};
})();
