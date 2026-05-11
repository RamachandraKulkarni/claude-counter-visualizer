(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	// [FAIL-FAST] Ensure required utilities are loaded
	if (!CC.utils?.errors) {
		console.error('[CC] Required: errors.js utility');
		return;
	}
	if (!CC.utils?.cleanup) {
		console.error('[CC] Required: cleanup.js utility');
		return;
	}
	if (!CC.utils?.retry) {
		console.error('[CC] Required: retry.js utility');
		return;
	}

	const { error, warn, info, reportError } = CC.utils.errors;
	const { trackObserver, trackTimer, trackCallback, releaseObserver, releaseTimer } = CC.utils.cleanup;
	const { withRetry } = CC.utils.retry;
	const messaging = CC.utils?.messaging || null;
	const db = CC.utils?.db || null;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * [SECURITY] Observer is automatically tracked for cleanup.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 * @returns {Promise<Element|null>} Found element or null on timeout
	 */
	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			// [VALIDATION] Validate selector parameter
			if ('string' !== typeof selector || 0 === selector.length) {
				warn('waitForElement: invalid selector', { selector });
				resolve(null);
				return;
			}

			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId = null;
			let resolved = false;

			const observer = new MutationObserver(() => {
				if (resolved) return;
				const el = document.querySelector(selector);
				if (el) {
					resolved = true;
					if (timeoutId) {
						releaseTimer(timeoutId);
						clearTimeout(timeoutId);
					}
					releaseObserver(observer);
					observer.disconnect();
					resolve(el);
				}
			});

			// [CLEANUP] Track observer for automatic cleanup
			trackObserver(observer);
			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					releaseObserver(observer);
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
				// [CLEANUP] Track timer for cleanup
				trackTimer(timeoutId);
			}
		});
	}

	CC.waitForElement = waitForElement;

	/**
	 * Observe URL changes and fire callback when pathname changes.
	 * [CLEANUP] Returns cleanup function that is automatically tracked.
	 * @param {Function} callback - Function to call on URL change
	 * @returns {Function} Cleanup function
	 */
	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				try {
					callback();
				} catch (e) {
					reportError(e, 'observeUrlChanges.callback');
				}
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		const cleanup = () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};

		// [CLEANUP] Track cleanup for automatic invocation
		trackCallback(cleanup);

		return cleanup;
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);

		// [SECURITY] Persist usage snapshot + ship to service worker for popup state.
		// Errors here are non-critical — never block UI updates.
		persistSnapshot(normalized, source);
	}

	function persistSnapshot(normalized, source) {
		const sessionPct = numericPct(normalized.five_hour?.utilization);
		const weeklyPct = numericPct(normalized.seven_day?.utilization);
		const sessionResetMs = usageResetMs.five_hour;
		const weeklyResetMs = usageResetMs.seven_day;
		const snapshot = {
			ts: Date.now(),
			sessionPct,
			weeklyPct,
			sessionResetMs,
			weeklyResetMs,
			source: source || 'unknown',
			model: null,
			// Include the conversation context with the snapshot so the popup
			// can render Now-card values without a content script connection.
			contextPct: lastContextMetrics?.usedPct ?? null,
			contextTokens: lastContextMetrics?.totalTokens ?? null,
			contextRemaining: lastContextMetrics?.remainingTokens ?? null,
			contextHealth: lastContextMetrics?.contextHealth ?? null
		};

		if (db?.putSnapshot) {
			db.putSnapshot(snapshot).catch((e) => warn('persistSnapshot.db', { error: e?.message }));
		}
		if (messaging?.send) {
			messaging.send(messaging.KIND.SNAPSHOT_PUT, snapshot).catch((e) => {
				// [EDGE] Service worker may be asleep; not fatal.
				warn('persistSnapshot.sw', { error: e?.message });
			});
		}
	}

	function numericPct(value) {
		if ('number' !== typeof value || !Number.isFinite(value)) return null;
		return Math.max(0, Math.min(100, value));
	}

	let lastContextMetrics = null;

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	/**
	 * Refresh usage data with retry logic.
	 * [ERROR-HANDLING] Logs errors instead of silently catching.
	 * [RETRY] Uses exponential backoff on failure.
	 */
	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) {
			warn('refreshUsage: no orgId available');
			return;
		}
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;

		try {
			const raw = await withRetry(
				() => CC.bridge.requestUsage(orgId),
				{ maxAttempts: 3, baseDelay: 1000 }
			);
			const parsed = parseUsageFromUsageEndpoint(raw);
			applyUsageUpdate(parsed, 'usage');
			info('refreshUsage: success', { orgId });
		} catch (e) {
			// [ERROR-HANDLING] Log error instead of silent catch
			warn('refreshUsage: failed after retries', {
				orgId,
				error: e?.message
			});
		} finally {
			usageFetchInFlight = false;
		}
	}

	/**
	 * Refresh conversation data with retry logic.
	 * [ERROR-HANDLING] Logs errors instead of silently catching.
	 */
	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) {
			warn('refreshConversation: no orgId available');
			return;
		}
		updateOrgIdIfNeeded(orgId);

		try {
			await withRetry(
				() => CC.bridge.requestConversation(orgId, currentConversationId),
				{ maxAttempts: 3, baseDelay: 1000 }
			);
		} catch (e) {
			// [ERROR-HANDLING] Log error instead of silent catch
			warn('refreshConversation: failed after retries', {
				conversationId: currentConversationId,
				error: e?.message
			});
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		lastContextMetrics = metrics;
		ui.setConversationMetrics(metrics);

		// [CONFIG] Feed estimator with the current trunk total so its color
		// thresholds reflect remaining context, not raw composer size.
		if (CC.estimator?.setTrunkTokens) {
			CC.estimator.setTrunkTokens(metrics.totalTokens || 0);
		}

		// Persist per-message metadata for burn-rate calculation.
		if (db?.putMessageMeta && Array.isArray(metrics.perMessage)) {
			for (const m of metrics.perMessage) {
				if (!m.createdAt) continue;
				db.putMessageMeta({
					id: m.id,
					conversationId,
					role: m.role,
					tokens: m.tokens,
					createdAt: m.createdAt
				}).catch(() => { /* logged in db.js */ });
			}
		}

		// Cache the metrics + heaviest list for the popup to fetch on demand.
		heaviestCache.set(conversationId, {
			ts: Date.now(),
			heaviest: CC.tokens.getHeaviestMessages(metrics, 5)
		});

		// Refresh burn rate after each conversation refresh.
		updateBurnRate(conversationId);
	}

	const heaviestCache = new Map();

	async function updateBurnRate(conversationId) {
		if (!CC.burnRate?.computeForConversation) return;
		try {
			const rate = await CC.burnRate.computeForConversation(conversationId);
			ui.setBurnRate(rate);
		} catch (e) {
			warn('updateBurnRate failed', { error: e?.message });
		}
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and CHAT_MENU_TRIGGER doesn't exist on home/new pages
		waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level. Only fetch on first load or if stale.
		if (!usageState) await refreshUsage();
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	// [CLEANUP] Track observer and timer for proper cleanup
	let branchObserver = null;
	let branchObserverCleanupTimer = null;

	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// [CLEANUP] Clean up any existing observer and timer
		if (branchObserver) {
			releaseObserver(branchObserver);
			branchObserver.disconnect();
			branchObserver = null;
		}
		if (branchObserverCleanupTimer) {
			releaseTimer(branchObserverCleanupTimer);
			clearTimeout(branchObserverCleanupTimer);
			branchObserverCleanupTimer = null;
		}

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				releaseObserver(branchObserver);
				branchObserver.disconnect();
				branchObserver = null;
				if (branchObserverCleanupTimer) {
					releaseTimer(branchObserverCleanupTimer);
					clearTimeout(branchObserverCleanupTimer);
					branchObserverCleanupTimer = null;
				}
				refreshConversation();
			}
		});

		// [CLEANUP] Track observer for automatic cleanup
		trackObserver(branchObserver);
		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// [CLEANUP] Clean up if nothing changes after 60 seconds
		branchObserverCleanupTimer = setTimeout(() => {
			if (branchObserver) {
				releaseObserver(branchObserver);
				branchObserver.disconnect();
				branchObserver = null;
			}
			branchObserverCleanupTimer = null;
		}, 60000);
		// [CLEANUP] Track timer for cleanup
		trackTimer(branchObserverCleanupTimer);
	});

	// [CONFIG] Phase 1 modules — guarded so missing modules don't crash the host.
	if (CC.estimator?.initialize) {
		try { CC.estimator.initialize(); } catch (e) { reportError(e, 'estimator.initialize'); }
	}

	// [SECURITY] Listen for service-worker messages (settings changes, scroll-to).
	if (messaging?.onMessage) {
		messaging.onMessage((msg) => {
			if (msg.kind === messaging.KIND.SCROLL_TO_MESSAGE) {
				scrollToMessage(msg.payload?.messageId);
				return { ok: true };
			}
			if (msg.kind === messaging.KIND.SETTINGS_CHANGED) {
				applySettings(msg.payload);
				return { ok: true };
			}
			if (msg.kind === messaging.KIND.HEAVIEST_MESSAGES_GET) {
				const conversationId = msg.payload?.conversationId || currentConversationId;
				const entry = heaviestCache.get(conversationId);
				return { ok: true, heaviest: entry?.heaviest || [], conversationId };
			}
			return undefined;
		});
	}

	function scrollToMessage(messageId) {
		if ('string' !== typeof messageId || 0 === messageId.length) return;
		// Claude renders messages with data-test-render-count and data-uuid attrs;
		// fall back to the closest article carrying the message UUID.
		const selectorAttempts = [
			`[data-uuid="${CSS.escape(messageId)}"]`,
			`[data-message-id="${CSS.escape(messageId)}"]`,
			`[data-test-message-id="${CSS.escape(messageId)}"]`
		];
		let target = null;
		for (const sel of selectorAttempts) {
			target = document.querySelector(sel);
			if (target) break;
		}
		if (!target) {
			warn('scrollToMessage: target not found', { messageId });
			return;
		}
		try {
			target.scrollIntoView({ behavior: 'smooth', block: 'center' });
			target.classList.add('cc-flash');
			setTimeout(() => target.classList.remove('cc-flash'), 1500);
		} catch (e) {
			warn('scrollToMessage failed', { error: e?.message });
		}
	}

	let activeSettings = null;
	function applySettings(settings) {
		if (!settings || 'object' !== typeof settings) return;
		activeSettings = settings;
		// [CONFIG] Display toggles — hide/show header parts in-place.
		const root = document.documentElement;
		const d = settings.display || {};
		root.classList.toggle('cc-hide-burnrate', false === d.showBurnRate);
		root.classList.toggle('cc-hide-context', false === d.showContext);
		root.classList.toggle('cc-hide-tokens', false === d.showTokens);
		root.classList.toggle('cc-hide-cache', false === d.showCache);
		root.classList.toggle('cc-hide-session', false === d.showSession);
		root.classList.toggle('cc-hide-weekly', false === d.showWeekly);
		root.classList.toggle('cc-compact', !!d.compact);
		// Theme override
		if (d.themeOverride === 'light') root.setAttribute('data-mode', 'light');
		else if (d.themeOverride === 'dark') root.setAttribute('data-mode', 'dark');
	}

	// Load initial settings via service worker; tolerate offline SW.
	if (messaging?.send) {
		messaging.send(messaging.KIND.SETTINGS_GET).then((res) => {
			if (res?.ok && res.settings) applySettings(res.settings);
		}).catch(() => { /* SW asleep — defaults apply */ });
	}

	// Initial attach + fetches
	handleUrlChange();

	function tick() {
		ui.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		// Optional hourly safety refresh.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	// Keep countdowns + markers updated.
	// [CLEANUP] Track interval for cleanup
	const tickInterval = setInterval(() => {
		try {
			tick();
		} catch (e) {
			reportError(e, 'tick.interval');
		}
	}, 1000);
	trackTimer(tickInterval);

	// Log initialization
	info('main.js initialized', {
		utilsLoaded: !!CC.utils,
		cleanupAvailable: !!CC.utils?.cleanup,
		errorsAvailable: !!CC.utils?.errors,
		retryAvailable: !!CC.utils?.retry
	});
})();
