(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * Delay utility with cancellation support.
	 * [VALIDATION] ms must be non-negative number.
	 * @param {number} ms - Milliseconds to delay
	 * @param {AbortSignal} [signal] - Optional abort signal
	 * @returns {Promise} Resolves after delay
	 */
	function delay(ms, signal) {
		if ('number' !== typeof ms || ms < 0) {
			throw new Error('delay: ms must be non-negative number');
		}

		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error('Delay aborted'));
				return;
			}

			const timeoutId = setTimeout(resolve, ms);

			if (signal) {
				signal.addEventListener('abort', () => {
					clearTimeout(timeoutId);
					reject(new Error('Delay aborted'));
				}, { once: true });
			}
		});
	}

	/**
	 * Retry configuration options.
	 * @typedef {Object} RetryOptions
	 * @property {number} [maxAttempts=3] - Maximum retry attempts
	 * @property {number} [baseDelay=1000] - Initial delay in ms
	 * @property {number} [maxDelay=30000] - Maximum delay cap
	 * @property {number} [backoffFactor=2] - Exponential backoff multiplier
	 * @property {Function} [shouldRetry] - Function to determine if error is retryable
	 * @property {AbortSignal} [signal] - AbortSignal for cancellation
	 */

	/**
	 * Default retryable errors (network errors, timeouts, rate limits).
	 * [EDGE] Handle specific error types that warrant retry.
	 * @param {Error} error - The error to check
	 * @returns {boolean} True if error is retryable
	 */
	function defaultShouldRetry(error) {
		if (!error) return false;

		const message = error.message || '';

		// Retry on timeout
		if (message.includes('timeout') || message.includes('Timed out')) {
			return true;
		}

		// Retry on network errors
		if (message.includes('network') || message.includes('fetch')) {
			return true;
		}

		// Retry on rate limit (429)
		if (message.includes('429') || message.includes('rate limit')) {
			return true;
		}

		// Retry on server errors (5xx)
		if (/5\d{2}/.test(message)) {
			return true;
		}

		return false;
	}

	/**
	 * Execute a function with exponential backoff retry.
	 * [FAIL-FAST] Rejects invalid configuration.
	 * [VALIDATION] Validates all retry parameters.
	 *
	 * @template T
	 * @param {Function} fn - Function to execute (must return Promise)
	 * @param {RetryOptions} [options={}] - Retry configuration
	 * @returns {Promise<T>} Result of successful execution
	 * @throws {Error} Last error after all attempts exhausted
	 */
	async function withRetry(fn, options = {}) {
		// [VALIDATION] Validate function parameter
		if ('function' !== typeof fn) {
			throw new TypeError('withRetry: fn must be a function');
		}

		// [VALIDATION] Extract and validate options
		const maxAttempts = 'number' === typeof options.maxAttempts && options.maxAttempts > 0
			? options.maxAttempts : 3;
		const baseDelay = 'number' === typeof options.baseDelay && options.baseDelay >= 0
			? options.baseDelay : 1000;
		const maxDelay = 'number' === typeof options.maxDelay && options.maxDelay >= baseDelay
			? options.maxDelay : 30000;
		const backoffFactor = 'number' === typeof options.backoffFactor && options.backoffFactor >= 1
			? options.backoffFactor : 2;
		const shouldRetry = 'function' === typeof options.shouldRetry
			? options.shouldRetry : defaultShouldRetry;
		const signal = options.signal;

		// [EDGE] Check for pre-aborted signal
		if (signal?.aborted) {
			throw new Error('Retry operation aborted before start');
		}

		let lastError = null;
		const attemptLog = [];

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			// [EDGE] Check abort signal before each attempt
			if (signal?.aborted) {
				throw new Error('Retry operation aborted');
			}

			try {
				const result = await fn();

				// Log successful retry if it wasn't the first attempt
				if (attempt > 0 && CC.utils?.errors?.debug) {
					CC.utils.errors.debug('Retry succeeded', {
						attempt: attempt + 1,
						previousErrors: attemptLog
					});
				}

				return result;
			} catch (e) {
				lastError = e;
				attemptLog.push({
					attempt: attempt + 1,
					error: e?.message || String(e),
					ts: Date.now()
				});

				// Check if we should retry this error
				if (!shouldRetry(e)) {
					if (CC.utils?.errors?.debug) {
						CC.utils.errors.debug('Error not retryable, aborting', {
							error: e?.message,
							attempt: attempt + 1
						});
					}
					throw e;
				}

				// Don't delay after the last attempt
				if (attempt < maxAttempts - 1) {
					// Calculate exponential backoff with jitter
					const delayMs = Math.min(
						baseDelay * Math.pow(backoffFactor, attempt),
						maxDelay
					);

					// Add jitter (0-20%) to prevent thundering herd
					const jitter = delayMs * 0.2 * Math.random();
					const finalDelay = Math.floor(delayMs + jitter);

					if (CC.utils?.errors?.debug) {
						CC.utils.errors.debug(`Retry ${attempt + 1}/${maxAttempts}`, {
							delay: finalDelay,
							error: e?.message
						});
					}

					try {
						await delay(finalDelay, signal);
					} catch (abortError) {
						if (signal?.aborted) {
							throw new Error(`Retry aborted during delay: ${e?.message}`);
						}
						throw abortError;
					}
				}
			}
		}

		// All attempts exhausted
		const summaryError = new Error(
			`Failed after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`
		);
		summaryError.cause = lastError;
		summaryError.attempts = attemptLog;

		if (CC.utils?.errors?.error) {
			CC.utils.errors.error('All retry attempts exhausted', {
				attempts: maxAttempts,
				lastError: lastError?.message,
				attemptLog
			});
		}

		throw summaryError;
	}

	/**
	 * Create a cancellable retry controller.
	 * @returns {{ signal: AbortSignal, abort: Function, withRetry: Function }}
	 */
	function createRetryController() {
		const controller = new AbortController();

		return {
			signal: controller.signal,
			abort: () => controller.abort(),
			withRetry: (fn, options = {}) => withRetry(fn, {
				...options,
				signal: controller.signal
			})
		};
	}

	// Expose utilities on global namespace
	CC.utils = CC.utils || {};
	CC.utils.retry = {
		delay,
		withRetry,
		createRetryController,
		defaultShouldRetry
	};
})();
