(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * Resource cleanup tracker for production-ready observer/timer management.
	 * Prevents memory leaks by ensuring all resources are properly disposed.
	 */
	class CleanupTracker {
		constructor() {
			/** @type {Set<MutationObserver>} */
			this._observers = new Set();
			/** @type {Set<number>} */
			this._timers = new Set();
			/** @type {Set<Function>} */
			this._callbacks = new Set();
			this._isCleaning = false;
		}

		/**
		 * Track a MutationObserver for automatic cleanup.
		 * [VALIDATION] Only accepts valid MutationObserver instances.
		 * @param {MutationObserver} observer - The observer to track
		 * @returns {MutationObserver} The same observer for chaining
		 */
		trackObserver(observer) {
			if (!(observer instanceof MutationObserver)) {
				if (CC.utils?.errors?.warn) {
					CC.utils.errors.warn('CleanupTracker.trackObserver: invalid observer type', {
						type: typeof observer
					});
				}
				return observer;
			}
			this._observers.add(observer);
			return observer;
		}

		/**
		 * Track a setTimeout timer ID.
		 * [VALIDATION] Only accepts valid numbers.
		 * @param {number} timerId - The timer ID from setTimeout/setInterval
		 * @returns {number} The same timer ID for convenience
		 */
		trackTimer(timerId) {
			if ('number' !== typeof timerId || isNaN(timerId)) {
				if (CC.utils?.errors?.warn) {
					CC.utils.errors.warn('CleanupTracker.trackTimer: invalid timer ID', {
						value: timerId
					});
				}
				return timerId;
			}
			this._timers.add(timerId);
			return timerId;
		}

		/**
		 * Track a cleanup callback function.
		 * [VALIDATION] Only accepts functions.
		 * @param {Function} callback - Cleanup callback
		 */
		trackCallback(callback) {
			if ('function' !== typeof callback) {
				if (CC.utils?.errors?.warn) {
					CC.utils.errors.warn('CleanupTracker.trackCallback: callback must be function', {
						type: typeof callback
					});
				}
				return;
			}
			this._callbacks.add(callback);
		}

		/**
		 * Disconnect a specific observer and remove from tracking.
		 * @param {MutationObserver} observer - The observer to disconnect
		 */
		releaseObserver(observer) {
			if (!this._observers.has(observer)) return;

			try {
				observer.disconnect();
			} catch (e) {
				if (CC.utils?.errors?.reportError) {
					CC.utils.errors.reportError(e, 'CleanupTracker.releaseObserver');
				}
			}
			this._observers.delete(observer);
		}

		/**
		 * Clear a specific timer and remove from tracking.
		 * @param {number} timerId - The timer ID to clear
		 */
		releaseTimer(timerId) {
			if (!this._timers.has(timerId)) return;

			clearTimeout(timerId);
			this._timers.delete(timerId);
		}

		/**
		 * Execute a specific cleanup callback and remove from tracking.
		 * @param {Function} callback - The callback to execute
		 */
		releaseCallback(callback) {
			if (!this._callbacks.has(callback)) return;

			try {
				callback();
			} catch (e) {
				if (CC.utils?.errors?.reportError) {
					CC.utils.errors.reportError(e, 'CleanupTracker.releaseCallback');
				}
			}
			this._callbacks.delete(callback);
		}

		/**
		 * Execute all cleanup operations.
		 * [EDGE] Prevent re-entrant cleanup.
		 * [FAIL-FAST] Log all cleanup errors but continue cleanup.
		 */
		cleanup() {
			if (this._isCleaning) {
				if (CC.utils?.errors?.warn) {
					CC.utils.errors.warn('CleanupTracker.cleanup: already in progress');
				}
				return;
			}

			this._isCleaning = true;

			const errors = [];

			// Clear all timers
			for (const timerId of this._timers) {
				try {
					clearTimeout(timerId);
				} catch (e) {
					errors.push({ type: 'timer', id: timerId, error: e });
				}
			}
			this._timers.clear();

			// Disconnect all observers
			for (const observer of this._observers) {
				try {
					observer.disconnect();
				} catch (e) {
					errors.push({ type: 'observer', error: e });
				}
			}
			this._observers.clear();

			// Execute all callbacks
			for (const callback of this._callbacks) {
				try {
					callback();
				} catch (e) {
					errors.push({ type: 'callback', error: e });
				}
			}
			this._callbacks.clear();

			this._isCleaning = false;

			// Log any errors that occurred during cleanup
			if (errors.length > 0 && CC.utils?.errors?.error) {
				CC.utils.errors.error('CleanupTracker.cleanup: errors during cleanup', {
					errorCount: errors.length,
					errors: errors.map(e => ({
						type: e.type,
						message: e.error?.message
					}))
				});
			}
		}

		/**
		 * Get current resource counts for debugging.
		 * @returns {{ observers: number, timers: number, callbacks: number }}
		 */
		getCounts() {
			return {
				observers: this._observers.size,
				timers: this._timers.size,
				callbacks: this._callbacks.size
			};
		}
	}

	// Create singleton instance
	const tracker = new CleanupTracker();

	/**
	 * Setup automatic cleanup on page unload.
	 * [EDGE] Only register once.
	 */
	let unloadHandlerRegistered = false;
	function setupUnloadCleanup() {
		if (unloadHandlerRegistered) return;
		unloadHandlerRegistered = true;

		window.addEventListener('beforeunload', () => {
			tracker.cleanup();
		});

		// Also handle pagehide for mobile browsers
		window.addEventListener('pagehide', () => {
			tracker.cleanup();
		});
	}

	// Auto-setup on load
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', setupUnloadCleanup);
	} else {
		setupUnloadCleanup();
	}

	// Expose utilities on global namespace
	CC.utils = CC.utils || {};
	CC.utils.cleanup = {
		tracker,
		trackObserver: (obs) => tracker.trackObserver(obs),
		trackTimer: (id) => tracker.trackTimer(id),
		trackCallback: (cb) => tracker.trackCallback(cb),
		releaseObserver: (obs) => tracker.releaseObserver(obs),
		releaseTimer: (id) => tracker.releaseTimer(id),
		releaseCallback: (cb) => tracker.releaseCallback(cb),
		cleanup: () => tracker.cleanup(),
		getCounts: () => tracker.getCounts()
	};
})();
