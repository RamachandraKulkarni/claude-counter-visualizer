// [SECURITY] Embedding worker. Loads the shim (or a real Transformers.js
// runtime once vendored) and serves a small message protocol. No network
// access here other than importScripts of the extension-origin runtime
// itself — the actual model download is performed in a content / popup
// context where chrome.runtime.getURL routing is available, and the
// resulting bytes are passed to the runtime via init().
//
// Protocol (all messages share `{ proto: 'cc-embed', id }`):
//   in:   { type: 'init',  runtimeUrl }
//   in:   { type: 'embed', text }
//   in:   { type: 'embedBatch', texts }   → emits PROGRESS, then DONE with vectors
//   in:   { type: 'abort' }
//   in:   { type: 'status' }
//   out:  { ok, ... payload }
//   out:  { type: 'PROGRESS', done, total }    (broadcast, no id)
'use strict';

let runtime = null;
let runtimeReady = null;
let aborted = false;

function loadRuntime(runtimeUrl) {
	if (runtimeReady) return runtimeReady;
	runtimeReady = new Promise((resolve, reject) => {
		try {
			// [SECURITY] importScripts only loads from the extension origin.
			importScripts(runtimeUrl);
			// The vendored module attaches either `ClaudeCounterEmbedShim` (the
			// in-house fallback) or the Transformers.js global once dropped in.
			if (self.ClaudeCounterEmbedShim?.init) {
				runtime = self.ClaudeCounterEmbedShim;
				runtime.init().then(resolve, reject);
				return;
			}
			// Real Transformers.js path. We expect a small adapter to be
			// included alongside transformers.min.js — see PHASE_5 notes.
			if (self.ClaudeCounterTransformers?.init) {
				runtime = self.ClaudeCounterTransformers;
				runtime.init().then(resolve, reject);
				return;
			}
			reject(new Error('no embedding runtime exposed on self'));
		} catch (e) {
			reject(e);
		}
	});
	return runtimeReady;
}

self.onmessage = async (event) => {
	const msg = event.data;
	if (!msg || msg.proto !== 'cc-embed') return;
	const { id, type } = msg;

	try {
		if (type === 'init') {
			const meta = await loadRuntime(msg.runtimeUrl);
			self.postMessage({ proto: 'cc-embed', id, ok: true, meta });
			return;
		}

		if (type === 'abort') {
			aborted = true;
			self.postMessage({ proto: 'cc-embed', id, ok: true });
			return;
		}

		if (type === 'status') {
			self.postMessage({
				proto: 'cc-embed',
				id,
				ok: true,
				ready: !!runtime,
				vendor: runtime?.vendor || null,
				modelId: runtime?.MODEL_ID || null,
				dim: runtime?.DIM || null
			});
			return;
		}

		if (!runtime) {
			self.postMessage({ proto: 'cc-embed', id, ok: false, error: 'runtime not initialized' });
			return;
		}

		if (type === 'embed') {
			const vec = await runtime.embed(msg.text || '');
			// Transfer the buffer to avoid copy.
			self.postMessage({ proto: 'cc-embed', id, ok: true, vector: vec }, [vec.buffer]);
			return;
		}

		if (type === 'embedBatch') {
			aborted = false;
			const texts = Array.isArray(msg.texts) ? msg.texts : [];
			const total = texts.length;
			const vectors = [];
			for (let i = 0; i < texts.length; i++) {
				if (aborted) {
					self.postMessage({ proto: 'cc-embed', id, ok: true, aborted: true, done: i, total });
					return;
				}
				const v = await runtime.embed(texts[i] || '');
				vectors.push(v);
				if ((i + 1) % 5 === 0 || i === texts.length - 1) {
					self.postMessage({ proto: 'cc-embed', type: 'PROGRESS', done: i + 1, total });
				}
			}
			// Transfer all underlying buffers.
			const transfer = vectors.map((v) => v.buffer);
			self.postMessage({ proto: 'cc-embed', id, ok: true, vectors }, transfer);
			return;
		}

		self.postMessage({ proto: 'cc-embed', id, ok: false, error: `unknown type: ${type}` });
	} catch (e) {
		self.postMessage({ proto: 'cc-embed', id, ok: false, error: e?.message || String(e) });
	}
};
