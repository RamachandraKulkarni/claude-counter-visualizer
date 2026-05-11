// [SECURITY] Service worker has no DOM, no window. It only persists data,
// runs alarms, and dispatches notifications. Never executes untrusted strings.
'use strict';

// MV3 service workers are ephemeral. Always rehydrate from storage.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND = Object.freeze({
	SNAPSHOT_PUT: 'snapshot.put',
	STATE_GET: 'state.get',
	STATE_CHANGED: 'state.changed',
	SETTINGS_CHANGED: 'settings.changed',
	SETTINGS_GET: 'settings.get',
	SETTINGS_SET: 'settings.set',
	WIPE_ALL: 'wipe.all',
	PING: 'ping',
	FOCUS_CHAT: 'focus.chat',
	SCROLL_TO_MESSAGE: 'scroll.to.message',
	HEAVIEST_MESSAGES_GET: 'heaviest.get',
	FORECAST_GET: 'forecast.get'
});

// [CONFIG] Defaults seeded on install. Mirrors options page UI.
const DEFAULT_SETTINGS = Object.freeze({
	display: {
		showTokens: true,
		showCache: true,
		showContext: true,
		showSession: true,
		showWeekly: true,
		showBurnRate: true,
		compact: false,
		themeOverride: 'auto' // 'auto' | 'light' | 'dark'
	},
	notifications: {
		muted: false,
		enabled75: true,
		enabled90: true,
		enabled95: true
	},
	thresholds: {
		session: [75, 90, 95],
		weekly: [75, 90, 95],
		contextHealth: { moderate: 50, near: 75, critical: 90 }
	},
	memory: {
		hotkey: 'P',
		defaultTags: []
	}
});

// [CONFIG] Notification templates per threshold.
const NOTIFICATION_TEMPLATES = {
	75: 'is at 75%. Comfortable headroom remains at current pace.',
	90: 'is at 90%. Consider switching to Haiku for non-critical tasks.',
	95: 'is at 95%. Next 2-3 turns may hit the cap.'
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, meta) {
	const fn = level === 'error' ? console.error
		: level === 'warn' ? console.warn
			: level === 'info' ? console.info
				: console.log;
	if (meta) fn(`[CC-SW] ${level}:`, msg, meta);
	else fn(`[CC-SW] ${level}:`, msg);
}

// ---------------------------------------------------------------------------
// Storage helpers (chrome.storage shim — works in both Chrome and Firefox MV3)
// ---------------------------------------------------------------------------

const storageArea = (area) => globalThis.browser?.storage?.[area] || globalThis.chrome?.storage?.[area];

function storageGet(area, keys) {
	const s = storageArea(area);
	if (!s) return Promise.resolve({});
	return new Promise((resolve) => {
		try {
			const ret = s.get(keys, (result) => resolve(result || {}));
			if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve({}));
		} catch (e) {
			log('warn', 'storage.get failed', { area, error: e?.message });
			resolve({});
		}
	});
}

function storageSet(area, obj) {
	const s = storageArea(area);
	if (!s) return Promise.resolve();
	return new Promise((resolve) => {
		try {
			const ret = s.set(obj, () => resolve());
			if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve());
		} catch (e) {
			log('warn', 'storage.set failed', { area, error: e?.message });
			resolve();
		}
	});
}

async function getSettings() {
	const sync = await storageGet('sync', 'cc:settings');
	const local = await storageGet('local', 'cc:settings');
	return sync['cc:settings'] || local['cc:settings'] || structuredClone(DEFAULT_SETTINGS);
}

async function setSettings(next) {
	// Try sync first; fall back to local on quota errors.
	try {
		await storageSet('sync', { 'cc:settings': next });
	} catch {
		await storageSet('local', { 'cc:settings': next });
	}
}

// ---------------------------------------------------------------------------
// State cache — popup queries this even when no claude.ai tab is open.
// ---------------------------------------------------------------------------

const CACHE_KEY = 'cc:lastState';
const FIRED_KEY = 'cc:firedThresholds';

async function getCachedState() {
	const got = await storageGet('local', CACHE_KEY);
	return got[CACHE_KEY] || null;
}

async function setCachedState(state) {
	await storageSet('local', { [CACHE_KEY]: state });
}

async function getFired() {
	const got = await storageGet('local', FIRED_KEY);
	return got[FIRED_KEY] || { session: {}, weekly: {} };
}

