import { position } from './graph.mjs';
import { laneCount, laneOffset } from './traffic-model.mjs';
import { orientedBodiesOverlap } from '../../body-geometry.mjs';

const layerOf = value => Number(value?.layer ?? value?.road?.layer ?? 0) || 0;
const edgeLayer = edge => Number(edge.tags.layer) || (edge.tags.bridge && edge.tags.bridge !== 'no' ? 1 : 0);
const sameLayer = (a, b) => layerOf(a) === layerOf(b);
const radius = body => Math.hypot(body.length, body.width) / 2;
const nearby = (a, b, extra = 0) => Math.hypot(a.x - b.x, a.y - b.y) <= radius(a) + radius(b) + extra;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

/** The player is a separate, freely steered actor. This controller makes
 * ordinary road traffic yield without changing routes, signals or the map.
 * Rendered body poses are injected so widened roads and physical collisions
 * use the same geometry. No controller state is global.
 */
export class EmergencyTraffic {
  constructor(simulation) {
    this.sim = simulation;
    this.player = null;
    this.poseProvider = null;
    this.obstacleProvider = null;
    this.surfaceProvider = null;
    this.states = new Map();
    this.owners = new Map();
    this.gaps = new Map();
  }
  setPlayer(player) {
    this.player = player?.active ? { ...player, length: player.length || 9, width: player.width || 2.5,
      layer: layerOf(player) } : null;
    this.gaps.clear();
  }
  setPoseProvider(provider) { this.poseProvider = provider; this.gaps.clear(); }
  setObstacleProvider(provider) { this.obstacleProvider = provider; }
  setSurfaceProvider(provider) { this.surfaceProvider = provider; this.gaps.clear(); }
  body(car, q = car.q, offset = undefined) {
    let index = Math.min(car.index, car.route.length - 1);
    while (index > 0 && q < car.offsets[index]) index--;
    while (index < car.route.length - 1 && q >= car.offsets[index + 1]) index++;
    const posed = q === car.q && index === car.index && offset === undefined ? car :
      { ...car, q, index, d: q - car.offsets[index], emergencyOffsetOverride: offset };
    const edge = this.sim.data.edges[car.route[index]];
    let p = this.poseProvider?.(posed);
    if (!p) {
      let centreIndex = index;
      const centre = Math.max(0, q - car.length / 2);
      while (centreIndex > 0 && centre < car.offsets[centreIndex]) centreIndex--;
      const centreEdge = this.sim.data.edges[car.route[centreIndex]];
      const point = position(centreEdge, centre - car.offsets[centreIndex]);
      const lateral = this.lateral(posed, centreEdge, laneOffset(centreEdge, car.lanes[centreIndex]), 1);
      p = { x: point.x + point.dy * lateral, y: point.y - point.dx * lateral,
        angle: Math.atan2(point.dy, point.dx), edge: centreEdge, widthFactor: 1,
        roadHalfWidth: laneCount(centreEdge) * 3.3, layer: edgeLayer(centreEdge) };
    }
    return { ...p, length: car.length, width: p.width ?? car.width,
      layer: layerOf(p), ownerId: car.id, edge: p.edge || edge };
  }
  lateral(car, _edge, normal, widthFactor = 1, alpha = 1) {
    const state = this.states.get(car.id);
    const offset = car.emergencyOffsetOverride ?? (state ?
      state.previousOffset + (state.offset - state.previousOffset) * clamp(alpha, 0, 1) : 0);
    return normal + offset / Math.max(0.1, widthFactor);
  }
  isYielding(car) {
    const state = this.states.get(car.id);
    return Boolean(state?.active || Math.abs(state?.offset || 0) > 0.05);
  }
  centreRoadPoint(car, q = car.q) {
    const centre = Math.max(0, q - car.length / 2);
    let index = Math.min(car.index, car.route.length - 1);
    while (index > 0 && centre < car.offsets[index]) index--;
    while (index < car.route.length - 1 && centre >= car.offsets[index + 1]) index++;
    return position(this.sim.data.edges[car.route[index]], centre - car.offsets[index]);
  }
  clearingJunction(car) {
    for (const claims of this.sim.reservations.values()) for (const claim of claims)
      if (claim.car === car && car.q >= claim.crossing && car.q - car.length <= claim.crossing + 0.5) return true;
    return false;
  }
  eligibleShift(car, body) {
    if (body.station || car.parked || car.parkingActivity || car.turnaround || car.busPass || car.stationMovement ||
      car.roadStop && !car.roadStop.done && car.roadStop.remaining !== null) return false;
    // An approaching junction or parked row is not itself a refusal: the
    // swept hull, pavement, people and reservation checks decide if it fits.
    const edge = this.sim.data.edges[car.route[car.index]];
    const centre = Math.max(0, car.q - car.length / 2 - car.offsets[car.index]);
    const a = position(edge, Math.max(0, centre - car.length)), b = position(edge, Math.min(edge.length, centre + car.length));
    return (this.surfaceProvider || a.dx * b.dx + a.dy * b.dy > 0.985) && Number.isFinite(body.roadHalfWidth);
  }
  hearsSiren(car, body) {
    const p = this.player;
    if (!p?.siren || !sameLayer(body, p) || body.station || car.parked || car.parkingActivity || car.turnaround || car.busPass) return false;
    const dx = body.x - p.x, dy = body.y - p.y, distance = Math.hypot(dx, dy);
    if (distance > 150) return false;
    const forward = dx * Math.cos(p.angle) + dy * Math.sin(p.angle);
    const side = Math.abs(-dx * Math.sin(p.angle) + dy * Math.cos(p.angle));
    if (forward > -15 && side < Math.max(13, (body.roadHalfWidth || 0) + 3)) return true;
    // Cross traffic approaching the engine's nearby junction also gives way.
    const ahead = -dx * Math.cos(body.angle) - dy * Math.sin(body.angle);
    const across = Math.abs(dx * Math.sin(body.angle) - dy * Math.cos(body.angle));
    return distance < 70 && ahead > 0 && across < p.width / 2 + body.width / 2 + 5;
  }
  ensureState(car) {
    let state = this.states.get(car.id);
    if (!state) {
      state = { offset: 0, previousOffset: 0, until: 0, active: false, stopQ: null, clearing: false,
        phase: 'waiting', reversing: false, reverse: null, nextReverse: 0, nudgedUntil: 0, route: car.route };
      this.states.set(car.id, state); this.owners.set(car.id, car);
    }
    // Reroutes retain this driver/body but may use a new route coordinate.
    if (state.route !== car.route) { state.route = car.route; state.reverse = null; state.stopQ = car.q; }
    car.emergencyYield = state;
    return state;
  }
  targetOffset(car, body, q = car.q) {
    const road = this.centreRoadPoint(car, q), state = this.states.get(car.id);
    const lateral = (body.x - road.x) * road.dy - (body.y - road.y) * road.dx - (state?.offset || 0);
    // Only an outer lane can use the pavement. The injected shared surface
    // validator enforces actual sidewalk tags, buildings, grass and water.
    const pavement = this.surfaceProvider && car.lanes[car.index] === 0 ? 3 : 0;
    let target = clamp(body.roadHalfWidth + pavement - lateral - body.width / 2 - 0.35, 0, 7);
    if (car.lanes[car.index] > 0)
      target = Math.min(target, Math.max(0, (3.3 * (body.widthFactor || 1) - body.width) / 2 - 0.35));
    return target;
  }
  onSurface(car, candidate, q) {
    if (this.surfaceProvider) return this.surfaceProvider(candidate, car) !== false;
    const road = this.centreRoadPoint(car, q);
    const lateral = (candidate.x - road.x) * road.dy - (candidate.y - road.y) * road.dx;
    const difference = candidate.angle - Math.atan2(road.dy, road.dx);
    const extent = Math.abs(Math.sin(difference)) * car.length / 2 + Math.abs(Math.cos(difference)) * candidate.width / 2;
    return Math.abs(lateral) + extent + 0.35 <= candidate.roadHalfWidth + 1e-7;
  }
  safePose(car, q, offset, bodies, obstacles, player = this.player, margin = 0.3) {
    const candidate = this.body(car, q, offset);
    if (!this.onSurface(car, candidate, q)) return false;
    for (const other of [...bodies.values(), ...obstacles, ...(player ? [player] : [])]) {
      if (other.ownerId === car.id || other === car || !sameLayer(candidate, other) || !nearby(candidate, other, 0.5)) continue;
      if (orientedBodiesOverlap(candidate, other, margin)) return false;
    }
    return true;
  }
  safeSweep(car, q, offset, bodies, obstacles, player = this.player, margin = 0.3) {
    const from = this.states.get(car.id)?.offset || 0;
    const steps = Math.max(1, Math.ceil((Math.abs(q - car.q) + Math.abs(offset - from)) / 0.2));
    for (let i = 1; i <= steps; i++)
      if (!this.safePose(car, car.q + (q - car.q) * i / steps, from + (offset - from) * i / steps,
        bodies, obstacles, player, margin)) return false;
    return true;
  }
  reservedBodies(except) {
    return [...this.states.entries()].filter(([id, s]) => id !== except && s.reverse).map(([, s]) => s.reverse.pocket);
  }
  commitPosition(car, q) {
    car.q = q;
    while (car.index > 0 && q < car.offsets[car.index]) car.index--;
    while (car.index < car.route.length - 1 && q >= car.offsets[car.index + 1]) car.index++;
    car.d = q - car.offsets[car.index]; car.v = 0;
    this.gaps.clear();
  }
  managesMotion(car) {
    const state = this.states.get(car.id);
    return Boolean(state?.reverse || state?.managedAt === this.sim.time || state?.nudgedUntil > this.sim.time);
  }
  planReverse(car, state, bodies, obstacles) {
    if (car.type !== 'car' || car.v > 0.3 || state.clearing || this.sim.time < state.nextReverse ||
      car.roadStop && !car.roadStop.done || !this.eligibleShift(car, this.body(car))) return false;
    state.nextReverse = this.sim.time + 8;
    const start = car.offsets[car.index], edge = this.sim.data.edges[car.route[car.index]];
    // Never back a tail over a junction, signal or the start of its route.
    const allowance = Math.min(10, car.q - start - car.length - 2);
    const a = position(edge, car.d), b = position(edge, Math.max(0, car.d - allowance - car.length));
    if (allowance < 2 || a.dx * b.dx + a.dy * b.dy < 0.995) return false;
    for (let back = 2; back <= allowance; back += 1) {
      const q = car.q - back, body = this.body(car, q), target = this.targetOffset(car, body, q);
      if (target < state.offset + 0.8 || !this.safeSweep(car, q, state.offset, bodies, obstacles)) continue;
      // The whole sideways path must be clear at the new position, not just a
      // tempting empty pavement on the far side of a parked car.
      let clear = true;
      for (let offset = state.offset + 0.2; offset <= target + 1e-6; offset += 0.2)
        if (!this.safePose(car, q, offset, bodies, obstacles)) { clear = false; break; }
      if (!clear || !this.safePose(car, q, target, bodies, obstacles)) continue;
      const current = this.body(car), pocket = { ...current, x: (current.x + body.x) / 2,
        y: (current.y + body.y) / 2, length: car.length + back + 0.8, width: current.width + 0.6,
        ownerId: car.id, kind: 'emergency-reverse' };
      state.reverse = { q, pocket, blocked: 0 }; state.phase = 'backing-up'; state.stopQ = car.q;
      return true;
    }
    return false;
  }
  /** A contact moves an ordinary car only a few centimetres. The player then
   * re-tests its proposed hull; accepting a shove never authorises overlap.
   * Parked/animated actors keep their own controllers and cannot be pushed.
   */
  tryNudge(car, playerCandidate, force = 1) {
    if (!this.sim.cars.includes(car) || car.type !== 'car' || car.parked || car.parkingActivity || car.turnaround ||
      car.busPass || car.stationMovement || car.roadStop?.remaining != null || this.clearingJunction(car)) return false;
    const body = this.body(car);
    if (body.station || !sameLayer(body, playerCandidate) || !nearby(body, playerCandidate, 0.5)) return false;
    const state = this.states.get(car.id), offset = state?.offset || 0;
    const dx = body.x - playerCandidate.x, dy = body.y - playerCandidate.y;
    const along = dx * Math.cos(body.angle) + dy * Math.sin(body.angle);
    const left = dx * Math.sin(body.angle) - dy * Math.cos(body.angle);
    const step = clamp(0.06 + 0.012 * force, 0.06, 0.16), direction = along >= 0 ? 1 : -1;
    const maximum = this.targetOffset(car, body);
    const bodies = new Map(this.sim.cars.map(c => [c.id, this.body(c)]));
    const obstacles = [...(this.obstacleProvider?.() || []), ...this.reservedBodies(car.id)];
    const edge = this.sim.data.edges[car.route[car.index]], start = car.offsets[car.index];
    const candidates = left > 0.2 ? [[direction * step * 0.6, step * 0.8], [0, step], [direction * step, 0]] :
      [[direction * step, 0], ...(left > -0.2 ? [[direction * step * 0.8, step * 0.6]] : [])];
    for (const [dq, side] of candidates) {
      const q = car.q + dq, shifted = offset + side;
      if (shifted > maximum + 1e-7 || q - car.length < start + 0.5 || q > start + edge.length - 0.5 ||
        car.roadStop && !car.roadStop.done && q > car.roadStop.q ||
        dq > 0 && (this.sim.crossingStop?.(car, edge) ?? Infinity) < q - start) continue;
      if (!this.safeSweep(car, q, shifted, bodies, obstacles, null, 0.15)) continue;
      const moved = this.body(car, q, shifted);
      if (this.player && orientedBodiesOverlap(moved, this.player, 0.02)) continue;
      // Never push a side-contact car towards the engine or across the centre
      // line merely because a different empty bit of asphalt exists there.
      if ((moved.x - body.x) * dx + (moved.y - body.y) * dy <= 1e-8) continue;
      const next = this.ensureState(car);
      next.previousOffset = next.offset; next.offset = shifted; next.reverse = null;
      next.nudgedUntil = this.sim.time + 0.7; next.phase = 'nudged'; next.reversing = dq < 0;
      next.nudgeReverse = next.reversing;
      if (next.active) next.stopQ = q;
      this.commitPosition(car, q);
      return true;
    }
    return false;
  }
  update(dt) {
    this.gaps.clear();
    if (!this.player && !this.states.size) return;
    const alive = new Set(this.sim.cars.map(c => c.id));
    for (const id of this.states.keys()) if (!alive.has(id)) {
      delete this.owners.get(id)?.emergencyYield;
      this.owners.delete(id); this.states.delete(id);
    }
    const bodies = new Map(this.sim.cars.map(car => [car.id, this.body(car)]));
    const obstacles = this.obstacleProvider?.() || [];
    this.obstacles = obstacles;
    for (const car of this.sim.cars) {
      const body = bodies.get(car.id), heard = this.hearsSiren(car, body);
      let state = this.states.get(car.id);
      if (body.station || car.parked || car.parkingActivity || car.turnaround || car.busPass) {
        this.states.delete(car.id); this.owners.delete(car.id); delete car.emergencyYield; continue;
      }
      if (!state && !heard) continue;
      state = this.ensureState(car);
      state.previousOffset = state.offset;
      state.reversing = false;
      if (heard) state.until = this.sim.time + 1;
      if (!this.player?.siren) state.until = 0;
      state.active = heard || state.until > this.sim.time;
      state.clearing = state.active && this.clearingJunction(car);
      if (!state.active && state.reverse) state.reverse = null;
      if (!state.active || state.clearing) state.stopQ = null;
      else state.stopQ ??= car.q + (car.v < 0.3 ? 0 : car.v * 0.35 + car.v * car.v / 6.5);
      const blockers = [...obstacles, ...this.reservedBodies(car.id)];
      if (state.nudgedUntil > this.sim.time) { state.phase = 'nudged'; state.reversing = state.nudgeReverse; continue; }
      if (state.reverse) {
        const q = Math.max(state.reverse.q, car.q - dt * 1.4);
        if (this.safeSweep(car, q, state.offset, bodies, blockers)) {
          this.commitPosition(car, q); state.managedAt = this.sim.time; state.reversing = true;
          state.reverse.blocked = 0; state.stopQ = car.q; state.phase = 'backing-up'; car.stopped = 0;
          bodies.set(car.id, this.body(car));
          if (q <= state.reverse.q + 1e-6) state.reverse = null;
        } else if ((state.reverse.blocked += dt) > 2) state.reverse = null;
        continue;
      }
      let target = 0;
      if (state.active && !state.clearing && this.eligibleShift(car, body)) target = this.targetOffset(car, body);
      // A stronger initial response still takes several seconds to pull over.
      const proposed = state.offset + clamp(target - state.offset, -dt * 1.4, dt * 2.3);
      state.phase = state.active ? 'waiting' : 'returning';
      if (Math.abs(proposed - state.offset) > 1e-8 && this.safeSweep(car, car.q, proposed, bodies, blockers)) {
        state.offset = proposed;
        state.phase = state.active ? 'pulling-in' : 'returning';
        bodies.set(car.id, this.body(car));
      } else if (state.active && !state.clearing && target > state.offset + 0.8) {
        this.planReverse(car, state, bodies, blockers);
      }
      car.emergencyYield = state;
      if (!state.active && !this.managesMotion(car) && Math.abs(state.offset) < 1e-6) {
        this.states.delete(car.id); this.owners.delete(car.id); delete car.emergencyYield;
      }
    }
  }
  speed(car) { return this.states.get(car.id)?.active ? 8 : Infinity; }
  physicalGap(car) {
    if (!this.player && !this.states.size) return Infinity;
    const state = this.states.get(car.id);
    if (state?.route !== car.route && state) this.ensureState(car);
    const cached = this.gaps.get(car.id);
    if (cached?.q === car.q && cached.offset === state?.offset) return cached.gap;
    const displaced = Math.abs(state?.offset || 0) > 0.02;
    const current = this.body(car), horizon = Math.min(displaced ? Math.max(15, car.v * car.v / 4 + 8) : 90,
      Math.max(0, car.offsets.at(-1) - car.q));
    const blockers = [...(this.player ? [this.player] : []), ...this.reservedBodies(car.id)];
    if (displaced) blockers.push(...(this.obstacles || []));
    const traffic = displaced ? this.sim.cars : [...this.states.entries()]
      .filter(([, other]) => Math.abs(other.offset || 0) > 0.02).map(([id]) => this.owners.get(id)).filter(Boolean);
    for (const other of traffic) {
      if (other === car) continue;
      if (displaced || Math.abs(this.states.get(other.id)?.offset || 0) > 0.02) {
        const body = this.body(other);
        if (nearby(current, body, horizon + 1)) blockers.push(body);
      }
    }
    const relevant = blockers.filter(other => other.ownerId !== car.id && sameLayer(current, other) && nearby(current, other, horizon + 1));
    let gap = Infinity;
    if (relevant.length || displaced) {
      const collides = travel => {
        const candidate = travel === 0 ? current : this.body(car, car.q + travel);
        return displaced && !this.onSurface(car, candidate, car.q + travel) ||
          relevant.some(other => sameLayer(candidate, other) && nearby(candidate, other, 0.4) &&
            orientedBodiesOverlap(candidate, other, 0.3));
      };
      if (collides(0)) gap = 0;
      else {
        // Sub-metre samples cover turns at surveyed shape points, followed by
        // refinement of the first contact. This same cap protects siren-off play.
        for (let at = Math.min(0.75, horizon); at <= horizon && at > 0; at = Math.min(horizon, at + 0.75)) {
          if (collides(at)) {
            let low = Math.max(0, at - 0.75), high = at;
            for (let i = 0; i < 8; i++) { const mid = (low + high) / 2; if (collides(mid)) high = mid; else low = mid; }
            gap = low; break;
          }
          if (at === horizon) break;
        }
      }
    }
    this.gaps.set(car.id, { q: car.q, offset: state?.offset, gap });
    return gap;
  }
  gap(car) {
    const state = this.states.get(car.id);
    return Math.min(this.physicalGap(car), state?.active && !state.clearing && state.stopQ !== null ?
      Math.max(0, state.stopQ - car.q) + car.minGap : Infinity);
  }
  limitMove(car, move) { return Math.max(0, Math.min(move, this.physicalGap(car) - 0.15)); }
  spawnAllowed(car) {
    if (!this.player && !this.states.size) return true;
    const body = this.body(car);
    const blockers = [...(this.player ? [this.player] : []), ...this.reservedBodies(car.id)];
    for (const [id, state] of this.states) if (id !== car.id && Math.abs(state.offset) > 0.02) {
      const other = this.owners.get(id); if (other) blockers.push(this.body(other));
    }
    return blockers.every(other => !sameLayer(body, other) || !orientedBodiesOverlap(body, other, 0.6));
  }
  /** Veto a new turning/parking/pass reservation around the player's hull.
   * Root supplies the rendered half-width of this road or pavement corridor.
   */
  corridorAllowed(edge, start, end, halfWidth = laneCount(edge) * 3.3) {
    const blockers = [...(this.player ? [this.player] : []), ...this.reservedBodies()]
      .filter(body => layerOf(body) === edgeLayer(edge));
    if (!blockers.length) return true;
    const from = clamp(Math.min(start, end), 0, edge.length), to = clamp(Math.max(start, end), 0, edge.length);
    for (let at = from; at <= to; at = Math.min(to, at + 3)) {
      const p = position(edge, at), road = { x: p.x, y: p.y, angle: Math.atan2(p.dy, p.dx),
        length: Math.min(6, to - from + 2), width: halfWidth * 2, layer: edgeLayer(edge) };
      if (blockers.some(body => nearby(road, body, 0.5) && orientedBodiesOverlap(road, body, 0.5))) return false;
      if (at === to) break;
    }
    return true;
  }
}
