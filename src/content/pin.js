// [SECURITY] Pin module reads message text via textContent and stores it only
// in local IndexedDB. No outbound network. DOM is touched only through
// querySelector + the small icon node we own.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const errs = CC.utils?.errors;
	const cleanup = CC.utils?.cleanup;
	const db = CC.utils?.db;

	const PIN_ATTR = 'data-cc-pin-msg';   // marks a message container we've decorated
	const PIN_ID_ATTR = 'data-cc-pin-id'; // pin record id, set when active

	let initialized = false;
	let mainObserver = null;
	let lastPointerTarget = null;
	let lastContextMenuTarget = null;

	// In-memory index of pinned message UUIDs for the current chat — drives the
	// visual state without hitting IndexedDB on every render tick.
	const pinnedByUuid = new Map(); // uuid -> pin record

	function logWarn(msg, meta) { if (errs?.warn) errs.warn(msg, meta); }

	// ---------------------------------------------------------------------
	// DOM discovery
	// ---------------------------------------------------------------------

	function querySelectorAll(selectors) {
		const out = [];
		for (const sel of selectors) {
			try {
				const list = document.querySelectorAll(sel);
				if (list.length) {
					for (const el of list) out.push(el);
					return out; // first selector that matches wins
				}
			} catch { /* invalid selector tolerated */ }
		}
		return out;
	}

	function findMessageContainers() {
		return querySelectorAll(CC.DOM.MESSAGE_CONTAINERS || []);
	}

	function findActionToolbar(container) {
		// Prefer claude.ai's own toolbar selectors so the pin button sits
		// alongside copy/edit. Fallback: append directly to the container.
		for (const sel of CC.DOM.MESSAGE_ACTION_TOOLBAR_CANDIDATES || []) {
			try {
				const tb = container.querySelector(sel);
				if (tb) return tb;
			} catch { /* noop */ }
		}
		return null;
	}

	function readMessageUuidFromDom(container) {
		for (const attr of CC.DOM.MESSAGE_UUID_ATTRS || []) {
			const v = container.getAttribute?.(attr);
			if (v && typeof v === 'string') return v;
		}
		return null;
	}

	function readChatTitle() {
		for (const sel of CC.DOM.CHAT_TITLE_CANDIDATES || []) {
			try {
				const el = document.querySelector(sel);
				if (el?.textContent) return el.textContent.trim().slice(0, 200);
			} catch { /* noop */ }
		}
		return 'Untitled chat';
	}

	function detectRole(container) {
		// Heuristic — claude.ai distinguishes user vs assistant turns with
		// different containers. Use data-testid pattern, fallback to class names.
		const testid = container.getAttribute('data-testid') || '';
		if (/user/i.test(testid)) return 'user';
		if (/assistant/i.test(testid)) return 'assistant';
		const cls = container.className || '';
		if (/user/i.test(cls)) return 'user';
		if (/assistant/i.test(cls)) return 'assistant';
		return 'unknown';
	}

	function extractMessageText(container) {
		// [EDGE] container.textContent might include the action toolbar text
		// ("Copy", "Edit"...). Strip our own pin button and known toolbar
		// before extracting. Use a clone so we don't mutate the live tree.
		try {
			const clone = container.cloneNode(true);
			clone.querySelectorAll('.cc-pinIcon').forEach((n) => n.remove());
			for (const sel of CC.DOM.MESSAGE_ACTION_TOOLBAR_CANDIDATES || []) {
				clone.querySelectorAll(sel).forEach((n) => n.remove());
			}
			return (clone.textContent || '').trim();
		} catch {
			return (container.textContent || '').trim();
		}
	}

	function getCurrentConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	// ---------------------------------------------------------------------
	// Icon injection
	// ---------------------------------------------------------------------

	function buildIconNode(messageUuid) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'cc-pinIcon';
		btn.setAttribute('aria-label', 'Pin this message');
		btn.setAttribute('aria-pressed', 'false');
		btn.setAttribute('tabindex', '0');
		btn.setAttribute('data-cc-msg-uuid', messageUuid || '');

		// Outlined pin glyph.
		btn.innerHTML = ''; // explicit clear; we attach SVG via DOM API below
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const path = document.createElementNS(svgNS, 'path');
		// Simple pin glyph: head + needle.
		path.setAttribute('d', 'M9.5 1.5 L14.5 6.5 L11 7 L8 12 L7 11 L4 14 L2 14 L2 12 L5 9 L4 8 L9 5 L9.5 1.5 Z');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		btn.appendChild(svg);

		btn.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			handlePinToggle(btn).catch((e) => { if (errs?.reportError) errs.reportError(e, 'pin.click'); });
		});
		btn.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') {
				ev.preventDefault();
				handlePinToggle(btn).catch((e) => { if (errs?.reportError) errs.reportError(e, 'pin.key'); });
			}
		});
		return btn;
	}

	function applyPinnedClass(container, isPinned, pinId) {
		container.classList.toggle('cc-pinnedMsg', !!isPinned);
		if (isPinned && pinId) container.setAttribute(PIN_ID_ATTR, pinId);
		else container.removeAttribute(PIN_ID_ATTR);
	}

	function applyIconState(btn, isPinned) {
		btn.classList.toggle('cc-pinIcon--active', !!isPinned);
		btn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
		btn.setAttribute('aria-label', isPinned ? 'Unpin this message' : 'Pin this message');
	}

	/**
	 * Decorate every visible message: ensure root has cc-msgRoot, ensure pin
	 * icon exists, and ensure its state matches `pinnedByUuid`.
	 */
	function decorateMessages() {
		const containers = findMessageContainers();
		if (!containers.length) return;

		// Map DOM index -> UUID from the live trunk so we can pin messages even
		// when claude.ai's DOM doesn't expose a uuid attribute.
		const trunk = CC.lastTrunkMessageMeta || [];

		containers.forEach((container, idx) => {
			if (!container.classList) return;
			container.classList.add('cc-msgRoot');

			// Find or derive UUID for this DOM node.
			let uuid = readMessageUuidFromDom(container);
			if (!uuid && trunk[idx]?.id) uuid = trunk[idx].id;

			// Already decorated this exact uuid? leave it.
			if (container.getAttribute(PIN_ATTR) === uuid) {
				const existing = container.querySelector(':scope > .cc-pinIcon, .cc-pinIcon[data-cc-msg-uuid]');
				if (existing) {
					const isPinned = !!uuid && pinnedByUuid.has(uuid);
					applyIconState(existing, isPinned);
					applyPinnedClass(container, isPinned, isPinned ? pinnedByUuid.get(uuid)?.id : null);
				}
				return;
			}
			container.setAttribute(PIN_ATTR, uuid || '');

			// Remove stale icon if container was reused for a different uuid.
			container.querySelectorAll(':scope .cc-pinIcon').forEach((n) => n.remove());

			const iconNode = buildIconNode(uuid);
			const toolbar = findActionToolbar(container);
			if (toolbar) toolbar.appendChild(iconNode);
			else container.appendChild(iconNode);

			const isPinned = !!uuid && pinnedByUuid.has(uuid);
			applyIconState(iconNode, isPinned);
			applyPinnedClass(container, isPinned, isPinned ? pinnedByUuid.get(uuid)?.id : null);
		});
	}

	// ---------------------------------------------------------------------
	// Pin lifecycle
	// ---------------------------------------------------------------------

	async function loadPinsForCurrentChat() {
		const conversationId = getCurrentConversationId();
		pinnedByUuid.clear();
		if (!conversationId || !db?.getPinsForConversation) return;
		try {
			const pins = await db.getPinsForConversation(conversationId);
			for (const p of pins) {
				if (p?.messageUuid) pinnedByUuid.set(p.messageUuid, p);
			}
		} catch (e) {
			if (errs?.warn) errs.warn('pin.loadPinsForCurrentChat failed', { error: e?.message });
		}
		decorateMessages();
	}

	function findTrunkEntryForUuid(uuid) {
		if (!uuid || !Array.isArray(CC.lastTrunkMessageMeta)) return null;
		return CC.lastTrunkMessageMeta.find((m) => m.id === uuid) || null;
	}

	async function pinMessage(container, btn) {
		const uuid = (btn?.getAttribute('data-cc-msg-uuid')) || readMessageUuidFromDom(container);
		const conversationId = getCurrentConversationId();
		if (!uuid || !conversationId) {
			if (CC.ui?.showToast) CC.ui.showToast('Pin failed — could not identify message.');
			return null;
		}

		const trunkEntry = findTrunkEntryForUuid(uuid);
		const content = extractMessageText(container);
		const role = trunkEntry?.role || detectRole(container);
		const tokenCount = trunkEntry?.tokens || 0;

		const settings = CC.activeSettings?.memory || {};
		const autoTags = [];
		const chatTitle = readChatTitle();
		if (settings.autoTagChatTitle !== false && chatTitle) autoTags.push(chatTitle.toLowerCase().slice(0, 40));
		if (settings.autoTagDate !== false) autoTags.push(new Date().toISOString().slice(0, 10));
		const model = CC.modelDetect?.getCurrentModel?.() || 'unknown';
		if (settings.autoTagModel !== false && model && model !== 'unknown') autoTags.push(model);
		const defaultTags = Array.isArray(settings.defaultTags) ? settings.defaultTags : [];

		const pin = await db.putPin({
			conversationId,
			messageUuid: uuid,
			role,
			content,
			tokenCount,
			tags: Array.from(new Set([...defaultTags, ...autoTags])),
			sourceUrl: window.location.href,
			chatTitle,
			model
		});
		if (!pin) {
			if (CC.ui?.showToast) CC.ui.showToast('Pin failed.');
			return null;
		}

		pinnedByUuid.set(uuid, pin);
		applyIconState(btn, true);
		applyPinnedClass(container, true, pin.id);
		if (CC.ui?.showToast) CC.ui.showToast('Pinned');
		return pin;
	}

	async function unpinMessage(container, btn) {
		const uuid = (btn?.getAttribute('data-cc-msg-uuid')) || readMessageUuidFromDom(container);
		if (!uuid) return false;
		const existing = pinnedByUuid.get(uuid);
		if (!existing) return false;

		const removed = { ...existing }; // snapshot for undo
		const ok = await db.deletePin(existing.id);
		if (!ok) {
			if (CC.ui?.showToast) CC.ui.showToast('Unpin failed.');
			return false;
		}
		// [SECURITY] Cascade: a deleted pin's manual links become dangling and
		// must go too. Decision: undo-pin does NOT auto-restore links — keeps
		// the cascade simple and matches PHASE_4 P4.2.5.
		let linksRemoved = 0;
		if (db?.cascadeDeleteLinksForPin) {
			try { linksRemoved = await db.cascadeDeleteLinksForPin(existing.id); }
			catch (e) { if (errs?.warn) errs.warn('pin.unpin.cascadeLinks failed', { error: e?.message }); }
		}
		void linksRemoved;
		pinnedByUuid.delete(uuid);
		applyIconState(btn, false);
		applyPinnedClass(container, false, null);

		if (CC.ui?.showToast) {
			CC.ui.showToast('Unpinned', {
				duration: 10_000,
				action: {
					label: 'Undo',
					onClick: async () => {
						// [EDGE] Undo restores the exact previous record (same id).
						const restored = await db.putPin(removed);
						if (!restored || !uuid) return;
						pinnedByUuid.set(uuid, restored);
						applyIconState(btn, true);
						applyPinnedClass(container, true, restored.id);
					}
				}
			});
		}
		return true;
	}

	async function handlePinToggle(btn) {
		const container = btn?.closest?.('.cc-msgRoot') || btn?.closest?.('[data-cc-pin-msg]');
		if (!container) return;
		const uuid = btn.getAttribute('data-cc-msg-uuid') || readMessageUuidFromDom(container);
		if (uuid && pinnedByUuid.has(uuid)) await unpinMessage(container, btn);
		else await pinMessage(container, btn);
	}

	// ---------------------------------------------------------------------
	// Hotkey / context-menu targeting
	// ---------------------------------------------------------------------

	function findHotkeyTarget() {
		// Priority order: last-hovered, focused ancestor, message in viewport center.
		if (lastPointerTarget && document.contains(lastPointerTarget)) {
			const m = lastPointerTarget.closest?.('.cc-msgRoot, [data-cc-pin-msg]');
			if (m) return m;
		}
		const active = document.activeElement;
		if (active) {
			const m = active.closest?.('.cc-msgRoot, [data-cc-pin-msg]');
			if (m) return m;
		}
		const containers = findMessageContainers();
		if (containers.length === 0) return null;
		const viewportMid = window.innerHeight / 2;
		let best = null;
		let bestDist = Infinity;
		for (const c of containers) {
			const rect = c.getBoundingClientRect();
			const center = rect.top + rect.height / 2;
			const dist = Math.abs(center - viewportMid);
			if (dist < bestDist) { bestDist = dist; best = c; }
		}
		return best;
	}

	async function pinByHotkey() {
		const container = findHotkeyTarget();
		if (!container) {
			if (CC.ui?.showToast) CC.ui.showToast('No message under cursor or focus.');
			return;
		}
		const btn = container.querySelector?.('.cc-pinIcon');
		if (!btn) {
			if (CC.ui?.showToast) CC.ui.showToast('Pin UI not ready yet.');
			return;
		}
		await handlePinToggle(btn);
	}

	async function pinByContextMenu() {
		const container = lastContextMenuTarget?.closest?.('.cc-msgRoot, [data-cc-pin-msg]')
			|| findHotkeyTarget();
		if (!container) {
			if (CC.ui?.showToast) CC.ui.showToast('Right-click a message to pin it.');
			return;
		}
		const btn = container.querySelector?.('.cc-pinIcon');
		if (!btn) return;
		await handlePinToggle(btn);
	}

	// ---------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------

	function setupPointerTracking() {
		const onPointerMove = (e) => { lastPointerTarget = e.target || null; };
		const onContextMenu = (e) => { lastContextMenuTarget = e.target || null; };
		document.addEventListener('pointermove', onPointerMove, { passive: true });
		document.addEventListener('contextmenu', onContextMenu, { passive: true });
		cleanup?.trackCallback?.(() => {
			document.removeEventListener('pointermove', onPointerMove);
			document.removeEventListener('contextmenu', onContextMenu);
		});
	}

	function setupObserver() {
		mainObserver = new MutationObserver(() => {
			// Re-decorate on DOM churn. Cheap because decorateMessages is idempotent.
			decorateMessages();
		});
		try {
			mainObserver.observe(document.body, { childList: true, subtree: true });
			cleanup?.trackObserver?.(mainObserver);
		} catch (e) {
			if (errs?.warn) errs.warn('pin.observe failed', { error: e?.message });
		}
	}

	function initialize() {
		if (initialized) return;
		initialized = true;
		setupPointerTracking();
		setupObserver();
		loadPinsForCurrentChat();
		window.addEventListener('cc:urlchange', loadPinsForCurrentChat);
		window.addEventListener('popstate', loadPinsForCurrentChat);
		cleanup?.trackCallback?.(() => {
			window.removeEventListener('cc:urlchange', loadPinsForCurrentChat);
			window.removeEventListener('popstate', loadPinsForCurrentChat);
		});
	}

	function onConversationLoaded() {
		// Called from main.js whenever fresh trunk data lands. Refresh state and
		// re-decorate so per-message UUIDs align with the latest trunk.
		loadPinsForCurrentChat();
	}

	CC.pin = {
		initialize,
		onConversationLoaded,
		pinByHotkey,
		pinByContextMenu,
		decorateMessages,
		loadPinsForCurrentChat
	};
})();