async function setFired(fired) {
	await storageSet('local', { [FIRED_KEY]: fired });
}

// ---------------------------------------------------------------------------
// Alarms — schedule reset checkpoints and threshold revalidation.
// ---------------------------------------------------------------------------

const alarms = globalThis.browser?.alarms || globalThis.chrome?.alarms || null;
const notifications = globalThis.browser?.notifications || globalThis.chrome?.notifications || null;
const tabsApi = globalThis.browser?.tabs || globalThis.chrome?.tabs || null;
const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;

async function scheduleResetAlarms(snapshot) {
	if (!alarms?.create) return;
	const now = Date.now();
	try {
		if (snapshot?.sessionResetMs && snapshot.sessionResetMs > now) {
			alarms.create('cc:session-reset', { when: snapshot.sessionResetMs + 1000 });
		}
		if (snapshot?.weeklyResetMs && snapshot.weeklyResetMs > now) {
			alarms.create('cc:weekly-reset', { when: snapshot.weeklyResetMs + 1000 });
		}
		// Periodic threshold revalidation (every 5 min) — cheap and keeps notifications honest.
		alarms.create('cc:threshold-check', { periodInMinutes: 5 });
	} catch (e) {
		log('warn', 'scheduleResetAlarms failed', { error: e?.message });
	}
}

// ---------------------------------------------------------------------------
// Notifications — fire once per threshold per window.
// ---------------------------------------------------------------------------

function notify(id, title, message) {
	if (!notifications?.create) return;
	try {
		notifications.create(id, {
			type: 'basic',
			iconUrl: runtime?.getURL ? runtime.getURL('icons/icon128.png') : 'icons/icon128.png',
			title,
			message,
			priority: 1
		});
	} catch (e) {
		log('warn', 'notify failed', { error: e?.message });
	}
}

/**
 * Check usage against configured thresholds and fire notifications once each.
 * [EDGE] Uses (window, resetMs) as the fired-set key so a rollover resets state.
 */
async function checkThresholds(snapshot) {
	if (!snapshot) return;
	const settings = await getSettings();
	if (settings.notifications?.muted) return;
	const fired = await getFired();
	let changed = false;

	const evaluate = (windowKey, pct, resetMs, label) => {
		if ('number' !== typeof pct) return;
		const thresholds = settings.thresholds?.[windowKey] || [75, 90, 95];
		const resetKey = String(resetMs ?? 'none');
		fired[windowKey] = fired[windowKey] || {};
		fired[windowKey][resetKey] = fired[windowKey][resetKey] || {};
		for (const t of thresholds) {
			const enabledKey = `enabled${t}`;
			if (settings.notifications && false === settings.notifications[enabledKey]) continue;
			if (pct + 0.0001 < t) continue;
			if (fired[windowKey][resetKey][t]) continue;
			fired[windowKey][resetKey][t] = Date.now();
			changed = true;
			const tail = NOTIFICATION_TEMPLATES[t] || `is at ${t}%.`;
			notify(`cc:${windowKey}:${t}:${resetKey}`, `Claude Counter — ${label}`, `${label} ${tail}`);
		}
	};

	evaluate('session', snapshot.sessionPct, snapshot.sessionResetMs, 'Session');
	evaluate('weekly', snapshot.weeklyPct, snapshot.weeklyResetMs, 'Weekly');

	// [EDGE] Garbage-collect fired entries whose reset has passed (>1h grace).
	const now = Date.now();
	for (const wk of ['session', 'weekly']) {
		const entries = fired[wk] || {};
		for (const key of Object.keys(entries)) {
			const ms = Number(key);
			if (Number.isFinite(ms) && ms + 60 * 60 * 1000 < now) {
				delete entries[key];
				changed = true;
			}
		}
	}

	if (changed) await setFired(fired);
}

// ---------------------------------------------------------------------------
// Forecast (computed here so popup gets it without a content script).
// ---------------------------------------------------------------------------

/**
 * Linear time-to-cap forecast based on session/weekly progression.
 * [EDGE] If pct is at or above 100, returns 0. If no rate, returns null.
 */
