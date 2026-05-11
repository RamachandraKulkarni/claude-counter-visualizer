// [SECURITY] Worker only accepts messages with the cc-tok protocol shape.
// No eval, no remote scripts, only the local vendored tokenizer.
'use strict';

let tokenizerReady = null;

function init(vendorUrl) {
	if (tokenizerReady) return tokenizerReady;
	tokenizerReady = new Promise((resolve, reject) => {
		try {
			// [SECURITY] importScripts only loads from the extension origin.
			importScripts(vendorUrl);
			const tok = self.GPTTokenizer_o200k_base;
			if (!tok || 'function' !== typeof tok.countTokens) {
				reject(new Error('tokenizer not available after import'));
				return;
			}
			resolve(tok);
		} catch (e) {
			reject(e);
		}
	});
	return tokenizerReady;
}

self.onmessage = async (event) => {
	const msg = event.data;
	if (!msg || 'object' !== typeof msg) return;

	const { id, type, text, vendorUrl } = msg;
	if ('cc-tok' !== msg.proto) return; // [SECURITY] reject foreign protocols

	try {
		if (type === 'init') {
			await init(vendorUrl);
			self.postMessage({ proto: 'cc-tok', id, ok: true });
			return;
		}
		if (type === 'count') {
			const tok = await init(vendorUrl);
			const count = 'string' === typeof text && text.length > 0 ? tok.countTokens(text) : 0;
			self.postMessage({ proto: 'cc-tok', id, ok: true, count });
			return;
		}
		self.postMessage({ proto: 'cc-tok', id, ok: false, error: `unknown type: ${type}` });
	} catch (e) {
		self.postMessage({ proto: 'cc-tok', id, ok: false, error: e?.message || String(e) });
	}
};
