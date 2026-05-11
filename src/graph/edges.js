// [SECURITY] Pure transformation. Builds nodes + edges arrays from pin and
// link records. Auto-edges (cooccur/tag) are computed at render time and
// never persisted — only manual links live in the DB.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * Build the graph node + edge arrays.
	 *
	 * Decision: virtual hub nodes for chats and tags. A chat with 8 pins becomes
	 * 1 chat-hub + 8 pin-to-hub edges, not 28 pairwise pin-to-pin edges. Same
	 * for tags. Cuts edge count from O(n²/group) to O(n).
	 *
	 * @param {Array} pins   - persisted pin records
	 * @param {Array} links  - manual link records
	 * @param {object} [opts]
	 * @param {boolean} [opts.showCooccur=true]
	 * @param {boolean} [opts.showTag=true]
	 * @param {boolean} [opts.showManual=true]
	 *
	 * @returns {{ nodes, edges, projects, tags }}
	 *   nodes: [{ id, kind: 'pin'|'chat'|'tag', label, ref?, project?, radius, color }]
	 *   edges: [{ source, target, kind: 'cooccur'|'tag'|'manual', label? }]
	 *   projects: Set of project ids
	 *   tags: Set of tag strings
	 */
	function build(pins, links, opts = {}) {
		const showCooccur = opts.showCooccur !== false;
		const showTag = opts.showTag !== false;
		const showManual = opts.showManual !== false;

		const nodes = [];
		const edges = [];
		const projects = new Set();
		const tags = new Set();

		const byPinId = new Map();
		// Pin nodes
		for (const p of pins) {
			if (!p?.id) continue;
			const radius = Math.max(4, Math.min(24, Math.sqrt(p.tokenCount || 4)));
			const node = {
				id: `pin:${p.id}`,
				kind: 'pin',
				label: (p.chatTitle || 'pin').slice(0, 40),
				ref: p,
				project: p.conversationId || null,
				radius
			};
			nodes.push(node);
			byPinId.set(p.id, node);
			if (p.conversationId) projects.add(p.conversationId);
			for (const t of p.tags || []) tags.add(t);
		}

		// Co-occurrence hubs (one per chat)
		if (showCooccur) {
			const chats = new Map(); // conversationId -> { id, label, members[] }
			for (const p of pins) {
				if (!p?.conversationId) continue;
				if (!chats.has(p.conversationId)) {
					chats.set(p.conversationId, {
						id: `chat:${p.conversationId}`,
						kind: 'hub',
						subkind: 'chat',
						label: (p.chatTitle || 'chat').slice(0, 40),
						radius: 6,
						project: p.conversationId,
						members: []
					});
				}
				chats.get(p.conversationId).members.push(p.id);
			}
			for (const hub of chats.values()) {
				if (hub.members.length < 2) continue;  // hub only useful with ≥2 pins
				nodes.push(hub);
				for (const pid of hub.members) {
					const pn = byPinId.get(pid);
					if (pn) edges.push({ source: hub.id, target: pn.id, kind: 'cooccur' });
				}
			}
		}

		// Tag hubs (one per tag)
		if (showTag) {
			const tagMembers = new Map(); // tag -> Set of pin ids
			for (const p of pins) {
				for (const t of p.tags || []) {
					if (!tagMembers.has(t)) tagMembers.set(t, new Set());
					tagMembers.get(t).add(p.id);
				}
			}
			for (const [tag, members] of tagMembers.entries()) {
				if (members.size < 2) continue;
				const hub = {
					id: `tag:${tag}`,
					kind: 'hub',
					subkind: 'tag',
					label: `#${tag}`,
					radius: 5
				};
				nodes.push(hub);
				for (const pid of members) {
					const pn = byPinId.get(pid);
					if (pn) edges.push({ source: hub.id, target: pn.id, kind: 'tag' });
				}
			}
		}

		// Manual links (pin → pin, direct)
		if (showManual) {
			for (const l of links || []) {
				const a = byPinId.get(l.fromPinId);
				const b = byPinId.get(l.toPinId);
				if (a && b) {
					edges.push({
						source: a.id,
						target: b.id,
						kind: 'manual',
						label: l.label || '',
						id: l.id
					});
				}
			}
		}

		return { nodes, edges, projects, tags };
	}

	/**
	 * Build the clustered overview (>2000-node fallback). Each project becomes
	 * a single oversized hub; each chat within a project a smaller satellite.
	 * No pin nodes.
	 */
	function buildClustered(pins) {
		const nodes = [];
		const edges = [];

		const byProject = new Map();   // projectId -> { pinCount, chats: Map(chatId -> count) }
		for (const p of pins) {
			const proj = p.conversationId || 'unknown';
			if (!byProject.has(proj)) byProject.set(proj, { pinCount: 0, chats: new Map(), title: p.chatTitle });
			const entry = byProject.get(proj);
			entry.pinCount++;
			entry.chats.set(p.conversationId, (entry.chats.get(p.conversationId) || 0) + 1);
		}

		for (const [proj, info] of byProject.entries()) {
			const node = {
				id: `cluster-project:${proj}`,
				kind: 'cluster',
				subkind: 'project',
				label: (info.title || proj || 'unknown').slice(0, 30),
				radius: Math.max(12, Math.min(60, 6 + Math.sqrt(info.pinCount) * 3)),
				project: proj,
				count: info.pinCount,
				drillTo: proj
			};
			nodes.push(node);
		}

		return { nodes, edges };
	}

	CC.graphEdges = { build, buildClustered };
})();