function computeForecast(prev, curr) {
	if (!curr) return null;
	const result = { session: null, weekly: null, tokensPerHour: null, tokensPerTurn: null };

	const project = (prevPct, currPct, resetMs, prevTs, currTs) => {
		if ('number' !== typeof currPct || 'number' !== typeof resetMs) return null;
		if (currPct >= 100) return 0;
		if (!prev || 'number' !== typeof prevPct || !Number.isFinite(prevTs) || !Number.isFinite(currTs)) return null;
		const dtMs = Math.max(1, currTs - prevTs);
		const dPct = currPct - prevPct;
		if (dPct <= 0) return null; // idle or negative (rollover) — caller treats as "indefinite"
		const ratePctPerMs = dPct / dtMs;
		const remainingPct = Math.max(0, 100 - currPct);
		const etaMs = remainingPct / ratePctPerMs;
		// Cap ETA at reset boundary.
		const untilReset = Math.max(0, resetMs - Date.now());
		return Math.min(etaMs, untilReset);
	};

	result.session = project(prev?.sessionPct, curr.sessionPct, curr.sessionResetMs, prev?.ts, curr.ts);
	result.weekly = project(prev?.weeklyPct, curr.weeklyPct, curr.weeklyResetMs, prev?.ts, curr.ts);
	return result;
}

// ---------------------------------------------------------------------------
// Port management — popup connects for live updates.
// ---------------------------------------------------------------------------

const livePorts = new Set();

function broadcastState(state) {
	for (const port of livePorts) {
		try { port.postMessage({ kind: KIND.STATE_CHANGED, payload: state }); }
		catch { livePorts.delete(port); }
	}
}

if (runtime?.onConnect?.addListener) {
	runtime.onConnect.addListener((port) => {
		if (!port || port.name !== 'cc-popup') return;
		livePorts.add(port);
		// Send the current state immediately on connect.
		(async () => {
			const state = await getCachedState();
			try { port.postMessage({ kind: KIND.STATE_CHANGED, payload: state }); }
			catch { /* port closed */ }
		})();
		port.onDisconnect.addListener(() => livePorts.delete(port));
	});
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

if (runtime?.onMessage?.addListener) {
	runtime.onMessage.addListener((msg, sender, sendResponse) => {
		if (!msg || 'string' !== typeof msg.kind) return false;

		(async () => {
			switch (msg.kind) {
				case KIND.PING:
					sendResponse({ ok: true, ts: Date.now() });
					return;

				case KIND.SNAPSHOT_PUT: {
					const incoming = msg.payload || {};
					const prev = await getCachedState();
					const next = {
						ts: 'number' === typeof incoming.ts ? incoming.ts : Date.now(),
						sessionPct: numOrNull(incoming.sessionPct),
						weeklyPct: numOrNull(incoming.weeklyPct),
						sessionResetMs: numOrNull(incoming.sessionResetMs),
						weeklyResetMs: numOrNull(incoming.weeklyResetMs),
						contextPct: numOrNull(incoming.contextPct),
						contextTokens: numOrNull(incoming.contextTokens),
						contextRemaining: numOrNull(incoming.contextRemaining),
						contextHealth: typeof incoming.contextHealth === 'string' ? incoming.contextHealth : null,
						model: typeof incoming.model === 'string' ? incoming.model : null,
						tabId: sender?.tab?.id ?? null,
						chatUrl: sender?.tab?.url || null
					};
					const forecast = computeForecast(prev?.snapshot ? prev.snapshot : prev, next);
					const state = {
						snapshot: next,
						forecast,
						staleSince: null,
						lastUpdatedMs: Date.now()
					};
					await setCachedState(state);
					await checkThresholds(next);
					await scheduleResetAlarms(next);
					broadcastState(state);
					sendResponse({ ok: true });
					return;
				}

				case KIND.STATE_GET: {
					const state = await getCachedState();
					sendResponse({ ok: true, state });
					return;
				}

				case KIND.SETTINGS_GET: {
					const settings = await getSettings();
					sendResponse({ ok: true, settings });
					return;
				}

				case KIND.SETTINGS_SET: {
					const next = msg.payload || {};
					await setSettings(next);
					// Notify all content scripts.
					if (tabsApi?.query) {
						try {
							const tabs = await new Promise((resolve) => {
								const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
								if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
							});
							for (const t of tabs) {
								try {
									tabsApi.sendMessage(t.id, { kind: KIND.SETTINGS_CHANGED, payload: next });
								} catch { /* tab unreachable */ }
							}
						} catch (e) {
							log('warn', 'tabs.query failed', { error: e?.message });
						}
					}
					sendResponse({ ok: true });
					return;
				}

				case KIND.WIPE_ALL: {
					// Clear chrome.storage; IndexedDB wipe is initiated from a context that has DB access.
					try {
						await storageSet('local', { [CACHE_KEY]: null, [FIRED_KEY]: null });
						await storageSet('sync', { 'cc:settings': structuredClone(DEFAULT_SETTINGS) });
					} catch (e) {
						log('warn', 'wipe failed', { error: e?.message });
					}
					sendResponse({ ok: true });
					return;
				}

				case KIND.FOCUS_CHAT: {
					if (!tabsApi) { sendResponse({ ok: false }); return; }
					try {
						const tabs = await new Promise((resolve) => {
							const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
							if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
						});
						const target = tabs[0];
						if (target) {
							tabsApi.update(target.id, { active: true });
							if (target.windowId !== undefined) {
								const windows = globalThis.browser?.windows || globalThis.chrome?.windows;
								windows?.update?.(target.windowId, { focused: true });
							}
						}
					} catch (e) {
						log('warn', 'focus.chat failed', { error: e?.message });
					}
					sendResponse({ ok: true });
					return;
				}

				case KIND.SCROLL_TO_MESSAGE: {
					if (!tabsApi) { sendResponse({ ok: false }); return; }
					try {
						const tabs = await new Promise((resolve) => {
							const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true }, (t) => resolve(t || []));
							if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
						});
						const target = tabs[0] || (await new Promise((resolve) => {
							const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
							if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
						}))[0];
						if (target) {
							tabsApi.sendMessage(target.id, { kind: KIND.SCROLL_TO_MESSAGE, payload: msg.payload });
							tabsApi.update(target.id, { active: true });
						}
					} catch (e) {
						log('warn', 'scroll.to.message failed', { error: e?.message });
					}
					sendResponse({ ok: true });
					return;
				}

				default:
					sendResponse({ ok: false, error: `unknown kind: ${msg.kind}` });
			}
		})().catch((e) => {
			log('error', 'onMessage handler threw', { kind: msg.kind, error: e?.message });
			try { sendResponse({ ok: false, error: e?.message || String(e) }); } catch { /* port closed */ }
		});

		return true; // async response
	});
}

