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
	FORECAST_GET: 'forecast.get',
	// Phase 2
	LIVE_STATE_GET: 'live.state.get',
	ROLLUPS_GET: 'rollups.get',
	STORAGE_ESTIMATE: 'storage.estimate',
	OPEN_FORENSICS: 'open.forensics',
	MESSAGES_FOR_CONVERSATION: 'messages.forConversation',
	// Phase 3 — pins & re-injection
	PIN_HOTKEY: 'pin.fromHotkey',
	PIN_CONTEXT_MENU: 'pin.fromContextMenu',
	COMPOSER_INSERT: 'composer.insert'
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
		hotkey: 'Ctrl+Shift+P',         // displayed; the real binding lives in manifest commands
		autoTagChatTitle: true,
		autoTagDate: true,
		autoTagModel: true,
		defaultTags: [],
		exportFormat: 'flat'             // 'flat' | 'by-project'
	},
	history: {
		// [CONFIG] Days of daily_rollups to retain. PRD F8 range 30-365.
		retentionDays: 90
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

/**
 * Send to a tab's content script and swallow the "Receiving end does not exist"
 * error that fires when the tab is still loading or doesn't host claude.ai.
 * [EDGE] Must read `runtime.lastError` inside the callback to consume it.
 */
function sendToTab(tabId, kind, payload) {
	if (!tabsApi?.sendMessage || 'number' !== typeof tabId) return;
	try {
		const cb = () => { void runtime?.lastError; };
		const ret = tabsApi.sendMessage(tabId, { kind, payload }, cb);
		if (ret && typeof ret.then === 'function') ret.then(() => {}, () => {});
	} catch { /* tab unreachable */ }
}

/**
 * Find the most relevant claude.ai tab (active in current window first, then
 * any) and forward a message kind to it. Used by chrome.commands and the
 * context menu so the content script can act on the user's current chat.
 */
async function relayToActiveClaudeTab(kind, payload) {
	if (!tabsApi?.query) return false;
	const queryActive = await new Promise((resolve) => {
		try {
			const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true, currentWindow: true }, (t) => resolve(t || []));
			if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
		} catch { resolve([]); }
	});
	let target = queryActive[0];
	if (!target) {
		const queryAny = await new Promise((resolve) => {
			try {
				const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
				if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
			} catch { resolve([]); }
		});
		target = queryAny[0];
	}
	if (!target) return false;
	sendToTab(target.id, kind, payload);
	return true;
}

// ---------------------------------------------------------------------------
// IndexedDB access from the SW context. Mirrors `utils/db.js` schema names —
// the SW only reads/writes via promisified requests, never creates stores.
// ---------------------------------------------------------------------------

const DB_NAME = 'claude_counter_v1';
const DB_VERSION = 2;
const SW_STORES = Object.freeze({
	SNAPSHOTS: 'snapshots',
	MESSAGES_META: 'messages_meta',
	DAILY_ROLLUPS: 'daily_rollups',
	SETTINGS: 'settings'
});

let dbPromise = null;
function openSwDb() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				// SW only opens — content-script utils/db.js owns the schema. If we
				// land here we're a clean install with no content script yet; create
				// the minimum stores the SW needs so the rollup alarm doesn't fail.
				const db = req.result;
				const ensureStore = (name, opts) => {
					if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
				};
				ensureStore(SW_STORES.SNAPSHOTS, { keyPath: 'id', autoIncrement: true });
				ensureStore(SW_STORES.MESSAGES_META, { keyPath: 'id' });
				ensureStore(SW_STORES.DAILY_ROLLUPS, { keyPath: 'date' });
				ensureStore(SW_STORES.SETTINGS, { keyPath: 'key' });
			};
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => { try { db.close(); } catch { /* noop */ } dbPromise = null; };
				resolve(db);
			};
			req.onerror = () => { dbPromise = null; reject(req.error || new Error('SW DB open failed')); };
			req.onblocked = () => log('warn', 'SW DB open blocked');
		} catch (e) {
			dbPromise = null;
			reject(e);
		}
	});
	return dbPromise;
}

function swPromisify(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IDB request failed'));
	});
}

async function swGetAll(store) {
	try {
		const db = await openSwDb();
		if (!db.objectStoreNames.contains(store)) return [];
		const tx = db.transaction(store, 'readonly');
		return await swPromisify(tx.objectStore(store).getAll());
	} catch (e) {
		log('warn', 'swGetAll failed', { store, error: e?.message });
		return [];
	}
}

