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
  centreRoadPoint(car) {
    const centre = Math.max(0, car.q - car.length / 2);
    let index = Math.min(car.index, car.route.length - 1);
    while (index > 0 && centre < car.offsets[index]) index--;
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
    if ((car.parkingPassages || []).some(p => this.sim.parking.controller(p).narrow &&
      car.q > p.entry - 20 && car.q - car.length < p.exit + 20)) return false;
    const edge = this.sim.data.edges[car.route[car.index]], next = this.sim.data.edges[car.route[car.index + 1]];
    if (this.sim.isJunction(edge, next) && edge.length - car.d < car.length + 12) return false;
    const centre = Math.max(0, car.q - car.length / 2 - car.offsets[car.index]);
    const a = position(edge, Math.max(0, centre - car.length)), b = position(edge, Math.min(edge.length, centre + car.length));
    return a.dx * b.dx + a.dy * b.dy > 0.985 && Number.isFinite(body.roadHalfWidth);
  }
  hearsSiren(car, body) {
    const p = this.player;
    if (!p?.siren || !sameLayer(body, p) || body.station || car.parked || car.parkingActivity || car.turnaround || car.busPass) return false;
    const dx = body.x - p.x, dy = body.y - p.y, distance = Math.hypot(dx, dy);
    if (distance > 85) return false;
    const forward = dx * Math.cos(p.angle) + dy * Math.sin(p.angle);
    const side = Math.abs(-dx * Math.sin(p.angle) + dy * Math.cos(p.angle));
    if (forward > -15 && side < Math.max(13, (body.roadHalfWidth || 0) + 3)) return true;
    // Cross traffic approaching the engine's nearby junction also gives way.
    const ahead = -dx * Math.cos(body.angle) - dy * Math.sin(body.angle);
    const across = Math.abs(dx * Math.sin(body.angle) - dy * Math.cos(body.angle));
    return distance < 45 && ahead > 0 && across < p.width / 2 + body.width / 2 + 5;
  }
  safeOffset(car, offset, bodies, obstacles) {
    const candidate = this.body(car, car.q, offset), road = this.centreRoadPoint(car);
    const lateral = (candidate.x - road.x) * road.dy - (candidate.y - road.y) * road.dx;
    const difference = candidate.angle - Math.atan2(road.dy, road.dx);
    const extent = Math.abs(Math.sin(difference)) * car.length / 2 + Math.abs(Math.cos(difference)) * candidate.width / 2;
    if (Math.abs(lateral) + extent + 0.35 > candidate.roadHalfWidth + 1e-7) return false;
    for (const other of [...bodies.values(), ...obstacles, ...(this.player ? [this.player] : [])]) {
      if (other.ownerId === car.id || other === car || !sameLayer(candidate, other) || !nearby(candidate, other, 0.5)) continue;
      if (orientedBodiesOverlap(candidate, other, 0.3)) return false;
    }
    return true;
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
    for (const car of this.sim.cars) {
      const body = bodies.get(car.id), heard = this.hearsSiren(car, body);
      let state = this.states.get(car.id);
      if (body.station || car.parked || car.parkingActivity || car.turnaround || car.busPass) {
        this.states.delete(car.id); this.owners.delete(car.id); delete car.emergencyYield; continue;
      }
      if (!state && !heard) continue;
      if (!state) {
        state = { offset: 0, previousOffset: 0, until: 0, active: false, stopQ: null, clearing: false };
        this.states.set(car.id, state);
        this.owners.set(car.id, car);
      }
      state.previousOffset = state.offset;
      if (heard) state.until = this.sim.time + 1;
      if (!this.player?.siren) state.until = 0;
      state.active = heard || state.until > this.sim.time;
      state.clearing = state.active && this.clearingJunction(car);
      if (!state.active || state.clearing) state.stopQ = null;
      else state.stopQ ??= car.q + (car.v < 0.3 ? 0 : car.v * 0.6 + car.v * car.v / 5.4);
      let target = 0;
      if (state.active && !state.clearing && this.eligibleShift(car, body)) {
        const road = this.centreRoadPoint(car);
        const lateral = (body.x - road.x) * road.dy - (body.y - road.y) * road.dx - state.offset;
        target = clamp(body.roadHalfWidth - lateral - body.width / 2 - 0.35, 0, 3);
        // Inner lanes may edge left inside their own lane, never drift into a
        // neighbouring stream that can subsequently catch up from behind.
        if (car.lanes[car.index] > 0)
          target = Math.min(target, Math.max(0, (3.3 * (body.widthFactor || 1) - body.width) / 2 - 0.35));
      }
      const proposed = state.offset + clamp(target - state.offset, -dt * 1.25, dt * 1.1);
      if (Math.abs(proposed - state.offset) > 1e-8 && this.safeOffset(car, proposed, bodies, obstacles)) {
        state.offset = proposed;
        bodies.set(car.id, this.body(car));
      }
      car.emergencyYield = state;
      if (!state.active && Math.abs(state.offset) < 1e-6) {
        this.states.delete(car.id); this.owners.delete(car.id); delete car.emergencyYield;
      }
    }
  }
  speed(car) { return this.states.get(car.id)?.active ? 8 : Infinity; }
  physicalGap(car) {
    if (!this.player) return Infinity;
    const cached = this.gaps.get(car.id);
    if (cached?.q === car.q) return cached.gap;
    const current = this.body(car), horizon = Math.min(90, Math.max(0, car.offsets.at(-1) - car.q));
    let gap = Infinity;
    if (nearby(current, this.player, horizon)) {
      const collides = travel => {
        const candidate = travel === 0 ? current : this.body(car, car.q + travel);
        return sameLayer(candidate, this.player) && nearby(candidate, this.player, 0.4) &&
          orientedBodiesOverlap(candidate, this.player, 0.35);
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
    this.gaps.set(car.id, { q: car.q, gap });
    return gap;
  }
  gap(car) {
    const state = this.states.get(car.id);
    return Math.min(this.physicalGap(car), state?.active && !state.clearing && state.stopQ !== null ?
      Math.max(0, state.stopQ - car.q) + car.minGap : Infinity);
  }
  limitMove(car, move) { return Math.max(0, Math.min(move, this.physicalGap(car) - 0.15)); }
  spawnAllowed(car) {
    if (!this.player) return true;
    const body = this.body(car);
    return !sameLayer(body, this.player) || !orientedBodiesOverlap(body, this.player, 0.6);
  }
  /** Veto a new turning/parking/pass reservation around the player's hull.
   * Root supplies the rendered half-width of this road or pavement corridor.
   */
  corridorAllowed(edge, start, end, halfWidth = laneCount(edge) * 3.3) {
    if (!this.player || layerOf(this.player) !== edgeLayer(edge)) return true;
    const from = clamp(Math.min(start, end), 0, edge.length), to = clamp(Math.max(start, end), 0, edge.length);
    for (let at = from; at <= to; at = Math.min(to, at + 3)) {
      const p = position(edge, at), road = { x: p.x, y: p.y, angle: Math.atan2(p.dy, p.dx),
        length: Math.min(6, to - from + 2), width: halfWidth * 2, layer: layerOf(this.player) };
      if (nearby(road, this.player, 0.5) && orientedBodiesOverlap(road, this.player, 0.5)) return false;
      if (at === to) break;
    }
    return true;
  }
}
