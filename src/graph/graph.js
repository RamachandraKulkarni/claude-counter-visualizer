// [SECURITY] Graph view reads pins + links directly from IndexedDB. No
// outbound network. Canvas labels are set via fillText (no innerHTML on user
// content). All DOM additions use textContent.
(() => {
	'use strict';

	const SVG_NS = 'http://www.w3.org/2000/svg';
	void SVG_NS;

	const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	const tabsApi = globalThis.browser?.tabs || globalThis.chrome?.tabs || null;
	const force = globalThis.ClaudeCounter?.force;
	const graphEdges = globalThis.ClaudeCounter?.graphEdges;

	// [CONFIG] Threshold above which the clustered fallback kicks in.
	const CLUSTER_THRESHOLD = 2000;

	// 12-color qualitative palette, colorblind-friendly default.
	// Project IDs hash to indexes into this list.
	const PROJECT_PALETTE = [
		'#56d4dd', '#d2a8ff', '#7ee787', '#f2cc60', '#ffa657', '#ff7b72',
		'#79c0ff', '#a5d6ff', '#ffa198', '#d4c5f9', '#9ec1cf', '#b1d4a4'
	];

	// ---- DOM refs ----
	const el = (id) => document.getElementById(id);
	const refs = {
		meta: el('cc-gr-meta'),
		stats: el('cc-gr-stats'),
		back: el('cc-gr-back'),
		canvas: el('cc-gr-canvas'),
		canvasWrap: el('cc-gr-canvaswrap'),
		sronly: el('cc-gr-sronly'),
		search: el('cc-gr-search'),
		project: el('cc-gr-project'),
		tag: el('cc-gr-tag'),
		reset: el('cc-gr-reset'),
		freeze: el('cc-gr-freeze'),
		linkBuffer: el('cc-gr-link-buffer'),
		linkBufferText: el('cc-gr-link-buffer-text'),
		linkCreateBtn: el('cc-gr-link-create'),
		linkClearBtn: el('cc-gr-link-clear'),
		clusteredBanner: el('cc-gr-clustered-banner'),
		clusteredForce: el('cc-gr-clustered-force'),
		sideEmpty: el('cc-gr-side-empty'),
		sideDetail: el('cc-gr-side-detail'),
		sideTitle: el('cc-gr-side-title'),
		sideClose: el('cc-gr-side-close'),
		sideModel: el('cc-gr-side-model'),
		sideDate: el('cc-gr-side-date'),
		sideTokens: el('cc-gr-side-tokens'),
		sideTags: el('cc-gr-side-tags'),
		sideBody: el('cc-gr-side-body'),
		sideLinksList: el('cc-gr-side-links-list'),
		sideCopy: el('cc-gr-side-copy'),
		sideOpenChat: el('cc-gr-side-openchat'),
		sideLinkFrom: el('cc-gr-side-linkfrom'),
		sideUnpin: el('cc-gr-side-unpin'),
		// Modal
		modal: el('cc-gr-label-modal'),
		modalClose: el('cc-gr-label-close'),
		modalCancel: el('cc-gr-label-cancel'),
		modalCreate: el('cc-gr-label-create'),
		modalInput: el('cc-gr-label-input'),
		modalBackdrop: el('cc-gr-label-backdrop')
	};

	const ctx = refs.canvas.getContext('2d');

	// ---- State ----
	const state = {
		pins: [],
		links: [],
		nodes: [],
		edges: [],
		clustered: false,
		clusteredForceLoad: false,
		simulation: null,
		transform: { tx: 0, ty: 0, scale: 1 },
		selection: null,
		hover: null,
		linkBuffer: [],   // pin nodes
		pendingLinkOp: null,  // 'graph' | 'from-side'
		settle: 0,
		needsRedraw: true,
		dpr: 1,
		w: 0,
		h: 0,
		dragging: null,    // node currently being dragged
		panning: false,
		panStart: null,
		search: '',
		project: '',
		tag: '',
		colorByProject: new Map() // projectId -> hex
	};

	// ---- IndexedDB direct access ----
	function openDb() {
		return new Promise((resolve) => {
			try {
				const req = indexedDB.open('claude_counter_v1');
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(null);
			} catch { resolve(null); }
		});
	}

	async function readAll(storeName) {
		const db = await openDb();
		if (!db || !db.objectStoreNames.contains(storeName)) return [];
		return new Promise((resolve) => {
			try {
				const tx = db.transaction(storeName, 'readonly');
				const req = tx.objectStore(storeName).getAll();
				req.onsuccess = () => resolve(req.result || []);
				req.onerror = () => resolve([]);
			} catch { resolve([]); }
		});
	}

	async function putRow(storeName, row) {
		const db = await openDb();
		if (!db || !db.objectStoreNames.contains(storeName)) return false;
		return new Promise((resolve) => {
			try {
				const tx = db.transaction(storeName, 'readwrite');
				const req = tx.objectStore(storeName).put(row);
				req.onsuccess = () => resolve(true);
				req.onerror = () => resolve(false);
			} catch { resolve(false); }
		});
	}

	async function deleteRow(storeName, id) {
		const db = await openDb();
		if (!db || !db.objectStoreNames.contains(storeName)) return false;
		return new Promise((resolve) => {
			try {
				const tx = db.transaction(storeName, 'readwrite');
				const req = tx.objectStore(storeName).delete(id);
				req.onsuccess = () => resolve(true);
				req.onerror = () => resolve(false);
			} catch { resolve(false); }
		});
	}

	// ---- Color helpers ----
	function hashStringToIndex(s, mod) {
		let h = 5381;
		for (let i = 0; i < (s || '').length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
		return h % mod;
	}

	function projectColor(projectId) {
		if (!projectId) return cssVar('--fg-muted', '#888');
		if (state.colorByProject.has(projectId)) return state.colorByProject.get(projectId);
		const c = PROJECT_PALETTE[hashStringToIndex(projectId, PROJECT_PALETTE.length)];
		state.colorByProject.set(projectId, c);
		return c;
	}

	function cssVar(name, fallback) {
		const v = getComputedStyle(document.body).getPropertyValue(name).trim();
		return v || fallback;
	}

	// ---- Sizing ----
	function resizeCanvas() {
		const rect = refs.canvasWrap.getBoundingClientRect();
		state.dpr = window.devicePixelRatio || 1;
		state.w = Math.max(100, Math.floor(rect.width));
		state.h = Math.max(100, Math.floor(rect.height));
		refs.canvas.width = state.w * state.dpr;
		refs.canvas.height = state.h * state.dpr;
		refs.canvas.style.width = `${state.w}px`;
		refs.canvas.style.height = `${state.h}px`;
		ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
		state.needsRedraw = true;
	}

	// ---- Coordinate transforms ----
	function worldToScreen(x, y) {
		return { x: x * state.transform.scale + state.transform.tx, y: y * state.transform.scale + state.transform.ty };
	}

	function screenToWorld(x, y) {
		return { x: (x - state.transform.tx) / state.transform.scale, y: (y - state.transform.ty) / state.transform.scale };
	}

	// ---- Hit testing ----
	function nodeAtScreen(sx, sy) {
		const world = screenToWorld(sx, sy);
		// Iterate in reverse so top-painted nodes hit first.
		for (let i = state.nodes.length - 1; i >= 0; i--) {
			const n = state.nodes[i];
			const dx = n.x - world.x;
			const dy = n.y - world.y;
			const r = (n.radius || 8) + 2;
			if (dx * dx + dy * dy <= r * r) return n;
		}
		return null;
	}

	// ---- Force sim wiring ----
	function buildSimulation(nodes, edges) {
		if (!force) return null;
		const sim = force.forceSimulation(nodes)
			.force('link', force.forceLink(edges).id((d) => d.id).distance((e) => {
				if (e.kind === 'manual') return 80;
				if (e.kind === 'tag') return 90;
				return 60;
			}).strength(0.6))
			.force('charge', force.forceManyBody().strength((n) => {
				if (n.kind === 'hub') return -120;
				if (n.kind === 'cluster') return -800;
				return -180;
			}))
			.force('center', force.forceCenter(0, 0).strength(0.05))
			.force('collide', force.forceCollide((n) => (n.radius || 6) + 2));

		return sim;
	}

	function runSimulationLoop() {
		if (!state.simulation) return;
		if (refs.freeze?.getAttribute('aria-pressed') === 'true') return;
		// 1 tick per RAF — keeps interactions responsive even on large graphs.
		state.simulation.tick(1);
		state.settle++;
		state.needsRedraw = true;
		// Stop ticking after settle (alpha cools below alphaMin internally).
		if (state.settle > 600) {
			state.simulation.stop();
		}
	}

	function reduceMotionOn() {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	// ---- Drawing ----
	function draw() {
		ctx.clearRect(0, 0, state.w, state.h);

		// Background grid hint at low scales (optional, subtle).
		// Skipped for now to keep paint cheap.

		ctx.save();
		ctx.translate(state.transform.tx, state.transform.ty);
		ctx.scale(state.transform.scale, state.transform.scale);

		const dimUnrelated = state.selection !== null;
		const relatedEdgeIds = new Set();
		const relatedNodeIds = new Set();
		if (dimUnrelated) {
			relatedNodeIds.add(state.selection.id);
			for (const e of state.edges) {
				if (e.source.id === state.selection.id || e.target.id === state.selection.id) {
					relatedEdgeIds.add(e);
					relatedNodeIds.add(e.source.id);
					relatedNodeIds.add(e.target.id);
				}
			}
		}

		// Search dimming
		const hasSearch = state.search.length > 0;
		const matchingNodeIds = new Set();
		if (hasSearch) {
			const q = state.search.toLowerCase();
			for (const n of state.nodes) {
				if (n.kind !== 'pin') continue;
				const hay = `${n.ref?.content || ''}\n${n.ref?.chatTitle || ''}`.toLowerCase();
				if (hay.includes(q)) matchingNodeIds.add(n.id);
			}
		}

		// Edges first
		for (const e of state.edges) {
			drawEdge(e, dimUnrelated && !relatedEdgeIds.has(e), hasSearch, matchingNodeIds);
		}
		// Nodes on top
		for (const n of state.nodes) {
			drawNode(n,
				dimUnrelated && !relatedNodeIds.has(n.id),
				hasSearch && n.kind === 'pin' && !matchingNodeIds.has(n.id));
		}

		ctx.restore();

		// Update stats line below the canvas.
		if (hasSearch && refs.stats) {
			refs.stats.textContent = `${matchingNodeIds.size} of ${countPinNodes()} match`;
		}
	}

	function countPinNodes() {
		let n = 0;
		for (const x of state.nodes) if (x.kind === 'pin') n++;
		return n;
	}

	function drawEdge(e, isDim, hasSearch, matching) {
		const colors = {
			cooccur: cssVar('--accent-cyan', '#79c0ff'),
			tag: cssVar('--accent-yellow', '#f2cc60'),
			manual: cssVar('--accent-mint', '#56d4dd')
		};
		const opacity = {
			cooccur: isDim ? 0.06 : 0.30,
			tag: isDim ? 0.10 : 0.50,
			manual: isDim ? 0.20 : 0.90
		};
		const widths = { cooccur: 1, tag: 1.5, manual: 2.5 };

		let alpha = opacity[e.kind] || 0.3;
		if (hasSearch && e.source.kind === 'pin' && e.target.kind === 'pin') {
			if (!matching.has(e.source.id) && !matching.has(e.target.id)) alpha *= 0.4;
		}

		ctx.strokeStyle = colors[e.kind] || '#888';
		ctx.globalAlpha = alpha;
		ctx.lineWidth = widths[e.kind] || 1;
		ctx.beginPath();
		ctx.moveTo(e.source.x, e.source.y);
		ctx.lineTo(e.target.x, e.target.y);
		ctx.stroke();
		ctx.globalAlpha = 1;

		// Label midpoint for manual links when zoomed in.
		if (e.kind === 'manual' && e.label && state.transform.scale > 1.4) {
			const mx = (e.source.x + e.target.x) / 2;
			const my = (e.source.y + e.target.y) / 2;
			ctx.fillStyle = cssVar('--fg-muted', '#aaa');
			ctx.font = `${10 / state.transform.scale}px monospace`;
			ctx.fillText(String(e.label).slice(0, 30), mx + 4, my - 4);
		}
	}

	function drawNode(n, isDim, isSearchDim) {
		const color = n.kind === 'hub' ? cssVar('--fg-muted', '#666')
			: n.kind === 'cluster' ? projectColor(n.project)
				: projectColor(n.project);

		let alpha = 1;
		if (isDim) alpha = 0.25;
		if (isSearchDim) alpha = Math.min(alpha, 0.15);

		ctx.globalAlpha = alpha;

		// Body
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(n.x, n.y, n.radius || 6, 0, Math.PI * 2);
		ctx.fill();

		// Selection ring
		if (state.selection?.id === n.id) {
			ctx.strokeStyle = cssVar('--accent-mint', '#56d4dd');
			ctx.lineWidth = 2;
			ctx.stroke();
		} else if (state.hover?.id === n.id) {
			ctx.strokeStyle = cssVar('--fg-bright', '#fff');
			ctx.lineWidth = 1;
			ctx.stroke();
		}

		// Link-buffer ring
		if (state.linkBuffer.find((b) => b.id === n.id)) {
			ctx.strokeStyle = cssVar('--accent-yellow', '#f2cc60');
			ctx.lineWidth = 2;
			ctx.stroke();
		}

		// Label when zoomed in (non-hub).
		if (n.kind !== 'hub' && state.transform.scale > 1.5) {
			ctx.fillStyle = cssVar('--fg-secondary', '#ccc');
			ctx.font = `${11 / state.transform.scale}px monospace`;
			const label = (n.label || '').slice(0, 24);
			ctx.fillText(label, n.x + (n.radius || 6) + 3, n.y + 4);
		} else if (n.kind === 'cluster') {
			// Cluster nodes always show their label.
			ctx.fillStyle = cssVar('--fg-bright', '#fff');
			ctx.font = `${12 / state.transform.scale}px monospace`;
			ctx.fillText(n.label || '', n.x + (n.radius || 6) + 4, n.y + 4);
		}

		ctx.globalAlpha = 1;
	}

	// ---- Interaction ----
	function setupCanvasInteraction() {
		refs.canvas.addEventListener('pointerdown', (e) => {
			refs.canvas.focus();
			const rect = refs.canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const node = nodeAtScreen(sx, sy);

			// Shift-click adds to link buffer.
			if (e.shiftKey && node && node.kind === 'pin') {
				if (state.linkBuffer.find((b) => b.id === node.id)) {
					state.linkBuffer = state.linkBuffer.filter((b) => b.id !== node.id);
				} else if (state.linkBuffer.length < 2) {
					state.linkBuffer.push(node);
				}
				updateLinkBufferUi();
				state.needsRedraw = true;
				return;
			}

			if (node) {
				if (node.kind === 'cluster') {
					// Drill-in: re-fetch only this project's pins and rebuild.
					state.clusteredForceLoad = true;
					state.project = node.project;
					if (refs.project) refs.project.value = state.project;
					rebuildGraph();
					return;
				}
				if (node.kind === 'pin') select(node);
				state.dragging = node;
				node.fx = node.x;
				node.fy = node.y;
				if (state.simulation) { state.simulation.alpha(0.3).restart(); }
				return;
			}

			// Empty canvas: deselect + start panning.
			select(null);
			state.panning = true;
			state.panStart = { x: e.clientX, y: e.clientY, tx: state.transform.tx, ty: state.transform.ty };
			refs.canvas.classList.add('cc-gr-dragging');
		});

		window.addEventListener('pointermove', (e) => {
			const rect = refs.canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;

			if (state.panning && state.panStart) {
				state.transform.tx = state.panStart.tx + (e.clientX - state.panStart.x);
				state.transform.ty = state.panStart.ty + (e.clientY - state.panStart.y);
				state.needsRedraw = true;
				return;
			}

			if (state.dragging) {
				const world = screenToWorld(sx, sy);
				state.dragging.fx = world.x;
				state.dragging.fy = world.y;
				state.needsRedraw = true;
				return;
			}

			const hovered = nodeAtScreen(sx, sy);
			if (hovered !== state.hover) {
				state.hover = hovered;
				state.needsRedraw = true;
				refs.canvas.style.cursor = hovered ? 'pointer' : 'grab';
			}
		});

		window.addEventListener('pointerup', () => {
			if (state.dragging) {
				state.dragging.fx = null;
				state.dragging.fy = null;
				state.dragging = null;
			}
			if (state.panning) {
				state.panning = false;
				state.panStart = null;
				refs.canvas.classList.remove('cc-gr-dragging');
			}
		});

		refs.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const rect = refs.canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const factor = e.deltaY > 0 ? 0.9 : 1.1;
			const next = Math.max(0.1, Math.min(8, state.transform.scale * factor));
			// zoom around cursor
			const wx = (sx - state.transform.tx) / state.transform.scale;
			const wy = (sy - state.transform.ty) / state.transform.scale;
			state.transform.scale = next;
			state.transform.tx = sx - wx * next;
			state.transform.ty = sy - wy * next;
			state.needsRedraw = true;
		}, { passive: false });

		refs.canvas.addEventListener('keydown', (e) => {
			const PAN = 40;
			const ZOOM_IN = 1.1, ZOOM_OUT = 0.9;
			if (e.key === '+' || e.key === '=') { zoomCentered(ZOOM_IN); e.preventDefault(); }
			else if (e.key === '-' || e.key === '_') { zoomCentered(ZOOM_OUT); e.preventDefault(); }
			else if (e.key === 'ArrowLeft') { state.transform.tx += PAN; state.needsRedraw = true; e.preventDefault(); }
			else if (e.key === 'ArrowRight') { state.transform.tx -= PAN; state.needsRedraw = true; e.preventDefault(); }
			else if (e.key === 'ArrowUp') { state.transform.ty += PAN; state.needsRedraw = true; e.preventDefault(); }
			else if (e.key === 'ArrowDown') { state.transform.ty -= PAN; state.needsRedraw = true; e.preventDefault(); }
			else if (e.key === 'Escape') { state.linkBuffer = []; updateLinkBufferUi(); select(null); }
		});
	}

	function zoomCentered(factor) {
		const cx = state.w / 2;
		const cy = state.h / 2;
		const next = Math.max(0.1, Math.min(8, state.transform.scale * factor));
		const wx = (cx - state.transform.tx) / state.transform.scale;
		const wy = (cy - state.transform.ty) / state.transform.scale;
		state.transform.scale = next;
		state.transform.tx = cx - wx * next;
		state.transform.ty = cy - wy * next;
		state.needsRedraw = true;
	}

	// ---- Selection + side panel ----
	function select(node) {
		state.selection = node && node.kind === 'pin' ? node : null;
		if (state.selection) showSidePanel(state.selection.ref);
		else hideSidePanel();
		updateSrOnlyHighlight();
		state.needsRedraw = true;
	}

	function showSidePanel(pin) {
		if (!pin) return;
		refs.sideEmpty.hidden = true;
		refs.sideDetail.hidden = false;

		refs.sideTitle.textContent = pin.chatTitle || 'pin';
		refs.sideModel.textContent = pin.model || 'unknown';
		refs.sideDate.textContent = formatDateShort(pin.createdAt);
		refs.sideTokens.textContent = formatCompact(pin.tokenCount || 0);
		refs.sideBody.textContent = pin.content || '';

		// Tags
		while (refs.sideTags.firstChild) refs.sideTags.removeChild(refs.sideTags.firstChild);
		for (const t of (pin.tags || [])) {
			const span = document.createElement('span');
			span.className = 'cc-gr-side-tag';
			span.textContent = `#${t}`;
			span.addEventListener('click', () => {
				refs.tag.value = t;
				onFilterChange();
			});
			refs.sideTags.appendChild(span);
		}

		// Linked pins
		populateSideLinks(pin);
	}

	function hideSidePanel() {
		refs.sideEmpty.hidden = false;
		refs.sideDetail.hidden = true;
	}

	function populateSideLinks(pin) {
		const list = refs.sideLinksList;
		while (list.firstChild) list.removeChild(list.firstChild);
		const incident = state.links.filter((l) => l.fromPinId === pin.id || l.toPinId === pin.id);
		if (incident.length === 0) {
			const li = document.createElement('li');
			li.style.color = 'var(--fg-comment)';
			li.style.fontStyle = 'italic';
			li.textContent = '// no manual links';
			list.appendChild(li);
			return;
		}
		const byPin = new Map(state.pins.map((p) => [p.id, p]));
		for (const link of incident) {
			const li = document.createElement('li');
			const labelInput = document.createElement('input');
			labelInput.className = 'cc-gr-side-link-label';
			labelInput.value = link.label || '';
			labelInput.placeholder = '(no label)';
			labelInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); labelInput.blur(); }
				if (e.key === 'Escape') { labelInput.value = link.label || ''; labelInput.blur(); }
			});
			labelInput.addEventListener('blur', async () => {
				link.label = labelInput.value;
				await putRow('links', link);
				state.needsRedraw = true;
			});

			const otherId = link.fromPinId === pin.id ? link.toPinId : link.fromPinId;
			const other = byPin.get(otherId);
			const target = document.createElement('span');
			target.className = 'cc-gr-side-link-target';
			target.textContent = `→ ${(other?.chatTitle || otherId.slice(0, 6)).slice(0, 28)}`;

			const del = document.createElement('button');
			del.className = 'cc-gr-side-link-delete';
			del.type = 'button';
			del.textContent = '✕';
			del.setAttribute('aria-label', 'Delete link');
			del.addEventListener('click', async () => {
				const snapshot = { ...link };
				await deleteRow('links', link.id);
				state.links = state.links.filter((l) => l.id !== link.id);
				rebuildGraph();
				showInlineToast('Link removed', {
					actionLabel: 'Undo',
					duration: 10000,
					onAction: async () => {
						await putRow('links', snapshot);
						state.links.push(snapshot);
						rebuildGraph();
					}
				});
			});

			li.appendChild(labelInput);
			li.appendChild(target);
			li.appendChild(del);
			list.appendChild(li);
		}
	}

	// ---- Filters ----
	function hydrateFilters() {
		// Project (chat) dropdown
		const seen = new Map();
		for (const p of state.pins) {
			if (p.conversationId && !seen.has(p.conversationId)) {
				seen.set(p.conversationId, p.chatTitle || p.conversationId.slice(0, 8));
			}
		}
		const projectEl = refs.project;
		while (projectEl.children.length > 1) projectEl.removeChild(projectEl.lastChild);
		for (const [id, title] of seen.entries()) {
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = title.length > 30 ? title.slice(0, 30) + '…' : title;
			projectEl.appendChild(opt);
		}
		projectEl.value = state.project;

		// Tag dropdown
		const tagCounts = new Map();
		for (const p of state.pins) for (const t of (p.tags || [])) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
		const tagsSorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 100);
		const tagEl = refs.tag;
		while (tagEl.children.length > 1) tagEl.removeChild(tagEl.lastChild);
		for (const [t, c] of tagsSorted) {
			const opt = document.createElement('option');
			opt.value = t;
			opt.textContent = `${t} · ${c}`;
			tagEl.appendChild(opt);
		}
		tagEl.value = state.tag;
	}

	function filteredPins() {
		return state.pins.filter((p) => {
			if (state.project && p.conversationId !== state.project) return false;
			if (state.tag && !(p.tags || []).includes(state.tag)) return false;
			return true;
		});
	}

	function onFilterChange() {
		state.search = refs.search.value.trim();
		state.project = refs.project.value;
		state.tag = refs.tag.value;
		rebuildGraph();
	}

	// ---- Graph build orchestration ----
	function rebuildGraph() {
		const visiblePins = filteredPins();
		const visibleLinks = state.links.filter((l) =>
			visiblePins.some((p) => p.id === l.fromPinId) &&
			visiblePins.some((p) => p.id === l.toPinId));

		// Clustered fallback?
		const shouldCluster = visiblePins.length > CLUSTER_THRESHOLD && !state.clusteredForceLoad;
		state.clustered = shouldCluster;
		refs.clusteredBanner.hidden = !shouldCluster;

		let built;
		if (shouldCluster) {
			built = graphEdges.buildClustered(visiblePins);
			refs.clusteredBanner.querySelector('#cc-gr-clustered-text').textContent =
				`Showing clustered overview (${visiblePins.length} pins). Click a project to drill in.`;
		} else {
			built = graphEdges.build(visiblePins, visibleLinks);
		}
		state.nodes = built.nodes;
		state.edges = built.edges;

		// Resolve edge source/target strings → node refs (force sim expects refs).
		const byId = new Map(state.nodes.map((n) => [n.id, n]));
		for (const e of state.edges) {
			if (typeof e.source === 'string') e.source = byId.get(e.source) || e.source;
			if (typeof e.target === 'string') e.target = byId.get(e.target) || e.target;
		}

		// Wire force sim.
		if (state.simulation) state.simulation.stop();
		state.simulation = buildSimulation(state.nodes, state.edges);
		state.settle = 0;
		state.needsRedraw = true;

		// Reduced motion: snap to layout.
		if (reduceMotionOn() && state.simulation) {
			state.simulation.tick(300);
			state.simulation.stop();
		}

		// Stats line
		refs.stats.textContent = state.search
			? `${countSearchMatches()} of ${state.nodes.filter((n) => n.kind === 'pin').length} match`
			: `${state.nodes.filter((n) => n.kind === 'pin').length} nodes · ${state.edges.length} edges`;

		// Meta line
		refs.meta.textContent = `${state.pins.length} pins total · ${state.links.length} manual link${state.links.length === 1 ? '' : 's'}`;

		// SR-only parallel structure
		buildSrOnly();
	}

	function countSearchMatches() {
		const q = state.search.toLowerCase();
		if (!q) return 0;
		let n = 0;
		for (const node of state.nodes) {
			if (node.kind !== 'pin') continue;
			const hay = `${node.ref?.content || ''}\n${node.ref?.chatTitle || ''}`.toLowerCase();
			if (hay.includes(q)) n++;
		}
		return n;
	}

	function buildSrOnly() {
		const ol = refs.sronly;
		while (ol.firstChild) ol.removeChild(ol.firstChild);
		for (const n of state.nodes) {
			if (n.kind !== 'pin') continue;
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = `${n.label || 'pin'} — ${formatCompact(n.ref?.tokenCount || 0)} tokens`;
			btn.dataset.nodeId = n.id;
			btn.addEventListener('focus', () => select(n));
			btn.addEventListener('click', () => select(n));
			li.appendChild(btn);
			ol.appendChild(li);
		}
	}

	function updateSrOnlyHighlight() {
		// Move focus to the selected node's parallel list item, if any.
		if (!state.selection) return;
		const btn = refs.sronly.querySelector(`button[data-node-id="${state.selection.id}"]`);
		if (btn && document.activeElement !== btn) {
			// Don't steal focus mid-pointer interaction; only on keyboard.
		}
		void btn;
	}

	// ---- Manual link UI ----
	function updateLinkBufferUi() {
		const count = state.linkBuffer.length;
		refs.linkBuffer.hidden = count === 0;
		if (count > 0) {
			refs.linkBufferText.textContent = `${count} node${count === 1 ? '' : 's'} in link buffer`;
			refs.linkCreateBtn.disabled = count !== 2;
		}
	}

	if (refs.linkCreateBtn) {
		refs.linkCreateBtn.addEventListener('click', () => {
			if (state.linkBuffer.length !== 2) return;
			state.pendingLinkOp = 'graph';
			refs.modalInput.value = '';
			refs.modal.hidden = false;
			setTimeout(() => refs.modalInput.focus(), 0);
		});
	}
	if (refs.linkClearBtn) {
		refs.linkClearBtn.addEventListener('click', () => {
			state.linkBuffer = [];
			updateLinkBufferUi();
			state.needsRedraw = true;
		});
	}

	// "Link from here…" in side panel
	if (refs.sideLinkFrom) {
		refs.sideLinkFrom.addEventListener('click', () => {
			if (!state.selection) return;
			// Seed the buffer with the current selection; user shift-clicks a second.
			state.linkBuffer = [state.selection];
			updateLinkBufferUi();
			state.needsRedraw = true;
			showInlineToast('Shift-click another node to complete the link.');
		});
	}

	function closeModal() {
		refs.modal.hidden = true;
		state.pendingLinkOp = null;
	}

	if (refs.modalClose) refs.modalClose.addEventListener('click', closeModal);
	if (refs.modalCancel) refs.modalCancel.addEventListener('click', closeModal);
	if (refs.modalBackdrop) refs.modalBackdrop.addEventListener('click', closeModal);

	if (refs.modalCreate) {
		refs.modalCreate.addEventListener('click', async () => {
			if (state.linkBuffer.length !== 2) { closeModal(); return; }
			const [a, b] = state.linkBuffer;
			const label = refs.modalInput.value.trim();
			const newLink = {
				id: crypto.randomUUID(),
				fromPinId: a.ref?.id || a.id,
				toPinId: b.ref?.id || b.id,
				label,
				createdAt: Date.now(),
				weight: 1,
				kind: 'manual'
			};
			await putRow('links', newLink);
			state.links.push(newLink);
			state.linkBuffer = [];
			updateLinkBufferUi();
			closeModal();
			rebuildGraph();
			showInlineToast(label ? `Linked: ${label}` : 'Linked');
		});
	}

	// ---- Side actions ----
	if (refs.sideClose) refs.sideClose.addEventListener('click', () => select(null));
	if (refs.sideCopy) {
		refs.sideCopy.addEventListener('click', async () => {
			if (!state.selection?.ref) return;
			try { await navigator.clipboard.writeText(state.selection.ref.content || ''); showInlineToast('Copied'); }
			catch { showInlineToast('Clipboard permission denied'); }
		});
	}
	if (refs.sideOpenChat) {
		refs.sideOpenChat.addEventListener('click', () => {
			if (!state.selection?.ref?.sourceUrl) return;
			try { tabsApi?.create?.({ url: state.selection.ref.sourceUrl }); }
			catch { /* noop */ }
		});
	}
	if (refs.sideUnpin) {
		refs.sideUnpin.addEventListener('click', async () => {
			if (!state.selection?.ref) return;
			const ok = window.confirm('Unpin this pin? Its manual links will also be removed.');
			if (!ok) return;
			const pinId = state.selection.ref.id;
			await deleteRow('pins', pinId);
			// Cascade-delete links.
			const orphaned = state.links.filter((l) => l.fromPinId === pinId || l.toPinId === pinId);
			for (const l of orphaned) await deleteRow('links', l.id);
			state.pins = state.pins.filter((p) => p.id !== pinId);
			state.links = state.links.filter((l) => l.fromPinId !== pinId && l.toPinId !== pinId);
			select(null);
			rebuildGraph();
			showInlineToast('Unpinned');
		});
	}

	// ---- Cluster banner force-load ----
	if (refs.clusteredForce) {
		refs.clusteredForce.addEventListener('click', () => {
			const ok = window.confirm('Force-load all nodes? With >2000 pins, performance may degrade.');
			if (!ok) return;
			state.clusteredForceLoad = true;
			rebuildGraph();
		});
	}

	// ---- Toolbar ----
	let searchTimer = null;
	if (refs.search) {
		refs.search.addEventListener('input', () => {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(onFilterChange, 150);
		});
	}
	refs.project?.addEventListener('change', onFilterChange);
	refs.tag?.addEventListener('change', onFilterChange);
	refs.reset?.addEventListener('click', () => {
		state.transform = { tx: state.w / 2, ty: state.h / 2, scale: 1 };
		state.needsRedraw = true;
		if (state.simulation) { state.simulation.alpha(0.3).restart(); state.settle = 0; }
	});
	refs.freeze?.addEventListener('click', () => {
		const cur = refs.freeze.getAttribute('aria-pressed') === 'true';
		refs.freeze.setAttribute('aria-pressed', String(!cur));
	});

	if (refs.back) {
		refs.back.addEventListener('click', (e) => {
			e.preventDefault();
			try { runtime?.openOptionsPage?.(); } catch { /* noop */ }
			// No popup-open API; close this tab — user re-opens popup via toolbar.
			try { window.close(); } catch { /* noop */ }
		});
	}

	// ---- Inline toast ----
	function showInlineToast(text, opts = {}) {
		const layer = (() => {
			let l = document.getElementById('cc-gr-toasts');
			if (l) return l;
			l = document.createElement('div');
			l.id = 'cc-gr-toasts';
			l.style.cssText = 'position:fixed;bottom:50px;left:50%;transform:translateX(-50%);z-index:1100;display:flex;flex-direction:column;gap:6px;pointer-events:none;';
			document.body.appendChild(l);
			return l;
		})();
		const node = document.createElement('div');
		node.setAttribute('role', 'status');
		node.style.cssText = 'background:var(--bg-panel);color:var(--fg-bright);border:1px solid var(--accent-mint);padding:6px 14px;font-size:11px;font-family:var(--font-code);pointer-events:auto;display:flex;align-items:center;gap:8px;';
		const span = document.createElement('span');
		span.textContent = text;
		node.appendChild(span);
		const remove = () => { try { node.remove(); } catch { /* noop */ } };
		if (opts.actionLabel && typeof opts.onAction === 'function') {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = opts.actionLabel;
			btn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--accent-mint);padding:2px 8px;font-family:var(--font-code);font-size:10px;cursor:pointer;';
			btn.addEventListener('click', () => { try { opts.onAction(); } catch { /* noop */ } remove(); });
			node.appendChild(btn);
		}
		layer.appendChild(node);
		setTimeout(remove, opts.duration || 2000);
	}

	// ---- Helpers ----
	function formatCompact(v) {
		if (typeof v !== 'number') return '—';
		if (v >= 1000) return `${(Math.round(v / 100) / 10).toLocaleString()}k`;
		return v.toLocaleString();
	}

	function formatDateShort(ts) {
		if (typeof ts !== 'number') return '—';
		try { return new Date(ts).toISOString().slice(0, 10); } catch { return '—'; }
	}

	// ---- Theme propagation ----
	// Re-paint when chrome.storage.session signals a theme change. Cheap: just
	// invalidate so the next RAF re-reads CSS vars.
	const storage = globalThis.browser?.storage || globalThis.chrome?.storage;
	if (storage?.onChanged?.addListener) {
		storage.onChanged.addListener(() => { state.needsRedraw = true; });
	}

	// ---- Boot ----
	async function boot() {
		resizeCanvas();
		window.addEventListener('resize', () => resizeCanvas());
		setupCanvasInteraction();

		state.pins = (await readAll('pins')) || [];
		state.links = (await readAll('links')) || [];

		hydrateFilters();

		// Center the view initially.
		state.transform.tx = state.w / 2;
		state.transform.ty = state.h / 2;

		rebuildGraph();

		// Render loop.
		const tickFn = () => {
			runSimulationLoop();
			if (state.needsRedraw) {
				draw();
				state.needsRedraw = false;
			}
			requestAnimationFrame(tickFn);
		};
		requestAnimationFrame(tickFn);
	}

	boot();
})();