async function swPut(store, value) {
	try {
		const db = await openSwDb();
		if (!db.objectStoreNames.contains(store)) return;
		const tx = db.transaction(store, 'readwrite');
		await swPromisify(tx.objectStore(store).put(value));
		await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve(); });
	} catch (e) {
		log('warn', 'swPut failed', { store, error: e?.message });
	}
}

function localDateKey(tsMs) {
	const d = new Date(tsMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function localDateBounds(dateKey) {
	const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10));
	const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
	const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
	return { start, end };
}

/**
 * Aggregate a single day's raw rows into a daily_rollups row.
 * Idempotent — re-running for the same date overwrites the existing row.
 */
async function buildDailyRollup(dateKey) {
	const bounds = localDateBounds(dateKey);
	if (!bounds) return null;
	const { start, end } = bounds;

	const snapshots = await swGetAll(SW_STORES.SNAPSHOTS);
	const messages = await swGetAll(SW_STORES.MESSAGES_META);

	let peakSessionPct = null;
	let peakWeeklyPct = null;
	let snapshotCount = 0;
	for (const s of snapshots) {
		if ('number' !== typeof s.ts || s.ts < start || s.ts > end) continue;
		snapshotCount++;
		if ('number' === typeof s.sessionPct && (peakSessionPct === null || s.sessionPct > peakSessionPct)) {
			peakSessionPct = s.sessionPct;
		}
		if ('number' === typeof s.weeklyPct && (peakWeeklyPct === null || s.weeklyPct > peakWeeklyPct)) {
			peakWeeklyPct = s.weeklyPct;
		}
	}

	let totalTokens = 0;
	let messageCount = 0;
	const modelBreakdown = { opus: 0, sonnet: 0, haiku: 0, other: 0, unknown: 0 };
	for (const m of messages) {
		if ('number' !== typeof m.createdAt || m.createdAt < start || m.createdAt > end) continue;
		messageCount++;
		const t = 'number' === typeof m.tokens ? m.tokens : 0;
		totalTokens += t;
		const bucket = ['opus', 'sonnet', 'haiku'].includes(m.model)
			? m.model
			: (m.model === 'unknown' ? 'unknown' : 'other');
		modelBreakdown[bucket] = (modelBreakdown[bucket] || 0) + t;
	}

	return {
		date: dateKey,
		peakSessionPct,
		peakWeeklyPct,
		totalTokens,
		messageCount,
		modelBreakdown,
		snapshotCount,
		rolledUpAt: Date.now()
	};
}

const LAST_ROLLUP_KEY = 'cc:lastRollupDate';

async function getLastRollupDate() {
	const got = await storageGet('local', LAST_ROLLUP_KEY);
	return got[LAST_ROLLUP_KEY] || null;
}

async function setLastRollupDate(dateKey) {
	await storageSet('local', { [LAST_ROLLUP_KEY]: dateKey });
}

/**
 * Schedule a daily-rollup alarm at the next local 04:00. The alarm fires once,
 * then a follow-up 24h period repeats it. On wake we also catch-up any missed
 * days back to whatever `cc:lastRollupDate` reports.
 */
function scheduleDailyRollupAlarm() {
	if (!alarms?.create) return;
	const now = new Date();
	const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0, 0);
	if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
	try {
		alarms.create('cc:daily-rollup', { when: target.getTime(), periodInMinutes: 1440 });
	} catch (e) {
		log('warn', 'daily rollup alarm create failed', { error: e?.message });
	}
}

/**
 * Run rollups for every missing day since `cc:lastRollupDate`, plus yesterday.
 * Also prunes raw rows beyond 7 days and rollups beyond retention setting.
 */
