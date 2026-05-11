// [SECURITY] Pure computation. Produces only display strings and ETAs.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// [CONFIG] Window durations from PRD glossary.
	const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
	const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

	/**
	 * Compute window-aware time-to-cap.
	 *
	 * Given current %, the elapsed fraction of the window, and the rate at which
	 * the % has been increasing per ms (snapshot-derived), estimate when % will
	 * hit 100, capped at the window reset.
	 *
	 * [EDGE] Returns one of:
	 *   { state: 'ok', etaMs }
	 *   { state: 'idle' }                — no positive burn observed
	 *   { state: 'capped' }              — already at 100%
	 *   { state: 'reset_first', etaMs }  — will reset before capping
	 *   { state: 'need_data' }           — insufficient samples
	 */
	function timeToCap({ snapshots, windowKey, resetMs, currPct, windowDurationMs }) {
		if ('number' === typeof currPct && currPct >= 100) return { state: 'capped' };
		if (!Array.isArray(snapshots) || snapshots.length < 2 || 'number' !== typeof currPct) {
			return { state: 'need_data' };
		}
		if ('number' !== typeof resetMs) return { state: 'need_data' };

		// Filter snapshots within this window only (resetMs - duration ≤ ts ≤ now).
		const startMs = resetMs - (windowDurationMs || (windowKey === 'session' ? FIVE_HOUR_MS : SEVEN_DAY_MS));
		const withinWindow = snapshots
			.filter((s) => 'number' === typeof s.ts && s.ts >= startMs && s.ts <= Date.now())
			.filter((s) => 'number' === typeof s[`${windowKey}Pct`])
			.sort((a, b) => a.ts - b.ts);

		if (withinWindow.length < 2) return { state: 'need_data' };

		const first = withinWindow[0];
		const last = withinWindow[withinWindow.length - 1];
		const dt = Math.max(1, last.ts - first.ts);
		const dPct = last[`${windowKey}Pct`] - first[`${windowKey}Pct`];

		if (dPct <= 0) return { state: 'idle' };

		const ratePerMs = dPct / dt;
		const remainingPct = Math.max(0, 100 - currPct);
		const etaMs = remainingPct / ratePerMs;
		const untilReset = Math.max(0, resetMs - Date.now());

		if (etaMs > untilReset) {
			return { state: 'reset_first', etaMs: untilReset };
		}
		return { state: 'ok', etaMs };
	}

	/**
	 * Format ETA for human display.
	 * @param {number} ms
	 */
	function formatEta(ms) {
		if ('number' !== typeof ms || !Number.isFinite(ms) || ms < 0) return '-';
		const totalMin = Math.round(ms / 60000);
		if (totalMin < 60) return `${totalMin}m`;
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		if (h < 24) return `${h}h ${m}m`;
		const d = Math.floor(h / 24);
		const rh = h % 24;
		return `${d}d ${rh}h`;
	}

	function describe(result) {
		if (!result) return 'Need more data.';
		switch (result.state) {
			case 'ok': return `caps in ~${formatEta(result.etaMs)} at current pace`;
			case 'idle': return 'idle — no burn detected';
			case 'capped': return 'already capped';
			case 'reset_first': return `resets in ~${formatEta(result.etaMs)} before capping`;
			case 'need_data':
			default: return 'Need more data.';
		}
	}

	/**
	 * Convenience: compute both windows from a snapshots history + the latest snapshot.
	 */
	function computeFromSnapshots(snapshots, latest) {
		if (!latest) return { session: { state: 'need_data' }, weekly: { state: 'need_data' } };
		return {
			session: timeToCap({
				snapshots, windowKey: 'session',
				resetMs: latest.sessionResetMs, currPct: latest.sessionPct,
				windowDurationMs: FIVE_HOUR_MS
			}),
			weekly: timeToCap({
				snapshots, windowKey: 'weekly',
				resetMs: latest.weeklyResetMs, currPct: latest.weeklyPct,
				windowDurationMs: SEVEN_DAY_MS
			})
		};
	}

	CC.forecast = { timeToCap, formatEta, describe, computeFromSnapshots, FIVE_HOUR_MS, SEVEN_DAY_MS };
})();