function numOrNull(v) {
	return 'number' === typeof v && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Alarm handler
// ---------------------------------------------------------------------------

if (alarms?.onAlarm?.addListener) {
	alarms.onAlarm.addListener(async (alarm) => {
		if (!alarm?.name) return;
		log('info', 'alarm fired', { name: alarm.name });
		if (alarm.name === 'cc:threshold-check') {
			const state = await getCachedState();
			if (state?.snapshot) await checkThresholds(state.snapshot);
			return;
		}
		if (alarm.name === 'cc:session-reset' || alarm.name === 'cc:weekly-reset') {
			// Mark cache as stale; a content-script tick will refresh it.
			const state = await getCachedState();
			if (state) {
				state.staleSince = Date.now();
				await setCachedState(state);
				broadcastState(state);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Notification click — focus claude.ai or open popup.
// ---------------------------------------------------------------------------

if (notifications?.onClicked?.addListener) {
	notifications.onClicked.addListener(async () => {
		if (!tabsApi) return;
		try {
			const tabs = await new Promise((resolve) => {
				const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
			});
			if (tabs[0]) {
				tabsApi.update(tabs[0].id, { active: true });
				const windows = globalThis.browser?.windows || globalThis.chrome?.windows;
				if (tabs[0].windowId !== undefined) windows?.update?.(tabs[0].windowId, { focused: true });
			} else if (tabsApi.create) {
				tabsApi.create({ url: 'https://claude.ai/' });
			}
		} catch (e) {
			log('warn', 'notification click failed', { error: e?.message });
		}
	});
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

if (runtime?.onInstalled?.addListener) {
	runtime.onInstalled.addListener(async () => {
		log('info', 'installed');
		const existing = await getSettings();
		if (!existing || 'object' !== typeof existing || !existing.display) {
			await setSettings(structuredClone(DEFAULT_SETTINGS));
		}
	});
}

if (runtime?.onStartup?.addListener) {
	runtime.onStartup.addListener(() => log('info', 'startup'));
}
