import { position } from './graph.mjs';
import { laneCount } from './traffic-model.mjs';
import { orientedBodiesOverlap } from '../../body-geometry.mjs';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const close = (a, b, extra = 0) => distance(a, b) < (Math.hypot(a.length, a.width) + Math.hypot(b.length, b.width)) / 2 + extra;
const clearance = 0.3;

/** A last resort for a verified stationary cycle, not a second right-of-way
 * controller. One driver makes a checked pocket for one blocked neighbour;
 * the existing signals, crossings, junctions and parking groups still decide
 * who can proceed. Geometry is shared with the fire-engine collision model.
 */
export class CooperativeManoeuvres {
  constructor(simulation) {
    this.sim = simulation;
    this.states = new Map();
    this.owners = new Map();
    this.cooldown = new Map();
    this.gaps = new Map();
    this.nextReview = 12;
    this.started = 0;
    this.completed = 0;
    this.aborted = 0;
  }
  active(car) { return this.states.has(car.id); }
  lateral(car, edge, normal, factor = 1, alpha = 1) {
    const state = this.states.get(car.id);
    const offset = car.cooperativeOffsetOverride ?? (state ? state.previousOffset +
      (state.offset - state.previousOffset) * clamp(alpha, 0, 1) : 0);
    if (state && state.phase !== 'creeping') {
      // A resident departure can rebuild the parking layout while this car is
      // stationary. Anchor its existing lane position instead of teleporting
      // with that changed baseline; merge to the new normal position later.
      if (!state.baselines.has(edge.id)) state.baselines.set(edge.id, { original: normal * factor, current: normal * factor });
      const baseline = state.baselines.get(edge.id); baseline.current = normal * factor;
      return (baseline.original + offset) / Math.max(0.1, factor);
    }
    return normal + offset / Math.max(0.1, factor);
  }
  body(car, q = car.q, offset = this.states.get(car.id)?.offset || 0) {
    return this.sim.emergency.body({ ...car, cooperativeOffsetOverride: offset }, q);
  }
  obstacles() {
    return [...(this.sim.emergency.obstacleProvider?.() || []),
      ...this.sim.emergency.reservedBodies(), ...(this.sim.emergency.player ? [this.sim.emergency.player] : [])];
  }
  safePose(car, q, offset, bodies, obstacles, ignore = null) {
    const candidate = this.body(car, q, offset);
    if (!this.sim.emergency.onSurface(car, candidate, q)) return false;
    for (const other of [...bodies.values(), ...obstacles]) {
      if (other.ownerId === car.id || other.ownerId === ignore || !close(candidate, other, clearance)) continue;
      if (orientedBodiesOverlap(candidate, other, clearance)) return false;
    }
    return true;
  }
  sweep(car, q, offset, bodies, obstacles) {
    const from = this.states.get(car.id)?.offset || 0;
    const n = Math.max(1, Math.ceil((Math.abs(q - car.q) + Math.abs(offset - from)) / 0.25));
    for (let i = 1; i <= n; i++) if (!this.safePose(car, car.q + (q - car.q) * i / n,
      from + (offset - from) * i / n, bodies, obstacles)) return false;
    return true;
  }
  controls(car, horizon = 25) {
    if (car.roadStop && !car.roadStop.done &&
      (car.roadStop.remaining !== null || car.roadStop.q - car.q < horizon)) return true;
    for (let i = car.index; i < car.route.length && car.offsets[i] - car.q < horizon; i++) {
      const edge = this.sim.data.edges[car.route[i]];
      const crossing = car.offsets[i] + (this.sim.crossingStop?.(car, edge) ?? Infinity) - car.q;
      if (crossing < horizon) return true;
      if (car.offsets[i + 1] - car.q < horizon && ['red', 'amber'].includes(this.sim.signal(edge))) return true;
    }
    return false;
  }
  eligible(car, owner = true, minimumStop = 15) {
    const edge = this.sim.data.edges[car.route[car.index]];
    const searchingNearBay = car.parkingSearch?.target && car.parkingSearch.target.q - car.q < 35;
    return (owner ? car.type === 'car' : ['car', 'van', 'bus', 'lorry'].includes(car.type)) &&
      car.v < 0.2 && car.stopped >= minimumStop && !car.parked && !car.parkingActivity &&
      !searchingNearBay && !car.turnaround && !car.busPass && !car.stationMovement &&
      !this.active(car) && ![...this.states.values()].some(s => s.peer === car) &&
      !this.sim.emergency.isYielding(car) && !this.sim.emergency.managesMotion(car) &&
      !this.body(car).station && !this.controls(car) && laneCount(edge) === 1 &&
      !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(edge.tags.highway);
  }
  blockers(car, occupied, stopped, bodies) {
    const result = new Set(), lead = this.sim.leader(car, occupied);
    if (lead.car && lead.gap <= car.minGap + 1) result.add(lead.car);
    for (const p of car.parkingPassages || []) {
      const group = this.sim.parking.controller(p);
      if (!group.narrow || group.claims.has(car.id) || p.entry - car.q > car.minGap + 3 || car.q > p.entry) continue;
      for (const claim of group.claims.values()) if (claim.direction !== p.direction) result.add(claim.car);
    }
    for (let i = car.index; i < car.route.length - 1 && car.offsets[i + 1] - car.q < car.minGap + 4; i++) {
      const edge = this.sim.data.edges[car.route[i]], next = this.sim.data.edges[car.route[i + 1]];
      if (!this.sim.isJunction(edge, next)) continue;
      const claims = this.sim.reservations.get(edge.to) || [];
      if (!claims.some(r => r.car === car)) for (const claim of claims)
        if (!this.sim.compatible({ car, edge: edge.id, next: next.id }, claim)) result.add(claim.car);
      if (lead.car && lead.gap < car.offsets[i + 1] - car.q + car.length + car.minGap + 1) result.add(lead.car);
    }
    // A shared narrow lane can also contain two opposed stopped noses. This
    // geometric case is distinct from ordinary following on opposite lanes.
    if (!result.size) {
      const current = bodies.get(car.id);
      for (const other of stopped) {
        if (other === car) continue;
        const body = bodies.get(other.id);
        if (current.layer !== body.layer || distance(current, body) > car.length + other.length + 10 ||
          Math.cos(current.angle - body.angle) > -0.5) continue;
        for (let d = 0.5; d <= Math.min(8, car.offsets.at(-1) - car.q); d += 0.5)
          if (orientedBodiesOverlap(this.body(car, car.q + d), body, clearance)) { result.add(other); break; }
      }
    }
    return [...result].filter(c => stopped.includes(c));
  }
  cycleFrom(start, links) {
    const visit = (car, trail) => {
      for (const next of links.get(car) || []) {
        if (next === start && trail.length > 1) return trail;
        if (trail.length < 5 && !trail.includes(next)) { const found = visit(next, [...trail, next]); if (found) return found; }
      }
      return null;
    };
    return visit(start, [start]);
  }
  peerPath(owner, peer, q, offset, bodies, obstacles) {
    const tucked = this.body(owner, q, offset), peerBody = this.body(peer);
    const length = Math.min(55, distance(tucked, peerBody) + owner.length + peer.length + 6,
      peer.offsets.at(-1) - peer.q);
    if (length < 4) return null;
    let passed = false, goal = peer.q;
    const candidates = new Map(bodies); candidates.set(owner.id, tucked);
    // The peer is precisely who this temporary pocket is being cleared for.
    // Re-test the owner's actual tucked hull, not its soon-to-release sweep.
    const peerObstacles = obstacles.filter(body => body.ownerId !== owner.id || body.kind !== 'cooperative manoeuvre');
    for (let d = 0; d <= length; d += 0.5) {
      if (!this.safePose(peer, peer.q + d, 0, candidates, peerObstacles)) return null;
      const body = this.body(peer, peer.q + d);
      const ahead = (body.x - tucked.x) * Math.cos(body.angle) + (body.y - tucked.y) * Math.sin(body.angle);
      if (ahead > (peer.length + owner.length) / 2 + 2) { passed = true; goal = peer.q + d; break; }
    }
    return passed ? goal : null;
  }
  planPocket(car, peer, bodies, obstacles) {
    if (this.sim.emergency.clearingJunction(car)) return null;
    const edge = this.sim.data.edges[car.route[car.index]], start = car.offsets[car.index];
    const available = Math.min(10, car.q - start - car.length - 2);
    const b = position(edge, car.d);
    for (let back = 0; back <= Math.max(0, available); back += 2) {
      const a = position(edge, Math.max(0, car.d - back - car.length));
      if (back > 0 && a.dx * b.dx + a.dy * b.dy < 0.99) continue;
      const q = car.q - back, body = this.body(car, q);
      const maximum = this.sim.emergency.targetOffset(car, body, q);
      if (maximum < 0.8 || !this.sweep(car, q, 0, bodies, obstacles)) continue;
      for (let offset = 0.75; offset <= maximum + 0.001; offset += 0.5) {
        let clear = true;
        for (let at = 0.25; at <= offset; at += 0.25)
          if (!this.safePose(car, q, at, bodies, obstacles)) { clear = false; break; }
        if (!clear) break;
        const goal = this.peerPath(car, peer, q, offset, bodies, obstacles);
        if (goal !== null) return { q, offset, goal };
      }
    }
    return null;
  }
  waitingArrivals(owner, occupied) {
    const waiting = [];
    for (const [node, claims] of this.sim.reservations) for (const claim of claims) {
      if (claim.car !== owner || owner.q < claim.crossing || owner.q - owner.length > claim.crossing + 0.5) continue;
      for (const peer of this.sim.cars) {
        if (peer === owner || !this.eligible(peer, false, 2)) continue;
        for (let i = peer.index; i < peer.route.length - 1 && peer.offsets[i + 1] - peer.q < peer.minGap + 3; i++) {
          const edge = this.sim.data.edges[peer.route[i]], next = this.sim.data.edges[peer.route[i + 1]];
          if (edge.to !== node || !this.sim.isJunction(edge, next) || claims.some(r => r.car === peer)) continue;
          const leader = this.sim.leader(peer, occupied);
          if (leader.car && leader.frontGap < peer.offsets[i + 1] - peer.q - 0.05) continue;
          const request = { car: peer, edge: edge.id, next: next.id, fromLane: peer.lanes[i], lane: peer.lanes[i + 1] };
          if (!this.sim.compatible(request, claim)) waiting.push({ peer, claim });
        }
      }
    }
    return waiting.sort((a, b) => a.peer.id - b.peer.id);
  }
  planCreep(car, occupied, bodies, obstacles, requiredClaim = null, peer = null) {
    const lead = this.sim.leader(car, occupied);
    if (!lead.car || lead.car.v > 0.2 || lead.gap < 1 || lead.gap > car.minGap + 1) return null;
    const q = car.q + Math.min(3, lead.gap - 0.7);
    const clearedClaims = [...this.sim.reservations.values()].flat().filter(r => r.car === car && (!requiredClaim || r === requiredClaim) &&
      car.q >= r.crossing && car.q - car.length <= r.crossing + 0.5 && q - car.length > r.crossing + 0.65);
    if (!clearedClaims.length || q > car.offsets[car.index + 1] - 0.1 || !this.sweep(car, q, 0, bodies, obstacles)) return null;
    // The goal is to free these real tail claims. The optional farther target
    // supplies braking room; a conservative physical cap can stop a few cm
    // short of that target after the entire junction is already clear.
    let tailClearQ = Math.max(...clearedClaims.map(r => r.crossing + car.length + 0.55)), peerGoal = 0;
    if (peer) {
      let safeClearance = null;
      for (let at = tailClearQ; at <= q + 1e-7; at = Math.min(q, at + 0.1)) {
        const goal = this.peerPath(car, peer, at, 0, bodies, obstacles);
        if (goal !== null) { safeClearance = at; peerGoal = goal; break; }
        if (at >= q) break;
      }
      if (safeClearance === null) return null;
      tailClearQ = safeClearance;
    }
    return { q, tailClearQ, offset: 0, goal: peerGoal, mode: 'creep' };
  }
  start(car, peer, plan) {
    const state = { car, peer, route: car.route, peerRoute: peer.route, originalQ: car.q,
      q: plan.q, targetOffset: plan.offset, peerGoal: plan.goal, offset: 0, previousOffset: 0,
      tailClearQ: plan.tailClearQ ?? plan.q,
      phase: plan.mode === 'creep' ? 'creeping' : plan.q < car.q ? 'backing-up' : 'pulling-in', reversing: false, active: true,
      clear: false, began: this.sim.time, blocked: 0, baselines: new Map() };
    this.states.set(car.id, state); this.owners.set(car.id, car); car.cooperativeManoeuvre = state; this.started++;
    return state;
  }
  returnOffset(state) {
    const body = this.body(state.car), baseline = state.baselines.get(body.edge.id);
    return baseline ? baseline.current - baseline.original : 0;
  }
  suspendsParking(car) { return Boolean(this.states.get(car.id)?.clear); }
  managesMotion(car) { const state = this.states.get(car.id); return Boolean(state && state.phase !== 'creeping'); }
  following(car) { return this.states.get(car.id)?.phase === 'creeping' ? { ...car, minGap: 0.6, headway: 0.8 } : car; }
  speed(car) { return this.states.get(car.id)?.phase === 'creeping' ? 1 : Infinity; }
  indicator(car) {
    const state = this.states.get(car.id);
    if (!state) return 0;
    if (state.phase === 'pulling-in' || state.phase === 'backing-up') return -1;
    if (state.phase === 'returning') return -Math.sign(this.returnOffset(state) - state.offset);
    return 0;
  }
  skipsLeader(car, other) {
    const state = this.states.get(other.id);
    if (!state?.clear || state.peer !== car || state.phase !== 'waiting') return false;
    // Even a designated pass loses its exception if its live route/pose has
    // changed. Current physical caps still check the full displaced body.
    return car.route === state.peerRoute && !orientedBodiesOverlap(this.body(car), this.body(other), clearance);
  }
  returnReady(state, bodies, obstacles) {
    if (state.peer.route === state.peerRoute && this.sim.cars.includes(state.peer) && state.peer.q < state.peerGoal &&
      this.sim.time - state.began < 35) return false;
    for (const p of state.car.parkingPassages || []) {
      const group = this.sim.parking.controller(p);
      if (group.narrow && state.car.q > p.entry && state.car.q - state.car.length < p.exit + 2 &&
        [...group.claims.values()].some(r => r.car !== state.car && r.direction !== p.direction)) return false;
    }
    return this.sweep(state.car, state.car.q, this.returnOffset(state), bodies, obstacles);
  }
  finish(state) {
    this.states.delete(state.car.id); this.owners.delete(state.car.id); delete state.car.cooperativeManoeuvre;
    this.cooldown.set(state.car.id, this.sim.time + 45); this.cooldown.set(state.peer.id, this.sim.time + 20);
    const progressed = state.phase === 'creeping' ? state.car.q >= state.tailClearQ - 1e-7 :
      !this.sim.cars.includes(state.peer) || state.peer.route === state.peerRoute && state.peer.q >= state.peerGoal;
    if (progressed) this.completed++; else this.aborted++;
  }
  update(dt, occupied) {
    this.gaps.clear();
    const alive = new Set(this.sim.cars);
    for (const [id, state] of this.states) if (!alive.has(state.car)) {
      this.states.delete(id); this.owners.delete(id); delete state.car.cooperativeManoeuvre;
    }
    if (!this.states.size && this.sim.time < this.nextReview) return;
    const bodies = new Map(this.sim.cars.map(car => [car.id, this.body(car)])), obstacles = this.obstacles();
    this.bodySnapshot = bodies; this.obstacleSnapshot = obstacles;
    for (const state of this.states.values()) {
      const car = state.car; state.previousOffset = state.offset; state.reversing = false;
      if (state.phase === 'creeping') {
        if (car.q >= state.tailClearQ - 1e-7 || this.sim.time - state.began > 8 || this.controls(car)) this.finish(state);
        continue;
      }
      if (car.route !== state.route) { state.phase = 'returning'; state.q = car.q; }
      if (state.phase === 'backing-up') {
        const q = Math.max(state.q, car.q - dt);
        if (this.sweep(car, q, state.offset, bodies, obstacles)) {
          this.sim.emergency.commitPosition(car, q); state.reversing = true; state.blocked = 0;
          if (q <= state.q + 1e-7) state.phase = 'pulling-in';
        } else state.blocked += dt;
      } else if (state.phase === 'pulling-in' || state.phase === 'returning') {
        const target = state.phase === 'returning' ? this.returnOffset(state) : state.targetOffset;
        const offset = state.offset + clamp(target - state.offset, -dt, dt);
        if (this.sweep(car, car.q, offset, bodies, obstacles)) {
          state.offset = offset; state.blocked = 0;
          if (Math.abs(offset - target) < 1e-7) {
            if (state.phase === 'returning') this.finish(state);
            else {
              const goal = this.peerPath(car, state.peer, car.q, state.offset, bodies, obstacles);
              if (goal === null) state.phase = 'returning';
              else { state.peerGoal = goal; state.phase = 'waiting'; state.clear = true; }
            }
          }
        } else state.blocked += dt;
      } else if (state.phase === 'waiting' && this.returnReady(state, bodies, obstacles)) {
        state.phase = 'returning';
        // Regain the ordinary passage before moving back into it. The group
        // was checked above; its existing opposing bodies keep priority.
        this.sim.parking.claimSpawn(car); state.clear = false;
      }
      if (state.blocked > 3 && !state.clear) state.phase = 'returning';
      car.v = 0; bodies.set(car.id, this.body(car));
    }
    if (this.states.size >= 3 || this.sim.time < this.nextReview) return;
    this.nextReview = this.sim.time + 2;
    if (this.sim.emergency.player?.siren) return;
    const stopped = this.sim.cars.filter(c => this.eligible(c, false) && (this.cooldown.get(c.id) || 0) <= this.sim.time &&
      [...this.states.values()].every(s => distance(bodies.get(c.id), bodies.get(s.car.id)) > 100));
    // A stopped bus beyond a junction need not form a circular wait. If this
    // car's tail alone holds an incompatible arrival, a proven tiny squeeze
    // can free that crossing while continuing to respect the stopped leader.
    for (const car of stopped.filter(c => c.type === 'car').sort((a, b) => a.id - b.id)) {
      for (const { peer, claim } of this.waitingArrivals(car, occupied)) {
        const plan = this.planCreep(car, occupied, bodies, obstacles, claim, peer);
        if (plan) { this.start(car, peer, plan); return; }
      }
    }
    const links = new Map(stopped.map(c => [c, this.blockers(c, occupied, stopped, bodies)]));
    for (const car of stopped.sort((a, b) => a.id - b.id)) {
      if (car.type !== 'car') continue;
      const cycle = this.cycleFrom(car, links);
      if (!cycle) continue;
      const peer = cycle.find(c => c !== car && links.get(c)?.includes(car)) || cycle[1];
      const plan = this.planCreep(car, occupied, bodies, obstacles, null, peer) || this.planPocket(car, peer, bodies, obstacles);
      if (plan) { this.start(car, peer, plan); break; }
      this.cooldown.set(car.id, this.sim.time + 8);
    }
  }
  physicalGap(car, maximum = 30) {
    if (!this.states.size) return Infinity;
    const cached = this.gaps.get(car.id);
    if (cached?.q === car.q && cached.maximum >= maximum) return cached.gap;
    const creeping = this.states.get(car.id)?.phase === 'creeping';
    const blockers = [...this.states.values()].filter(s => s.car !== car).map(s => this.body(s.car));
    blockers.push(...this.reservedBodies(car.id));
    if (creeping) blockers.push(...(this.bodySnapshot?.values() || []), ...(this.obstacleSnapshot || []));
    if (!blockers.length) return Infinity;
    const current = this.body(car), horizon = Math.min(maximum, car.offsets.at(-1) - car.q);
    const nearby = blockers.filter(b => b.ownerId !== car.id && close(current, b, horizon));
    if (!nearby.length && !creeping) return Infinity;
    let gap = Infinity;
    for (let travel = 0; travel <= horizon; travel += 0.2) {
      const candidate = this.body(car, car.q + travel);
      if (creeping && !this.sim.emergency.onSurface(car, candidate, car.q + travel) ||
        nearby.some(body => orientedBodiesOverlap(candidate, body, clearance))) { gap = Math.max(0, travel - 0.2); break; }
    }
    this.gaps.set(car.id, { q: car.q, maximum, gap });
    return gap;
  }
  gap(car) {
    const state = this.states.get(car.id);
    return Math.min(this.physicalGap(car), state?.phase === 'creeping' ? Math.max(0, state.q - car.q) + 0.9 : Infinity);
  }
  limitMove(car, move) {
    const state = this.states.get(car.id);
    return Math.max(0, Math.min(move, this.physicalGap(car, move + 0.25),
      state?.phase === 'creeping' ? Math.max(0, state.q - car.q) : Infinity));
  }
  reservedBodies(except) {
    return [...this.states.values()].filter(s => s.car.id !== except && !s.clear && s.phase !== 'creeping').map(state => {
      const current = this.body(state.car), target = state.phase === 'returning' ? this.returnOffset(state) : state.targetOffset;
      const end = this.body(state.car, state.q, target);
      return { ...current, x: (current.x + end.x) / 2, y: (current.y + end.y) / 2,
        length: current.length + Math.abs(state.car.q - state.q) + 0.5,
        width: current.width + Math.abs(state.offset - target) + 0.5,
        ownerId: state.car.id, kind: 'cooperative manoeuvre' };
    });
  }
  spawnAllowed(car) {
    if (!this.states.size) return true;
    const body = this.body(car);
    for (const state of this.states.values()) {
      if (state.car === car) continue;
      const low = Math.min(state.q, state.car.q), high = Math.max(state.originalQ, state.car.q);
      for (let q = low; q <= high + 0.01; q += 0.5) for (const offset of [0, state.offset, state.targetOffset])
        if (orientedBodiesOverlap(body, this.body(state.car, q, offset), clearance)) return false;
    }
    return true;
  }
  corridorAllowed(edge, start, end, halfWidth) {
    for (const body of [...this.states.values()].map(s => this.body(s.car)).concat(this.reservedBodies())) {
      for (let d = Math.max(0, start); d <= Math.min(edge.length, end); d += 2) {
        const point = position(edge, d);
        const corridor = { x: point.x, y: point.y, angle: Math.atan2(point.dy, point.dx), length: 4,
          width: halfWidth * 2, layer: Number(edge.tags.layer) || (edge.tags.bridge && edge.tags.bridge !== 'no' ? 1 : 0) };
        if (orientedBodiesOverlap(body, corridor, clearance)) return false;
      }
    }
    return true;
  }
}