async function runRollupCatchup() {
	const yesterdayMs = Date.now() - 86_400_000;
	const targetDateKey = localDateKey(yesterdayMs);

	const lastDate = await getLastRollupDate();
	const cursor = new Date();
	cursor.setDate(cursor.getDate() - 1);

	const datesToBuild = [];
	if (!lastDate) {
		datesToBuild.push(targetDateKey);
	} else {
		// Walk forward from the day after lastDate up to and including targetDateKey.
		const [ly, lm, ld] = lastDate.split('-').map((n) => parseInt(n, 10));
		const walker = new Date(ly, lm - 1, ld);
		walker.setDate(walker.getDate() + 1);
		while (walker.getTime() <= yesterdayMs) {
			datesToBuild.push(localDateKey(walker.getTime()));
			walker.setDate(walker.getDate() + 1);
			// [EDGE] Safety stop — never build more than 365 retroactive rollups.
			if (datesToBuild.length > 365) break;
		}
	}

	for (const dateKey of datesToBuild) {
		try {
			const row = await buildDailyRollup(dateKey);
			if (row) await swPut(SW_STORES.DAILY_ROLLUPS, row);
		} catch (e) {
			log('warn', 'rollup build failed', { date: dateKey, error: e?.message });
		}
	}

	if (datesToBuild.length > 0) {
		await setLastRollupDate(datesToBuild[datesToBuild.length - 1]);
	}

	// Prune snapshots + messages older than 7d (raw retention)
	await pruneRawOlderThan(7 * 86_400_000);

	// Prune daily rollups beyond user retention.
	const settings = await getSettings();
	const retentionDays = numOrNull(settings?.history?.retentionDays) ?? 90;
	await pruneRollupsOlderThanDays(retentionDays);
}

async function pruneRawOlderThan(maxAgeMs) {
	const cutoff = Date.now() - maxAgeMs;
	try {
		const db = await openSwDb();
		for (const store of [SW_STORES.SNAPSHOTS, SW_STORES.MESSAGES_META]) {
			if (!db.objectStoreNames.contains(store)) continue;
			const tx = db.transaction(store, 'readwrite');
			const oStore = tx.objectStore(store);
			await new Promise((resolve) => {
				const req = oStore.openCursor();
				req.onsuccess = () => {
					const cur = req.result;
					if (!cur) { resolve(); return; }
					const ts = cur.value?.ts ?? cur.value?.createdAt;
					if ('number' === typeof ts && ts < cutoff) {
						try { cur.delete(); } catch { /* noop */ }
					}
					cur.continue();
				};
				req.onerror = () => resolve();
			});
			await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve(); });
		}
	} catch (e) {
		log('warn', 'pruneRawOlderThan failed', { error: e?.message });
	}
}

