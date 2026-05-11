// [SECURITY] Builds a memory-bundle string and writes it into claude.ai's
// composer via DOM events. Does not call innerHTML; uses textContent and
// dispatched 'input' events so claude.ai's React tree updates correctly.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;

	function pickComposer() {
		const grid = document.querySelector('[data-testid="chat-input-grid-container"]')
			|| document.querySelector('[data-testid="chat-input-grid-area"]');
		if (grid) {
			const editable = grid.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
			if (editable) return editable;
		}
		for (const sel of CC.DOM?.COMPOSER_CANDIDATES || []) {
			try {
				const el = document.querySelector(sel);
				if (el) return el;
			} catch { /* noop */ }
		}
		return document.querySelector('[contenteditable="true"]');
	}

	/**
	 * Format an array of pin rows into a memory block ready for injection.
	 * @param {Array<{chatTitle:string, createdAt:number, content:string}>} pins
	 */
	function buildBundle(pins) {
		if (!Array.isArray(pins) || 0 === pins.length) return '';
		const formatDate = (ts) => {
			try {
				return new Date(ts).toISOString().slice(0, 10);
			} catch { return ''; }
		};
		const blocks = pins.map((p, i) => {
			const title = typeof p?.chatTitle === 'string' && p.chatTitle.length > 0 ? p.chatTitle : 'Untitled chat';
			const date = formatDate(p?.createdAt);
			const content = typeof p?.content === 'string' ? p.content.trim() : '';
			const header = `## From: ${title}${date ? `, ${date}` : ''}`;
			return `${i > 0 ? '---\n' : ''}${header}\n${content}`;
		});
		return `<memory>\n${blocks.join('\n\n')}\n</memory>`;
	}

	/**
	 * Insert `text` into claude.ai's composer.
	 * Decision: append after existing content with a blank line, never replace,
	 * so users don't lose in-progress messages.
	 */
	function insertIntoComposer(text) {
		if ('string' !== typeof text || 0 === text.length) return false;
		const composer = pickComposer();
		if (!composer) return false;

		try {
			composer.focus();

			// Branch on element type. ProseMirror is contenteditable; textareas
			// support direct value mutation.
			if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
				const existing = composer.value || '';
				const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '';
				composer.value = existing + sep + text;
				composer.dispatchEvent(new Event('input', { bubbles: true }));
				composer.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			}

			// Contenteditable / ProseMirror path: synthesize a paste event of
			// plain text. Most React-backed editors accept this and route
			// through their internal command pipeline (so undo works).
			const existing = (composer.textContent || '').trim();
			const payload = existing.length > 0 ? `\n\n${text}` : text;

			// Move caret to end before pasting.
			const range = document.createRange();
			range.selectNodeContents(composer);
			range.collapse(false);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);

			const dt = new DataTransfer();
			dt.setData('text/plain', payload);
			const paste = new ClipboardEvent('paste', {
				bubbles: true,
				cancelable: true,
				clipboardData: dt
			});
			const dispatched = composer.dispatchEvent(paste);
			if (!dispatched || paste.defaultPrevented) {
				// Best-effort fallback: append a text node + input event.
				composer.appendChild(document.createTextNode(payload));
				composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload }));
			}
			return true;
		} catch (e) {
			if (errs?.warn) errs.warn('injection.insertIntoComposer failed', { error: e?.message });
			return false;
		}
	}

	CC.injection = { buildBundle, insertIntoComposer, pickComposer };
})();
