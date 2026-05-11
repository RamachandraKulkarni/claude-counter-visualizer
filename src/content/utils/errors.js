(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * Log levels for structured error logging.
	 * [VALIDATION] Enforce valid log levels through constant.
	 */
	const LogLevel = Object.freeze({
		DEBUG: 0,
		INFO: 1,
		WARN: 2,
		ERROR: 3
	});

	/**
	 * Production-ready logger with level filtering.
	 * Fails fast on invalid log level assignments.
	 */
	class Logger {
		constructor() {
			this._level = LogLevel.WARN;
			this._buffer = [];
			this._bufferSize = 100;
		}

		/**
		 * [VALIDATION] Set minimum log level. Ignores invalid levels.
		 * @param {number} level - One of LogLevel values
		 */
		setLevel(level) {
			if ('number' !== typeof level || level < LogLevel.DEBUG || level > LogLevel.ERROR) {
				this._logInternal(LogLevel.WARN, 'Invalid log level attempted', { attempted: level });
				return;
			}
			this._level = level;
		}

		/**
		 * Log a message with optional metadata.
		 * [FAIL-FAST] Rejects empty messages.
		 * @param {number} level - Log level
		 * @param {string} msg - Message to log
		 * @param {Object} [meta] - Optional metadata
		 */
		log(level, msg, meta) {
			if ('string' !== typeof msg || 0 === msg.length) return;
			if (level < this._level) return;
			this._logInternal(level, msg, meta);
		}

		/**
		 * Internal log implementation with buffering.
		 * @private
		 */
		_logInternal(level, msg, meta) {
			const entry = {
				ts: Date.now(),
				level,
				msg,
				meta: meta || null,
				url: window.location.href
			};

			// Add to circular buffer
			if (this._buffer.length >= this._bufferSize) {
				this._buffer.shift();
			}
			this._buffer.push(entry);

			// Console output with appropriate method
			const prefix = `[CC] ${this._levelName(level)}:`;
			const logFn = level >= LogLevel.ERROR ? console.error
				: level >= LogLevel.WARN ? console.warn
					: level >= LogLevel.INFO ? console.info
						: console.log;

			if (null !== entry.meta) {
				// [EDGE] Strip undefined/null props so `{ error: undefined }`
				// doesn't render as `[object Object]` when surfaced by harnesses
				// that stringify the meta arg.
				const cleaned = this._cleanMeta(entry.meta);
				if (cleaned !== null) {
					logFn(prefix, msg, cleaned);
				} else {
					logFn(prefix, msg);
				}
			} else {
				logFn(prefix, msg);
			}
		}

		/**
		 * Remove undefined/null leaves from a shallow meta object. Returns null
		 * when nothing is left to print.
		 * @private
		 */
		_cleanMeta(meta) {
			if (null === meta || 'object' !== typeof meta) return meta;
			const out = {};
			let hasAny = false;
			for (const k of Object.keys(meta)) {
				const v = meta[k];
				if (v === undefined || v === null) continue;
				if ('string' === typeof v && 0 === v.length) continue;
				out[k] = v;
				hasAny = true;
			}
			return hasAny ? out : null;
		}

		/**
		 * Get recent log entries for debugging.
		 * @param {number} [count=50] - Number of entries to retrieve
		 * @returns {Array} Recent log entries
		 */
		getRecent(count = 50) {
			if ('number' !== typeof count || count <= 0) return [];
			return this._buffer.slice(-count);
		}

		/**
		 * Clear the log buffer.
		 */
		clear() {
			this._buffer.length = 0;
		}

		_levelName(level) {
			switch (level) {
				case LogLevel.DEBUG: return 'DEBUG';
				case LogLevel.INFO: return 'INFO';
				case LogLevel.WARN: return 'WARN';
				case LogLevel.ERROR: return 'ERROR';
				default: return 'UNKNOWN';
			}
		}
	}

	/**
	 * Create singleton logger instance.
	 * [FAIL-FAST] Prevent re-initialization.
	 */
	const logger = new Logger();

	/**
	 * Convenience methods for different log levels.
	 */
	function debug(msg, meta) { logger.log(LogLevel.DEBUG, msg, meta); }
	function info(msg, meta) { logger.log(LogLevel.INFO, msg, meta); }
	function warn(msg, meta) { logger.log(LogLevel.WARN, msg, meta); }
	function error(msg, meta) { logger.log(LogLevel.ERROR, msg, meta); }

	/**
	 * [EDGE] Report error with stack trace capture.
	 * @param {Error} err - Error object
	 * @param {string} context - Where the error occurred
	 * @param {Object} [meta] - Additional metadata
	 */
	function reportError(err, context, meta) {
		if (!(err instanceof Error)) {
			warn('reportError called with non-Error', { type: typeof err, context });
			return;
		}
		error(`Error in ${context}: ${err.message}`, {
			stack: err.stack,
			...meta
		});
	}

	// Expose utilities on global namespace
	CC.utils = CC.utils || {};
	CC.utils.errors = {
		LogLevel,
		logger,
		debug,
		info,
		warn,
		error,
		reportError
	};
})();
