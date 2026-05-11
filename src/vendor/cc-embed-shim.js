// [SECURITY] HONEST SHIM — NOT a semantic model.
//
// Real Phase 5 ships with Transformers.js + Xenova/all-MiniLM-L6-v2 quantized
// (per PHASE_5.md P5.0.2). That bundle (~10MB runtime + ~22MB model) is not
// included in this repository. Until the user drops a real
// `src/vendor/transformers.min.js` in and points the manager at it, this shim
// satisfies the same API contract so all UI/plumbing — first-use modal,
// backfill, similar-pins panel, suggestion accept/reject, semantic search
// toggle — can be exercised end-to-end.
//
// What this shim produces:
//   - A deterministic 384-dim Float32Array from the input text.
//   - Identical inputs → identical vectors. Different inputs → different
//     vectors. Cosine similarity is mathematically valid but **not
//     semantically meaningful** (vectors are derived from a hash, not from
//     learned word embeddings).
//
// Documented in UI: the model_state row records `vendor: 'shim'`. Options
// "About" surfaces this so users know they're running the shim until a real
// runtime is installed.
(() => {
	'use strict';

	const DIM = 384;
	const MODEL_ID = 'cc-shim-deterministic-v1';

	function hashU32(s, seed) {
		let h = (seed >>> 0) || 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619) >>> 0;
		}
		return h >>> 0;
	}

	function xorshift32(state) {
		let x = state | 0;
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17; x >>>= 0;
		x ^= x << 5; x >>>= 0;
		return x >>> 0;
	}

	function embedSync(text) {
		const input = typeof text === 'string' ? text.slice(0, 2048) : '';
		const out = new Float32Array(DIM);
		// Two hashes give us 64 bits of seed material; expand via xorshift.
		let s = hashU32(input, 0x9e3779b9);
		const s2 = hashU32(input, 0x85ebca6b) || 1;
		for (let i = 0; i < DIM; i++) {
			s = xorshift32(s ^ (s2 + i));
			// Map u32 → [-1, 1)
			out[i] = ((s & 0x7fffffff) / 0x40000000) - 1;
		}
		// L2-normalize so cosine = dot product.
		let norm = 0;
		for (let i = 0; i < DIM; i++) norm += out[i] * out[i];
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < DIM; i++) out[i] /= norm;
		return out;
	}

	// Worker-style API. `init(opts)` returns metadata so the manager can
	// branch on `vendor === 'shim'` for the "about" readout.
	function init() {
		return Promise.resolve({
			ok: true,
			modelId: MODEL_ID,
			dim: DIM,
			vendor: 'shim',
			runtime: 'js-hash'
		});
	}

	function embed(text) {
		return Promise.resolve(embedSync(text));
	}

	// Public API matches what the worker calls.
	const api = { init, embed, embedSync, DIM, MODEL_ID, vendor: 'shim' };

	if (typeof globalThis !== 'undefined') {
		globalThis.ClaudeCounterEmbedShim = api;
	}
	if (typeof self !== 'undefined' && self !== globalThis) {
		self.ClaudeCounterEmbedShim = api;
	}
})();
