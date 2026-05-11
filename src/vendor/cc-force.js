// [SECURITY] In-house force-directed layout. Mirrors the subset of the
// d3-force API the graph view actually uses, so we can swap to d3-force later
// without rewriting call sites. No dependencies; no remote fetches.
//
// Implemented forces:
//   - link          (spring between connected nodes)
//   - manyBody      (Coulomb-like repulsion, O(n²); fine to 2000)
//   - center        (gentle gravity to a point)
//   - collide       (radius-based separation, post-position adjust)
//   - x / y         (positional pull, used by clustered fallback)
//
// Integration uses Verlet-style updates with velocity decay, matching d3's
// `velocityDecay` behavior. Alpha cooling matches `forceSimulation`'s defaults
// (alphaDecay = 1 - alphaMin^(1/300)).
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// ---------------------------------------------------------------------
	// Force factories
	// ---------------------------------------------------------------------

	function forceLink(links) {
		let _nodes = [];
		let _links = Array.isArray(links) ? links : [];
		let _distance = () => 60;
		let _strength = null;
		const id = (n) => n.id;
		let _idAccessor = id;

		function initialize() {
			// Resolve string ids to node references.
			const byId = new Map();
			for (const n of _nodes) byId.set(_idAccessor(n), n);
			for (const link of _links) {
				if (typeof link.source !== 'object' || link.source === null) {
					link.source = byId.get(link.source) || null;
				}
				if (typeof link.target !== 'object' || link.target === null) {
					link.target = byId.get(link.target) || null;
				}
			}
		}

		function force(alpha) {
			for (const link of _links) {
				const s = link.source, t = link.target;
				if (!s || !t) continue;
				const dx = (t.x + t.vx) - (s.x + s.vx);
				const dy = (t.y + t.vy) - (s.y + s.vy);
				const dist = Math.sqrt(dx * dx + dy * dy) || 1;
				const desired = typeof _distance === 'function' ? _distance(link) : _distance;
				const k = (typeof _strength === 'function'
					? _strength(link)
					: (_strength != null ? _strength : 0.7)) * alpha;
				const diff = (dist - desired) / dist * k;
				const sb = 0.5, tb = 0.5; // equal bias for unweighted graphs
				s.vx += dx * diff * tb;
				s.vy += dy * diff * tb;
				t.vx -= dx * diff * sb;
				t.vy -= dy * diff * sb;
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; initialize(); };
		force.links = function (l) { if (arguments.length) { _links = l; initialize(); return force; } return _links; };
		force.distance = (d) => { _distance = typeof d === 'function' ? d : () => d; return force; };
		force.strength = (s) => { _strength = s; return force; };
		force.id = (fn) => { _idAccessor = fn; initialize(); return force; };
		return force;
	}

	function forceManyBody() {
		let _nodes = [];
		let _strength = () => -200;
		let _theta = 0.9; // unused; reserved for Barnes-Hut later
		const _distanceMax2 = Infinity;

		function force(alpha) {
			const n = _nodes.length;
			for (let i = 0; i < n; i++) {
				const a = _nodes[i];
				const sa = (typeof _strength === 'function' ? _strength(a, i, _nodes) : _strength) * alpha;
				for (let j = i + 1; j < n; j++) {
					const b = _nodes[j];
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					let l2 = dx * dx + dy * dy;
					if (l2 === 0) { l2 = 0.01; dx = 0.01; dy = 0; }
					if (l2 > _distanceMax2) continue;
					const sb = (typeof _strength === 'function' ? _strength(b, j, _nodes) : _strength) * alpha;
					const force = (sa + sb) / l2;
					a.vx += dx * force * 0.5;
					a.vy += dy * force * 0.5;
					b.vx -= dx * force * 0.5;
					b.vy -= dy * force * 0.5;
				}
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; };
		force.strength = (s) => { _strength = typeof s === 'function' ? s : () => s; return force; };
		force.theta = (t) => { _theta = t; return force; };
		return force;
	}

	function forceCenter(x = 0, y = 0) {
		let _nodes = [];
		let _x = x, _y = y;
		let _strength = 1;

		function force() {
			if (_nodes.length === 0) return;
			let sx = 0, sy = 0;
			for (const n of _nodes) { sx += n.x; sy += n.y; }
			sx = sx / _nodes.length - _x;
			sy = sy / _nodes.length - _y;
			for (const n of _nodes) {
				n.x -= sx * _strength;
				n.y -= sy * _strength;
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; };
		force.x = (v) => { _x = v; return force; };
		force.y = (v) => { _y = v; return force; };
		force.strength = (s) => { _strength = s; return force; };
		return force;
	}

	function forceCollide(radius = 5) {
		let _nodes = [];
		let _radius = typeof radius === 'function' ? radius : () => radius;
		let _strength = 1;

		function force() {
			const n = _nodes.length;
			for (let i = 0; i < n; i++) {
				const a = _nodes[i];
				const ra = _radius(a, i, _nodes);
				for (let j = i + 1; j < n; j++) {
					const b = _nodes[j];
					let dx = (b.x + b.vx) - (a.x + a.vx);
					let dy = (b.y + b.vy) - (a.y + a.vy);
					const rb = _radius(b, j, _nodes);
					const r = ra + rb;
					const l2 = dx * dx + dy * dy;
					if (l2 < r * r) {
						const l = Math.sqrt(l2) || 0.01;
						const overlap = ((r - l) / l) * _strength;
						const m = rb / r;
						a.vx -= dx * overlap * m;
						a.vy -= dy * overlap * m;
						b.vx += dx * overlap * (1 - m);
						b.vy += dy * overlap * (1 - m);
					}
				}
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; };
		force.radius = (r) => { _radius = typeof r === 'function' ? r : () => r; return force; };
		force.strength = (s) => { _strength = s; return force; };
		return force;
	}

	function forceX(x) {
		let _nodes = [];
		let _x = typeof x === 'function' ? x : () => (typeof x === 'number' ? x : 0);
		let _strength = () => 0.1;

		function force(alpha) {
			for (let i = 0; i < _nodes.length; i++) {
				const n = _nodes[i];
				const tx = _x(n, i, _nodes);
				const s = typeof _strength === 'function' ? _strength(n, i, _nodes) : _strength;
				n.vx += (tx - n.x) * s * alpha;
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; };
		force.x = (v) => { _x = typeof v === 'function' ? v : () => v; return force; };
		force.strength = (s) => { _strength = typeof s === 'function' ? s : () => s; return force; };
		return force;
	}

	function forceY(y) {
		let _nodes = [];
		let _y = typeof y === 'function' ? y : () => (typeof y === 'number' ? y : 0);
		let _strength = () => 0.1;

		function force(alpha) {
			for (let i = 0; i < _nodes.length; i++) {
				const n = _nodes[i];
				const ty = _y(n, i, _nodes);
				const s = typeof _strength === 'function' ? _strength(n, i, _nodes) : _strength;
				n.vy += (ty - n.y) * s * alpha;
			}
		}

		force.initialize = (nodes) => { _nodes = nodes; };
		force.y = (v) => { _y = typeof v === 'function' ? v : () => v; return force; };
		force.strength = (s) => { _strength = typeof s === 'function' ? s : () => s; return force; };
		return force;
	}

	// ---------------------------------------------------------------------
	// Simulation
	// ---------------------------------------------------------------------

	function forceSimulation(nodes = []) {
		const _nodes = nodes;
		const _forces = new Map();
		let _alpha = 1;
		let _alphaMin = 0.001;
		let _alphaDecay = 1 - Math.pow(_alphaMin, 1 / 300);
		let _alphaTarget = 0;
		let _velocityDecay = 0.6;
		let _stopped = false;
		let _tickFn = null;
		let _endFn = null;

		function seedPositions() {
			const radius = 30;
			for (let i = 0; i < _nodes.length; i++) {
				const n = _nodes[i];
				if (typeof n.x !== 'number') {
					const angle = i * 2.4; // golden-angle-ish spiral
					const r = radius * Math.sqrt(i + 1);
					n.x = r * Math.cos(angle);
					n.y = r * Math.sin(angle);
				}
				if (typeof n.vx !== 'number') n.vx = 0;
				if (typeof n.vy !== 'number') n.vy = 0;
			}
		}

		function applyForces() {
			for (const f of _forces.values()) {
				if (typeof f === 'function') f(_alpha);
			}
		}

		function integrate() {
			for (const n of _nodes) {
				if (typeof n.fx === 'number') { n.x = n.fx; n.vx = 0; }
				else { n.vx *= _velocityDecay; n.x += n.vx; }
				if (typeof n.fy === 'number') { n.y = n.fy; n.vy = 0; }
				else { n.vy *= _velocityDecay; n.y += n.vy; }
			}
		}

		function initForces() {
			for (const f of _forces.values()) {
				if (typeof f?.initialize === 'function') f.initialize(_nodes);
			}
		}

		seedPositions();

		const sim = {
			tick(iters = 1) {
				for (let i = 0; i < iters; i++) {
					_alpha += (_alphaTarget - _alpha) * _alphaDecay;
					applyForces();
					integrate();
					if (typeof _tickFn === 'function') _tickFn();
					if (_alpha < _alphaMin) {
						if (typeof _endFn === 'function') _endFn();
						break;
					}
				}
				return sim;
			},
			nodes() { return _nodes; },
			force(name, force) {
				if (force === undefined) return _forces.get(name);
				if (force === null) _forces.delete(name);
				else {
					_forces.set(name, force);
					if (typeof force.initialize === 'function') force.initialize(_nodes);
				}
				return sim;
			},
			alpha(v) { if (v === undefined) return _alpha; _alpha = v; return sim; },
			alphaMin(v) { if (v === undefined) return _alphaMin; _alphaMin = v; return sim; },
			alphaDecay(v) { if (v === undefined) return _alphaDecay; _alphaDecay = v; return sim; },
			alphaTarget(v) { if (v === undefined) return _alphaTarget; _alphaTarget = v; return sim; },
			velocityDecay(v) { if (v === undefined) return _velocityDecay; _velocityDecay = v; return sim; },
			restart() { _stopped = false; if (_alpha < 0.01) _alpha = 0.3; return sim; },
			stop() { _stopped = true; return sim; },
			isStopped() { return _stopped; },
			on(event, fn) {
				if (event === 'tick') _tickFn = fn;
				else if (event === 'end') _endFn = fn;
				return sim;
			},
			/**
			 * Find the nearest node to (x, y) within `radius`. Linear scan.
			 */
			find(x, y, radius = Infinity) {
				let best = null;
				let bestDist = radius;
				for (const n of _nodes) {
					const dx = n.x - x;
					const dy = n.y - y;
					const d = Math.sqrt(dx * dx + dy * dy);
					if (d < bestDist) { bestDist = d; best = n; }
				}
				return best;
			},
			reinitForces() { initForces(); return sim; }
		};

		return sim;
	}

	CC.force = {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCenter,
		forceCollide,
		forceX,
		forceY
	};
})();