async function pruneRollupsOlderThanDays(days) {
	if ('number' !== typeof days || days <= 0) return;
	const cutoff = localDateKey(Date.now() - days * 86_400_000);
	try {
		const db = await openSwDb();
		if (!db.objectStoreNames.contains(SW_STORES.DAILY_ROLLUPS)) return;
		const tx = db.transaction(SW_STORES.DAILY_ROLLUPS, 'readwrite');
		const oStore = tx.objectStore(SW_STORES.DAILY_ROLLUPS);
		await new Promise((resolve) => {
			const req = oStore.openCursor();
			req.onsuccess = () => {
				const cur = req.result;
				if (!cur) { resolve(); return; }
				if (typeof cur.value?.date === 'string' && cur.value.date < cutoff) {
					try { cur.delete(); } catch { /* noop */ }
				}
				cur.continue();
			};
			req.onerror = () => resolve();
		});
		await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve(); });
	} catch (e) {
		log('warn', 'pruneRollupsOlderThanDays failed', { error: e?.message });
	}
}

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
					// Notify all content scripts. Each send needs a callback so the
					// unchecked-lastError warning isn't emitted when a tab hasn't
					// loaded the content script yet.
					if (tabsApi?.query) {
						try {
							const tabs = await new Promise((resolve) => {
								const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
								if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
							});
							for (const t of tabs) {
								sendToTab(t.id, KIND.SETTINGS_CHANGED, next);
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

				case KIND.ROLLUPS_GET: {
					const days = numOrNull(msg.payload?.days) ?? 7;
					const sinceTs = Date.now() - Math.min(365, Math.max(1, days)) * 86_400_000;
					const sinceKey = localDateKey(sinceTs);
					const all = await swGetAll(SW_STORES.DAILY_ROLLUPS);
					const filtered = all.filter((r) => typeof r.date === 'string' && r.date >= sinceKey);
					filtered.sort((a, b) => a.date.localeCompare(b.date));
					sendResponse({ ok: true, rollups: filtered });
					return;
				}

				case KIND.STORAGE_ESTIMATE: {
					let estimate = null;
					try {
						if (globalThis.navigator?.storage?.estimate) {
							estimate = await navigator.storage.estimate();
						}
					} catch { /* noop */ }
					sendResponse({ ok: true, estimate });
					return;
				}

				case KIND.MESSAGES_FOR_CONVERSATION: {
					const conversationId = typeof msg.payload?.conversationId === 'string'
						? msg.payload.conversationId : null;
					if (!conversationId) { sendResponse({ ok: false, error: 'missing conversationId' }); return; }
					const all = await swGetAll(SW_STORES.MESSAGES_META);
					const rows = all
						.filter((m) => m.conversationId === conversationId)
						.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
					sendResponse({ ok: true, messages: rows });
					return;
				}

				case KIND.COMPOSER_INSERT: {
					if (!tabsApi?.query) { sendResponse({ ok: false }); return; }
					const text = msg.payload?.text || '';
					if ('string' !== typeof text || 0 === text.length) {
						sendResponse({ ok: false, error: 'empty text' });
						return;
					}
					try {
						const tabs = await new Promise((resolve) => {
							const ret = tabsApi.query({ url: 'https://claude.ai/*', active: true, currentWindow: true }, (t) => resolve(t || []));
							if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
						});
						let target = tabs[0];
						if (!target) {
							const any = await new Promise((resolve) => {
								const ret = tabsApi.query({ url: 'https://claude.ai/*' }, (t) => resolve(t || []));
								if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve([]));
							});
							target = any[0];
						}
						if (!target) { sendResponse({ ok: false, error: 'no claude.ai tab' }); return; }
						// Bring the tab forward so the user sees the insertion.
						tabsApi.update(target.id, { active: true });
						const windows = globalThis.browser?.windows || globalThis.chrome?.windows;
						if (target.windowId !== undefined) windows?.update?.(target.windowId, { focused: true });
						sendToTab(target.id, KIND.COMPOSER_INSERT, { text });
						sendResponse({ ok: true });
					} catch (e) {
						sendResponse({ ok: false, error: e?.message });
					}
					return;
				}

				case KIND.OPEN_FORENSICS: {
					if (!tabsApi?.create || !runtime?.getURL) { sendResponse({ ok: false }); return; }
					const conversationId = typeof msg.payload?.conversationId === 'string'
						? msg.payload.conversationId : '';
					const url = runtime.getURL(`src/forensics/index.html${conversationId ? `?chatId=${encodeURIComponent(conversationId)}` : ''}`);
					try { tabsApi.create({ url }); sendResponse({ ok: true }); }
					catch (e) { sendResponse({ ok: false, error: e?.message }); }
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
							sendToTab(target.id, KIND.SCROLL_TO_MESSAGE, msg.payload);
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
		if (alarm.name === 'cc:daily-rollup') {
			await runRollupCatchup();
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
		scheduleDailyRollupAlarm();
		// Run catch-up immediately so users see history without waiting overnight.
		runRollupCatchup().catch((e) => log('warn', 'initial catchup failed', { error: e?.message }));
		setupContextMenus();
	});
}

// ---------------------------------------------------------------------------
// Phase 3 — chrome.commands + contextMenus
// ---------------------------------------------------------------------------

const commands = globalThis.browser?.commands || globalThis.chrome?.commands || null;
const contextMenus = globalThis.browser?.contextMenus || globalThis.chrome?.contextMenus || null;

if (commands?.onCommand?.addListener) {
	commands.onCommand.addListener(async (name) => {
		if (name !== 'pin-focused-message') return;
		await relayToActiveClaudeTab(KIND.PIN_HOTKEY, {});
	});
}

function setupContextMenus() {
	if (!contextMenus?.create) return;
	try {
		contextMenus.removeAll(() => {
			try {
				contextMenus.create({
					id: 'cc-pin-message',
					title: 'Pin this message to Claude Counter',
					contexts: ['page', 'selection', 'link'],
					documentUrlPatterns: ['https://claude.ai/*']
				}, () => { void runtime?.lastError; });
			} catch (e) { log('warn', 'contextMenus.create failed', { error: e?.message }); }
		});
	} catch (e) { log('warn', 'contextMenus.setup failed', { error: e?.message }); }
}

if (contextMenus?.onClicked?.addListener) {
	contextMenus.onClicked.addListener(async (info, tab) => {
		if (info?.menuItemId !== 'cc-pin-message') return;
		if (!tab?.id) { await relayToActiveClaudeTab(KIND.PIN_CONTEXT_MENU, {}); return; }
		sendToTab(tab.id, KIND.PIN_CONTEXT_MENU, {});
	});
}

if (runtime?.onStartup?.addListener) {
	runtime.onStartup.addListener(() => {
		log('info', 'startup');
		scheduleDailyRollupAlarm();
		runRollupCatchup().catch((e) => log('warn', 'startup catchup failed', { error: e?.message }));
		setupContextMenus();
	});
}
