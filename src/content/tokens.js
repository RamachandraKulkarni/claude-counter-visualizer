(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	function stringifyMessageCountables(message) {
		const parts = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}

		// Attachment extracted content (observable, already text).
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				parts.push(a.extracted_content);
			}
		}

		return parts.join('\n');
	}

	async function hashString(str) {
		if (!CC.bridge?.requestHash) return null;
		try {
			const res = await CC.bridge.requestHash(str);
			if (res?.hash) return res.hash;
		} catch {
			// No local hashing fallback.
		}
		return null;
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	/**
	 * [CONFIG] Maximum number of cached message entries to prevent unbounded memory growth.
	 * [EDGE] LRU eviction kicks in when cache exceeds this size.
	 */
	const MAX_CACHE_SIZE = 1000;

	/**
	 * Token cache with LRU eviction to prevent memory leaks.
	 * [CLEANUP] Automatically evicts oldest entries when size limit exceeded.
	 */
	class TokenCache {
		constructor(options = {}) {
			// [CONFIG] Allow configurable max size
			this._maxSize = options.maxSize || MAX_CACHE_SIZE;
			this._byMessageId = new Map(); // uuid -> { fp, tokens, lastAccessed }
		}

		/**
		 * Get token count for a message, using cache when possible.
		 * [LRU] Updates lastAccessed timestamp on cache hits.
		 * @param {string} messageId - Message UUID
		 * @param {string} messageText - Message content
		 * @returns {Promise<number>} Token count
		 */
		async getMessageTokens(messageId, messageText) {
			// [VALIDATION] Validate inputs
			if ('string' !== typeof messageId || 0 === messageId.length) {
				return countTokens(messageText);
			}

			const fp = await fingerprint(messageText);
			if (!fp) return countTokens(messageText);

			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) {
				// [LRU] Update access timestamp on cache hit
				cached.lastAccessed = Date.now();
				return cached.tokens;
			}

			const tokens = countTokens(messageText);
			this._byMessageId.set(messageId, { fp, tokens, lastAccessed: Date.now() });

			// [LRU] Enforce size limit
			this._enforceSizeLimit();

			return tokens;
		}

		/**
		 * Remove entries not in the keep list.
		 * [EDGE] Also enforces max size limit.
		 * @param {string[]} keepIds - Array of message IDs to keep
		 */
		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}

			// [LRU] Enforce size limit after pruning
			this._enforceSizeLimit();
		}

		/**
		 * [LRU] Enforce maximum cache size by evicting oldest entries.
		 * Sorts by lastAccessed timestamp and removes oldest entries first.
		 * @private
		 */
		_enforceSizeLimit() {
			if (this._byMessageId.size <= this._maxSize) return;

			// Convert to array for sorting
			const entries = Array.from(this._byMessageId.entries());

			// Sort by lastAccessed ascending (oldest first)
			entries.sort((a, b) => {
				const aTime = a[1].lastAccessed || 0;
				const bTime = b[1].lastAccessed || 0;
				return aTime - bTime;
			});

			// Calculate how many to delete
			const toDelete = entries.length - this._maxSize;

			// Delete oldest entries
			for (let i = 0; i < toDelete; i++) {
				this._byMessageId.delete(entries[i][0]);
			}
		}

		/**
		 * Get current cache size for debugging.
		 * @returns {number} Number of cached entries
		 */
		get size() {
			return this._byMessageId.size;
		}

		/**
		 * Clear all cached entries.
		 */
		clear() {
			this._byMessageId.clear();
		}
	}

	// [CONFIG] Create token cache with default size limit
	const tokenCache = new TokenCache({ maxSize: MAX_CACHE_SIZE });

	function makeSnippet(text, max = 80) {
		if ('string' !== typeof text) return '';
		const collapsed = text.replace(/\s+/g, ' ').trim();
		if (collapsed.length <= max) return collapsed;
		return collapsed.slice(0, max - 1) + '…';
	}

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		let totalTokens = 0;
		let lastAssistantMs = null;
		const perMessage = [];

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const msgText = stringifyMessageCountables(msg);
			const msgTokens = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, msgText) : countTokens(msgText);
			totalTokens += msgTokens;

			// [CONFIG] Per-message metadata for bloat hunter + per-conversation history.
			if (msg?.uuid) {
				perMessage.push({
					id: msg.uuid,
					role: msg.sender || 'unknown',
					tokens: msgTokens,
					createdAt: msg.created_at ? Date.parse(msg.created_at) : null,
					snippet: makeSnippet(msgText),
					hasAttachments: Array.isArray(msg.attachments) && msg.attachments.length > 0,
					attachmentCount: Array.isArray(msg.attachments) ? msg.attachments.length : 0
				});
			}
		}
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;
		const remainingTokens = Math.max(0, CC.CONST.CONTEXT_LIMIT_TOKENS - totalTokens);
		const usedPct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
		let contextHealth = 'Healthy';
		if (usedPct >= 90) {
			contextHealth = 'Extremely high';
		} else if (usedPct >= 75) {
			contextHealth = 'Nearing context';
		} else if (usedPct >= 50) {
			contextHealth = 'Moderate';
		}

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			remainingTokens,
			usedPct,
			contextHealth,
			lastAssistantMs,
			cachedUntil,
			perMessage
		};
	}

	/**
	 * Return the top-N heaviest messages from a metrics result.
	 * [EDGE] Returns [] when input is missing or perMessage absent.
	 */
	function getHeaviestMessages(metrics, n = 5) {
		if (!metrics || !Array.isArray(metrics.perMessage)) return [];
		const cap = 'number' === typeof n && n > 0 ? Math.floor(n) : 5;
		return metrics.perMessage
			.slice()
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, cap);
	}

	CC.tokens = { computeConversationMetrics, getHeaviestMessages, makeSnippet };
})();
