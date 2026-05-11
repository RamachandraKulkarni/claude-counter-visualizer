// [SECURITY] Pure math. No I/O.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * Cosine similarity between two equal-length Float32Arrays.
	 * Returns NaN on mismatched lengths.
	 */
	function cosine(a, b) {
		if (!a || !b || a.length !== b.length) return NaN;
		let dot = 0, na = 0, nb = 0;
		for (let i = 0; i < a.length; i++) {
			const x = a[i]; const y = b[i];
			dot += x * y;
			na += x * x;
			nb += y * y;
		}
		const d = Math.sqrt(na) * Math.sqrt(nb);
		return d === 0 ? 0 : dot / d;
	}

	/**
	 * Top-K candidates above `threshold`, ranked by cosine to `target`.
	 * candidates: Array<{ id, embedding }>
	 * Returns: Array<{ id, score, ref }>
	 */
	function topK(target, candidates, { k = 5, threshold = 0.65, excludeIds = null } = {}) {
		if (!target) return [];
		const out = [];
		for (const c of candidates || []) {
			if (!c?.embedding) continue;
			if (excludeIds && excludeIds.has(c.id)) continue;
			const score = cosine(target, c.embedding);
			if (!Number.isFinite(score)) continue;
			if (score < threshold) continue;
			out.push({ id: c.id, score, ref: c });
		}
		out.sort((a, b) => b.score - a.score);
		return out.slice(0, Math.max(1, k));
	}

	CC.similarity = { cosine, topK };
})();
