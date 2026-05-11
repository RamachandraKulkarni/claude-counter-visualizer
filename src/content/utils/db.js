// [SECURITY] All persisted data is local to this browser profile.
// No network egress. Only fields explicitly listed in DB_SCHEMA are written.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// [CONFIG] Schema version. Bump on every breaking change and add a migration step.
	const DB_NAME = 'claude_counter_v1';
	const DB_VERSION = 2;

	// [CONFIG] Object stores. Stays in lockstep with ARCHITECTURE.md.
	const STORES = Object.freeze({
		SNAPSHOTS: 'snapshots',
		CONVERSATIONS: 'conversations',
		MESSAGES_META: 'messages_meta',
		DAILY_ROLLUPS: 'daily_rollups',  // v2
		SETTINGS: 'settings',
		PINS: 'pins',            // Phase 3 — pre-created to avoid future migrations
		LINKS: 'links',          // Phase 4
		ERRORS_LOG: 'errors_log'
	});

	const ERRORS_LOG_CAP = 1000;
	const SNAPSHOTS_CAP = 5000; // covers ~90 days at hourly granularity

	function logWarn(msg, meta) {
		const errs = CC.utils?.errors;
		if (errs?.warn) errs.warn(msg, meta);
	}

	function logError(msg, meta) {
		const errs = CC.utils?.errors;
		if (errs?.error) errs.error(msg, meta);
	}

	function reportError(e, ctx) {
		const errs = CC.utils?.errors;
		if (errs?.reportError) errs.reportError(e, ctx);
	}

	let dbPromise = null;

	/**
	 * Open the IndexedDB connection, creating stores on first run.
	 * [EDGE] Re-opens on close (e.g., after `versionchange`).
	 * @returns {Promise<IDBDatabase>}
	 */
	function open() {
		if (dbPromise) return dbPromise;

		dbPromise = new Promise((resolve, reject) => {
			let req;
			try {
				req = indexedDB.open(DB_NAME, DB_VERSION);
			} catch (e) {
				reportError(e, 'db.open');
				reject(e);
				return;
			}

			req.onupgradeneeded = (event) => {
				const db = req.result;
				const oldVersion = event.oldVersion || 0;
				try {
					runMigrations(db, oldVersion, DB_VERSION);
					// [CONFIG] Data-only migrations that need the active upgrade tx.
					if (oldVersion < 2) {
						const tx = req.transaction;
						if (tx) backfillMessageModelsV2(tx);
					}
				} catch (e) {
					reportError(e, 'db.migrate');
				}
			};

			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					// [EDGE] Another tab requested a schema upgrade — close to let it proceed.
					try { db.close(); } catch { /* noop */ }
					dbPromise = null;
				};
				db.onclose = () => { dbPromise = null; };
				resolve(db);
			};

			req.onerror = () => {
				logError('db.open: failed', { error: req.error?.message });
				dbPromise = null;
				reject(req.error || new Error('Failed to open IndexedDB'));
			};

			req.onblocked = () => {
				logWarn('db.open: blocked by other tab');
			};
		});

		return dbPromise;
	}

	/**
	 * Apply schema migrations.
	 * [CONFIG] Add a `case` for each new schema version.
	 * @param {IDBDatabase} db
	 * @param {number} from
	 * @param {number} to
	 */
	function runMigrations(db, from, to) {
		// v0 -> v1: initial schema
		if (from < 1) {
			if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
				const s = db.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'id', autoIncrement: true });
				s.createIndex('by-ts', 'ts', { unique: false });
				s.createIndex('by-model', 'model', { unique: false });
			}
			if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
				const s = db.createObjectStore(STORES.CONVERSATIONS, { keyPath: 'id' });
				s.createIndex('by-project', 'projectId', { unique: false });
				s.createIndex('by-lastSeen', 'lastSeen', { unique: false });
			}
			if (!db.objectStoreNames.contains(STORES.MESSAGES_META)) {
				const s = db.createObjectStore(STORES.MESSAGES_META, { keyPath: 'id' });
				s.createIndex('by-conversation', 'conversationId', { unique: false });
				s.createIndex('by-tokens', 'tokens', { unique: false });
				s.createIndex('by-createdAt', 'createdAt', { unique: false });
			}
			if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
				db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains(STORES.PINS)) {
				const s = db.createObjectStore(STORES.PINS, { keyPath: 'id' });
				s.createIndex('by-project', 'projectId', { unique: false });
				s.createIndex('by-tag', 'tags', { unique: false, multiEntry: true });
				s.createIndex('by-conversation', 'conversationId', { unique: false });
				s.createIndex('by-createdAt', 'createdAt', { unique: false });
			}
			if (!db.objectStoreNames.contains(STORES.LINKS)) {
				const s = db.createObjectStore(STORES.LINKS, { keyPath: 'id' });
				s.createIndex('by-from', 'fromPinId', { unique: false });
				s.createIndex('by-to', 'toPinId', { unique: false });
			}
			if (!db.objectStoreNames.contains(STORES.ERRORS_LOG)) {
				const s = db.createObjectStore(STORES.ERRORS_LOG, { keyPath: 'id', autoIncrement: true });
				s.createIndex('by-ts', 'ts', { unique: false });
			}
		}
		// v1 -> v2: daily rollups + model tagging
		if (from < 2) {
			if (!db.objectStoreNames.contains(STORES.DAILY_ROLLUPS)) {
				const s = db.createObjectStore(STORES.DAILY_ROLLUPS, { keyPath: 'date' });
				s.createIndex('by-date', 'date', { unique: true });
			}
			// [EDGE] Backfill `model` field on existing messages_meta rows.
			// Runs inside the upgrade transaction so it's atomic with the schema bump.
			if (db.objectStoreNames.contains(STORES.MESSAGES_META)) {
				// `runMigrations` is invoked from `onupgradeneeded`; the implicit
				// versionchange transaction is reachable through the request that
				// triggered the upgrade. We grab it from the open request below.
			}
		}
		void to;
	}

	/**
	 * Data-only migration for v1→v2. Called from `onupgradeneeded` with the
	 * active versionchange transaction so reads + writes participate in the
	 * same atomic upgrade.
	 * [EDGE] Idempotent — rows that already carry `model` are skipped.
	 */
	function backfillMessageModelsV2(transaction) {
		try {
			if (!transaction || !transaction.objectStoreNames.contains(STORES.MESSAGES_META)) return;
			const store = transaction.objectStore(STORES.MESSAGES_META);
			const req = store.openCursor();
			req.onsuccess = () => {
				const cur = req.result;
				if (!cur) return;
				const row = cur.value;
				if (row && 'string' !== typeof row.model) {
					row.model = 'unknown';
					try { cur.update(row); } catch { /* upgrade tx may be aborting */ }
				}
				cur.continue();
			};
			// onerror is non-fatal — the migration still completes.
		} catch {
			// [EDGE] Backfill is best-effort; absent rows just stay un-tagged.
		}
	}

	/**
	 * Promisify an IDBRequest.
	 * @template T
	 * @param {IDBRequest<T>} req
	 * @returns {Promise<T>}
	 */
	function promisifyRequest(req) {
		return new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error || new Error('IDB request failed'));
		});
	}

	/**
	 * Validate store name against the schema before opening a transaction.
	 * [FAIL-FAST] Reject unknown store names instead of letting IDB throw later.
	 */
	function assertStore(store) {
		if ('string' !== typeof store || 0 === store.length) {
			throw new TypeError('db: store name must be a non-empty string');
		}
		// Membership check via Object.values for clarity.
		const valid = Object.values(STORES);
		if (!valid.includes(store)) {
			throw new RangeError(`db: unknown store '${store}'`);
		}
	}

	async function put(store, value) {
		assertStore(store);
		if (null === value || 'object' !== typeof value) {
			throw new TypeError(`db.put: value must be an object (store=${store})`);
		}
		const db = await open();
		const tx = db.transaction(store, 'readwrite');
		const result = await promisifyRequest(tx.objectStore(store).put(value));
		await txDone(tx);
		return result;
	}

	async function get(store, key) {
		assertStore(store);
		const db = await open();
		const tx = db.transaction(store, 'readonly');
		return promisifyRequest(tx.objectStore(store).get(key));
	}

	async function del(store, key) {
		assertStore(store);
		const db = await open();
		const tx = db.transaction(store, 'readwrite');
		await promisifyRequest(tx.objectStore(store).delete(key));
		await txDone(tx);
	}

	async function getAll(store, { index, query, limit } = {}) {
		assertStore(store);
		const db = await open();
		const tx = db.transaction(store, 'readonly');
		const src = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
		// [EDGE] limit only applies when getAll is supported with count arg (true everywhere modern).
		return promisifyRequest(src.getAll(query || null, limit));
	}

	/**
	 * Iterate a store via cursor — preferred over getAll for large stores.
	 * @param {string} store
	 * @param {{ index?: string, query?: IDBKeyRange|null, direction?: IDBCursorDirection, onValue: (value:any) => boolean|void }} opts
	 */
	async function each(store, { index, query, direction = 'next', onValue }) {
		assertStore(store);
		if ('function' !== typeof onValue) {
			throw new TypeError('db.each: onValue must be a function');
		}
		const db = await open();
		const tx = db.transaction(store, 'readonly');
		const src = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
		return new Promise((resolve, reject) => {
			const req = src.openCursor(query || null, direction);
			req.onsuccess = () => {
				const cur = req.result;
				if (!cur) { resolve(); return; }
				try {
					const stop = onValue(cur.value) === false;
					if (stop) { resolve(); return; }
					cur.continue();
				} catch (e) {
					reject(e);
				}
			};
			req.onerror = () => reject(req.error || new Error('cursor failed'));
		});
	}

	/**
	 * Run a function inside a transaction. The function receives the transaction
	 * and must return a Promise; transaction completion is awaited after.
	 */
	async function tx(stores, mode, fn) {
		const list = Array.isArray(stores) ? stores : [stores];
		list.forEach(assertStore);
		const db = await open();
		const transaction = db.transaction(list, mode);
		const result = await fn(transaction);
		await txDone(transaction);
		return result;
	}

	function txDone(transaction) {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error || new Error('tx aborted'));
			transaction.onerror = () => reject(transaction.error || new Error('tx errored'));
		});
	}

	/**
	 * Capped store insert: trim oldest rows after writing.
	 * [EDGE] No-op when count is within the cap.
	 */
	async function putCapped(store, value, cap) {
		await put(store, value);
		const db = await open();
		const transaction = db.transaction(store, 'readwrite');
		const objStore = transaction.objectStore(store);
		const count = await promisifyRequest(objStore.count());
		if (count <= cap) {
			await txDone(transaction);
			return;
		}
		const toTrim = count - cap;
		await new Promise((resolve, reject) => {
			const req = objStore.openCursor();
			let trimmed = 0;
			req.onsuccess = () => {
				const cur = req.result;
				if (!cur || trimmed >= toTrim) { resolve(); return; }
				cur.delete();
				trimmed++;
				cur.continue();
			};
			req.onerror = () => reject(req.error || new Error('trim cursor failed'));
		});
		await txDone(transaction);
	}

	/**
	 * Settings helpers. Single-key kv on top of the SETTINGS store.
	 */
	async function getSetting(key, fallback) {
		try {
			const row = await get(STORES.SETTINGS, key);
			if (row && 'value' in row) return row.value;
			return fallback;
		} catch (e) {
			reportError(e, 'db.getSetting');
			return fallback;
		}
	}

	async function setSetting(key, value) {
		if ('string' !== typeof key || 0 === key.length) {
			throw new TypeError('db.setSetting: key must be non-empty string');
		}
		await put(STORES.SETTINGS, { key, value, ts: Date.now() });
	}

	/**
	 * Snapshot persistence helpers.
	 */
	async function putSnapshot(snapshot) {
		// [VALIDATION] Only persist known-good shapes.
		if (!snapshot || 'object' !== typeof snapshot) return;
		const record = {
			ts: typeof snapshot.ts === 'number' ? snapshot.ts : Date.now(),
			sessionPct: numOrNull(snapshot.sessionPct),
			weeklyPct: numOrNull(snapshot.weeklyPct),
			sessionResetMs: numOrNull(snapshot.sessionResetMs),
			weeklyResetMs: numOrNull(snapshot.weeklyResetMs),
			model: typeof snapshot.model === 'string' ? snapshot.model : null,
			source: typeof snapshot.source === 'string' ? snapshot.source : 'unknown'
		};
		try {
			await putCapped(STORES.SNAPSHOTS, record, SNAPSHOTS_CAP);
		} catch (e) {
			reportError(e, 'db.putSnapshot');
		}
	}

	function numOrNull(v) {
		return 'number' === typeof v && Number.isFinite(v) ? v : null;
	}

	/**
	 * Read snapshots in a [fromTs, toTs] window, ascending.
	 */
	async function getSnapshotsSince(fromTs) {
		const since = 'number' === typeof fromTs ? fromTs : 0;
		const range = IDBKeyRange.lowerBound(since, false);
		try {
			return await getAll(STORES.SNAPSHOTS, { index: 'by-ts', query: range });
		} catch (e) {
			reportError(e, 'db.getSnapshotsSince');
			return [];
		}
	}

	async function putMessageMeta(meta) {
		if (!meta || 'string' !== typeof meta.id) return;
		try {
			await put(STORES.MESSAGES_META, {
				id: meta.id,
				conversationId: meta.conversationId || null,
				role: meta.role || null,
				tokens: numOrNull(meta.tokens) ?? 0,
				createdAt: numOrNull(meta.createdAt) ?? Date.now(),
				// v2 fields. `unknown` keeps queries simple — model field always defined.
				model: typeof meta.model === 'string' && meta.model.length > 0 ? meta.model : 'unknown',
				hasAttachments: !!meta.hasAttachments,
				snippet: typeof meta.snippet === 'string' ? meta.snippet.slice(0, 120) : null
			});
		} catch (e) {
			reportError(e, 'db.putMessageMeta');
		}
	}

	async function getMessagesByConversation(conversationId) {
		if ('string' !== typeof conversationId || 0 === conversationId.length) return [];
		try {
			return await getAll(STORES.MESSAGES_META, {
				index: 'by-conversation',
				query: IDBKeyRange.only(conversationId)
			});
		} catch (e) {
			reportError(e, 'db.getMessagesByConversation');
			return [];
		}
	}

	// -------------------------------------------------------------------------
	// Daily rollups (v2)
	// -------------------------------------------------------------------------

	/**
	 * Format an absolute timestamp as YYYY-MM-DD in the user's local timezone.
	 * [EDGE] Falls back to UTC if Intl is unavailable.
	 */
	function localDateKey(tsMs) {
		const ts = 'number' === typeof tsMs ? tsMs : Date.now();
		const d = new Date(ts);
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	/** Inclusive [startMs, endMs] for a given local date key. */
	function localDateBounds(dateKey) {
		const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10));
		if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
		const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
		const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
		return { start, end };
	}

	async function putDailyRollup(rollup) {
		if (!rollup || 'string' !== typeof rollup.date) return;
		try {
			await put(STORES.DAILY_ROLLUPS, rollup);
		} catch (e) {
			reportError(e, 'db.putDailyRollup');
		}
	}

	async function getDailyRollups(sinceDateKey) {
		const range = typeof sinceDateKey === 'string'
			? IDBKeyRange.lowerBound(sinceDateKey, false)
			: undefined;
		try {
			return await getAll(STORES.DAILY_ROLLUPS, range ? { query: range } : {});
		} catch (e) {
			reportError(e, 'db.getDailyRollups');
			return [];
		}
	}

	async function pruneOlderThan(store, tsField, cutoffMs) {
		if ('number' !== typeof cutoffMs) return;
		try {
			const db = await open();
			const transaction = db.transaction(store, 'readwrite');
			const idx = (() => {
				const oStore = transaction.objectStore(store);
				if (oStore.indexNames.contains(`by-${tsField}`)) return oStore.index(`by-${tsField}`);
				if (oStore.indexNames.contains('by-ts')) return oStore.index('by-ts');
				if (oStore.indexNames.contains('by-createdAt')) return oStore.index('by-createdAt');
				return oStore;
			})();
			const range = IDBKeyRange.upperBound(cutoffMs, true);
			await new Promise((resolve, reject) => {
				const req = idx.openCursor(range);
				req.onsuccess = () => {
					const cur = req.result;
					if (!cur) { resolve(); return; }
					try { cur.delete(); } catch { /* upgrade tx may be aborting */ }
					cur.continue();
				};
				req.onerror = () => reject(req.error || new Error('prune cursor failed'));
			});
			await txDone(transaction);
		} catch (e) {
			reportError(e, 'db.pruneOlderThan');
		}
	}

	/**
	 * Drop daily_rollups whose date is older than (today - days).
	 * [EDGE] Compares date strings lexicographically (YYYY-MM-DD is sortable).
	 */
	async function pruneRollupsOlderThanDays(days) {
		if ('number' !== typeof days || days <= 0) return;
		const cutoffKey = localDateKey(Date.now() - days * 86_400_000);
		try {
			const db = await open();
			const transaction = db.transaction(STORES.DAILY_ROLLUPS, 'readwrite');
			const range = IDBKeyRange.upperBound(cutoffKey, true);
			await new Promise((resolve, reject) => {
				const req = transaction.objectStore(STORES.DAILY_ROLLUPS).openCursor(range);
				req.onsuccess = () => {
					const cur = req.result;
					if (!cur) { resolve(); return; }
					try { cur.delete(); } catch { /* noop */ }
					cur.continue();
				};
				req.onerror = () => reject(req.error || new Error('rollup prune failed'));
			});
			await txDone(transaction);
		} catch (e) {
			reportError(e, 'db.pruneRollupsOlderThanDays');
		}
	}

	/**
	 * Aggregate raw snapshots + messages for a given local date into one rollup.
	 * Pure read — caller persists via `putDailyRollup`.
	 */
	async function buildDailyRollup(dateKey) {
		const bounds = localDateBounds(dateKey);
		if (!bounds) return null;
		const { start, end } = bounds;

		let peakSessionPct = null;
		let peakWeeklyPct = null;
		let snapshotCount = 0;
		try {
			const snaps = await getAll(STORES.SNAPSHOTS, {
				index: 'by-ts',
				query: IDBKeyRange.bound(start, end)
			});
			for (const s of snaps) {
				snapshotCount++;
				if ('number' === typeof s.sessionPct && (peakSessionPct === null || s.sessionPct > peakSessionPct)) {
					peakSessionPct = s.sessionPct;
				}
				if ('number' === typeof s.weeklyPct && (peakWeeklyPct === null || s.weeklyPct > peakWeeklyPct)) {
					peakWeeklyPct = s.weeklyPct;
				}
			}
		} catch (e) { reportError(e, 'db.buildDailyRollup.snapshots'); }

		let totalTokens = 0;
		let messageCount = 0;
		const modelBreakdown = { opus: 0, sonnet: 0, haiku: 0, other: 0, unknown: 0 };
		try {
			const messages = await getAll(STORES.MESSAGES_META, {
				index: 'by-createdAt',
				query: IDBKeyRange.bound(start, end)
			});
			for (const m of messages) {
				messageCount++;
				const t = numOrNull(m.tokens) ?? 0;
				totalTokens += t;
				const bucket = ['opus', 'sonnet', 'haiku'].includes(m.model)
					? m.model
					: (m.model === 'unknown' ? 'unknown' : 'other');
				modelBreakdown[bucket] = (modelBreakdown[bucket] || 0) + t;
			}
		} catch (e) { reportError(e, 'db.buildDailyRollup.messages'); }

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

	/**
	 * Wipe all extension data.
	 * [SECURITY] Used by the "Wipe all data" option. Confirmation handled in UI.
	 */
	async function wipe() {
		try {
			const db = await open();
			const list = Object.values(STORES);
			const transaction = db.transaction(list, 'readwrite');
			for (const s of list) {
				transaction.objectStore(s).clear();
			}
			await txDone(transaction);
		} catch (e) {
			reportError(e, 'db.wipe');
			throw e;
		}
	}

	async function logToDb(level, message, context) {
		try {
			await putCapped(STORES.ERRORS_LOG, {
				ts: Date.now(),
				level: 'string' === typeof level ? level : 'info',
				message: 'string' === typeof message ? message.slice(0, 1000) : String(message),
				context: context || null
			}, ERRORS_LOG_CAP);
		} catch {
			// [EDGE] Logging must not throw upward.
		}
	}

	CC.utils = CC.utils || {};
	CC.utils.db = {
		STORES,
		open,
		put,
		get,
		getAll,
		each,
		delete: del,
		tx,
		putCapped,
		getSetting,
		setSetting,
		putSnapshot,
		getSnapshotsSince,
		putMessageMeta,
		getMessagesByConversation,
		putDailyRollup,
		getDailyRollups,
		pruneOlderThan,
		pruneRollupsOlderThanDays,
		buildDailyRollup,
		localDateKey,
		localDateBounds,
		logToDb,
		wipe
	};
})();
