import { findRoute, isSignal, makeGraph, position } from './graph.mjs';
import { laneCount, laneOffset } from './traffic-model.mjs';

// These are driver preferences, not changes to the surveyed speed limits. A
// small time saving is not a reason to send through traffic down a side street.
const ROAD_PREFERENCE = {
  motorway: 0.9, motorway_link: 0.95, trunk: 0.95, trunk_link: 1,
  primary: 1, primary_link: 1.05, secondary: 1.05, secondary_link: 1.1,
  tertiary: 1.14, tertiary_link: 1.2, unclassified: 1.45,
  residential: 1.8, living_street: 2.4, service: 2.5,
};
const LOCAL_ROADS = new Set(['residential', 'unclassified', 'living_street']);
const sameRoute = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
export const preferredRoadCost = edge => edge.length / edge.speed * (ROAD_PREFERENCE[edge.tags.highway] || 1.6);
const isHeavy = type => type === 'bus' || type === 'lorry';

export class AdaptiveTraffic {
  constructor(simulation) {
    this.sim = simulation;
    this.delay = new Map();
    this.turns = new Map();
    this.entryCache = new Map();
    this.graphs = new Map();
    this.graphRevision = -1;
    this.nextSample = 0;
    this.nextReview = 0;
    this.reviewCursor = 0;
    this.rerouted = 0;
    this.threePointTurns = 0;
  }
  graph(type) {
    if (this.graphRevision !== this.sim.closures.revision) {
      this.graphRevision = this.sim.closures.revision;
      this.graphs.clear();
      this.entryCache.clear();
    }
    const key = isHeavy(type) ? 'heavy' : 'light';
    if (!this.graphs.has(key)) {
      const graph = makeGraph(this.sim.data);
      for (const [node, edges] of graph.out)
        graph.out.set(node, edges.filter(edge =>
          !this.sim.closures.ways.has(edge.way) && !(key === 'heavy' && edge.restoredUnderpass)));
      this.graphs.set(key, graph);
    }
    return this.graphs.get(key);
  }
  // Scheduled services, school pickup stops and bicycles keep their given paths.
  entry(spec, type) {
    if (!spec?.path.length || type === 'bicycle' || type === 'bus' || spec.roadStop || spec.group === 'scenario') return spec;
    const graph = this.graph(type), first = this.sim.data.edges[spec.path[0]], last = this.sim.data.edges[spec.path.at(-1)];
    const key = `${isHeavy(type) ? 'h' : 'l'}:${first.from}:${last.to}`;
    if (!this.entryCache.has(key))
      this.entryCache.set(key, findRoute(graph, first.from, last.to, null, preferredRoadCost));
    const path = this.entryCache.get(key);
    // Empty paths represent same-node demand loops; retain those deliberate trips.
    return path?.length ? { ...spec, path } : spec;
  }
  cost(edge, traffic = true) {
    return preferredRoadCost(edge) + (traffic ? this.delay.get(edge.id) || 0 : 0);
  }
  sample() {
    const groups = new Map();
    for (const car of this.sim.cars) {
      if (car.parked || car.type === 'bicycle') continue;
      const id = car.route[car.index];
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(car);
    }
    for (const edge of this.sim.data.edges) {
      const cars = groups.get(edge.id) || [], stopped = cars.filter(c => c.v < 1 && c.stopped > 4);
      const slow = cars.reduce((sum, c) => sum + Math.max(0, 1 - c.v / Math.min(c.maxSpeed, edge.speed)), 0);
      // Estimate the queue, not the speed of the entire OSM edge: one car at a
      // crossing must not make a two-kilometre lane appear wholly gridlocked.
      const observed = Math.min(150, stopped.length * 6 + slow * 2.5 + (stopped.length ? Math.min(45, Math.max(...stopped.map(c => c.stopped)) * 0.6) : 0));
      const smoothed = (this.delay.get(edge.id) || 0) * 0.58 + observed * 0.42;
      if (smoothed > 0.15) this.delay.set(edge.id, smoothed); else this.delay.delete(edge.id);
    }
  }
  pathCost(path) {
    return path.reduce((sum, id) => {
      const edge = this.sim.data.edges[id];
      return sum + this.cost(edge) + (isSignal(this.sim.data.nodes[edge.to].tags) ? 8 : 0);
    }, 0);
  }
  hasCommitment(car) {
    return car.parked || car.parkingActivity || car.purposefulJourney || car.turnaround || car.busPass || (car.roadStop && !car.roadStop.done) ||
      (this.reviewCommitments ? this.reviewCommitments.has(car.id) :
      this.sim.parking.zones.some(zone => zone.claims.has(car.id)) ||
      [...this.sim.reservations.values()].some(claims => claims.some(r => r.car === car && r.crossing > car.q)));
  }
  install(car, path, prefix = car.index + 1) {
    const oldPrefix = car.route.slice(0, prefix);
    car.route = [...oldPrefix, ...path];
    car.offsets = car.offsets.slice(0, prefix + 1);
    car.lanes = car.lanes.slice(0, prefix);
    for (const id of path) {
      car.offsets.push(car.offsets.at(-1) + this.sim.data.edges[id].length);
      car.lanes.push(Math.min(car.lanes.at(-1) || 0, laneCount(this.sim.data.edges[id]) - 1));
    }
    car.closureBarrierRevision = -1;
    for (const [node, claims] of this.sim.reservations) {
      const kept = claims.filter(r => r.car !== car || r.crossing <= car.q);
      if (kept.length) this.sim.reservations.set(node, kept); else this.sim.reservations.delete(node);
    }
    this.sim.parking.prepare(car);
  }
  consider(car) {
    if (car.type === 'bicycle' || car.type === 'bus' || this.sim.time < (car.nextRouteReview || 0) || this.hasCommitment(car)) return false;
    const edge = this.sim.data.edges[car.route[car.index]];
    car.nextRouteReview = this.sim.time + (LOCAL_ROADS.has(edge.tags.highway) && car.id % 5 === 0 ? 3 : 11 + car.id % 7);
    const remaining = car.route.slice(car.index + 1);
    if (!remaining.length) return;
    const destination = car.destination ?? this.sim.data.edges[car.route.at(-1)].to;
    const routeDelay = remaining.reduce((sum, id) => sum + (this.delay.get(id) || 0), 0) + (this.delay.get(edge.id) || 0);
    if (routeDelay < 22) return;
    const currentCost = this.pathCost(remaining), graph = this.graph(car.type);
    const path = findRoute(graph, edge.to, destination, edge, e => this.cost(e));
    const saved = path ? currentCost - this.pathCost(path) : 0;
    if (path && !sameRoute(path, remaining) && saved > Math.max(18, currentCost * 0.2)) {
      this.install(car, path);
      car.reroutes = (car.reroutes || 0) + 1;
      car.nextRouteReview = this.sim.time + 50;
      car.behaviour = { kind: 'diversion', description: 'Taking a quieter way around a queue', savedSeconds: Math.round(saved), until: this.sim.time + 35 };
      this.rerouted++;
      return true;
    }
    // A minority of patient drivers turn around, and only when the queue is on
    // their present road: changing the next junction cannot escape that queue.
    if (car.type === 'car' && car.id % 5 === 0 && car.v < 14) {
      let nearbyDelay = 0;
      for (let i = car.index; i < car.route.length && car.offsets[i] - car.q < 200; i++) nearbyDelay += this.delay.get(car.route[i]) || 0;
      if (nearbyDelay > 50) this.tryTurnaround(car, destination);
    }
    return true;
  }
  turnSpace(car, edge, centre, radius) {
    if (this.sim.turnaroundAllowed?.(car, edge, centre, radius) === false) return false;
    if (this.sim.parking.byEdge.has(edge.id)) return false;
    for (const turn of this.turns.values()) if (turn.car !== car && (turn.edge.id === edge.id || turn.reverse.id === edge.id)) return false;
    const reverse = this.sim.data.edges.find(e => e.way === edge.way && e.from === edge.to && e.to === edge.from);
    if (!reverse) return false;
    const occupied = this.sim.occupancy();
    for (const candidate of [edge, reverse]) {
      const middle = candidate.id === edge.id ? centre : edge.length - centre;
      for (const pass of this.sim.busOvertaking?.passes.values() || []) for (const span of pass.spans) {
        const start = candidate.id === span.edge.id ? span.start : candidate.id === span.reverse.id ? span.reverseStart : null;
        const end = candidate.id === span.edge.id ? span.end : span.reverseEnd;
        if (start !== null && start < middle + radius + 2 && end > middle - radius - 2) return false;
      }
      for (const fragment of occupied.get(`${candidate.id}:0`) || []) {
        if (fragment.car === car) continue;
        const braking = fragment.car.v * fragment.car.v / 4 + fragment.car.v * 1.2;
        if (fragment.end + braking > middle - radius - 2 && fragment.start < middle + radius + 2) return false;
      }
    }
    return reverse;
  }
  tryTurnaround(car, destination = car.destination) {
    const edge = this.sim.data.edges[car.route[car.index]];
    if (car.type !== 'car' || car.v >= 14 || this.hasCommitment(car) || !LOCAL_ROADS.has(edge.tags.highway) || edge.speed > 14 || laneCount(edge) !== 1 || edge.tags.junction || edge.tags.bridge || edge.tags.tunnel || edge.restoredUnderpass || ['yes', '1', 'true', '-1'].includes(edge.tags.oneway)) return false;
    // Notice a queue before joining it. A reserved pocket lets the driver stop
    // gently without a following vehicle taking the space needed to reverse.
    const preparing = car.v >= 0.5;
    const stopQ = car.q + car.v * car.v / 4 + car.minGap + 1;
    const centre = car.d - car.length / 2 + (preparing ? car.v * car.v / 4 + 1 : 0), radius = Math.max(18, car.length + 5);
    if (centre < radius + 10 || edge.length - centre < radius + 10) return false;
    const p = position(edge, centre - radius), q = position(edge, centre + radius);
    if (p.dx * q.dx + p.dy * q.dy < 0.995) return false;
    const reverse = this.turnSpace(car, edge, centre, radius);
    if (!reverse) return false;
    const path = findRoute(this.graph(car.type), reverse.to, destination, reverse, e => this.cost(e));
    if (!path) return false;
    const forwardCost = (edge.length - car.d) / edge.speed + (this.delay.get(edge.id) || 0) + this.pathCost(car.route.slice(car.index + 1));
    const returnCost = centre / edge.speed + this.pathCost(path) + 14;
    if (forwardCost - returnCost < Math.max(28, forwardCost * 0.22)) return false;
    const turn = { car, edge, reverse, centre, radius, path, elapsed: 0, previousElapsed: 0, duration: 14, preparing, stopQ, startedAt: this.sim.time, phase: preparing ? 'Stopping to turn' : 'Turning across', reversing: false };
    car.turnaround = turn;
    if (!preparing) car.v = 0;
    car.behaviour = { kind: 'three-point-turn', description: 'Turning around to avoid a long queue', until: this.sim.time + 50, savedSeconds: Math.round(forwardCost - returnCost) };
    this.turns.set(car.id, turn);
    // A turn owns both carriageways, rather than a junction it will no longer use.
    for (const [node, claims] of this.sim.reservations) {
      const kept = claims.filter(r => r.car !== car);
      if (kept.length) this.sim.reservations.set(node, kept); else this.sim.reservations.delete(node);
    }
    return true;
  }
  gap(car) {
    let gap = car.turnaround?.preparing ? Math.max(0, car.turnaround.stopQ - car.q) : Infinity;
    for (const turn of this.turns.values()) {
      if (turn.car === car) continue;
      for (let i = car.index; i < car.route.length; i++) {
        const id = car.route[i];
        const middle = id === turn.edge.id ? turn.centre : id === turn.reverse.id ? turn.edge.length - turn.centre : null;
        if (middle === null) continue;
        const line = car.offsets[i] + middle - turn.radius;
        if (car.q - car.length > car.offsets[i] + middle + turn.radius) continue;
        gap = Math.min(gap, Math.max(0, line - car.q));
      }
    }
    return gap;
  }
  spawnAllowed(car) {
    for (const turn of this.turns.values()) for (let i = 0; i <= car.index; i++) {
      const id = car.route[i], middle = id === turn.edge.id ? turn.centre : id === turn.reverse.id ? turn.edge.length - turn.centre : null;
      if (middle !== null && car.q > car.offsets[i] + middle - turn.radius - 4 && car.q - car.length < car.offsets[i] + middle + turn.radius + 4) return false;
    }
    return true;
  }
  update(dt) {
    for (const [id, turn] of this.turns) {
      if (!this.sim.cars.includes(turn.car)) { this.turns.delete(id); continue; }
      if (turn.preparing) {
        if (turn.car.v < 0.35) {
          const centre = turn.car.d - turn.car.length / 2;
          if (this.turnSpace(turn.car, turn.edge, centre, turn.radius)) {
            turn.centre = centre;
            turn.preparing = false;
            turn.car.v = 0;
          } else {
            turn.car.turnaround = null;
            turn.car.behaviour = null;
            turn.car.nextRouteReview = this.sim.time + 35;
            this.turns.delete(id);
            continue;
          }
        } else if (this.sim.time - turn.startedAt > 20) {
          turn.car.turnaround = null;
          turn.car.behaviour = null;
          turn.car.nextRouteReview = this.sim.time + 35;
          this.turns.delete(id);
          continue;
        } else continue;
      }
      turn.previousElapsed = turn.elapsed;
      turn.elapsed = Math.min(turn.duration, turn.elapsed + dt);
      turn.reversing = turn.elapsed >= 4.8 && turn.elapsed < 9.2;
      turn.phase = turn.elapsed < 4.8 ? 'Turning across' : turn.reversing ? 'Reversing carefully' : 'Heading back';
      turn.car.stopped += dt;
      turn.car.delay += dt;
      this.sim.totalDelay += dt;
      if (turn.elapsed < turn.duration) continue;
      const car = turn.car;
      this.install(car, [turn.reverse.id, ...turn.path], 0);
      car.q = turn.edge.length - turn.centre + car.length / 2;
      car.index = 0;
      car.d = car.q;
      car.stopped = 0;
      car.turnaround = null;
      car.nextRouteReview = this.sim.time + 90;
      car.reroutes = (car.reroutes || 0) + 1;
      this.sim.parking.prepare(car);
      this.turns.delete(id);
      this.threePointTurns++;
    }
    if (this.sim.time >= this.nextSample) { this.sample(); this.nextSample = this.sim.time + 2; }
    if (this.sim.time >= this.nextReview) {
      // Spread path searches across ticks: a rush-hour crowd should not cause a
      // single visible pause every time all drivers reconsider their journeys.
      this.reviewCommitments = new Set();
      for (const zone of this.sim.parking.zones) for (const id of zone.claims.keys()) this.reviewCommitments.add(id);
      for (const claims of this.sim.reservations.values()) for (const r of claims) if (r.crossing > r.car.q) this.reviewCommitments.add(r.car.id);
      let searched = 0;
      for (let scanned = 0; scanned < Math.min(256, this.sim.cars.length) && searched < 8; scanned++) {
        const car = this.sim.cars[this.reviewCursor++ % this.sim.cars.length];
        if (this.consider(car)) searched++;
      }
      this.reviewCommitments = null;
      this.nextReview = this.sim.time + 0.2;
    }
  }
}

const TURN_ANGLE = 65 * Math.PI / 180;
const REVERSE_RADIUS = 1.2;
function localTurnPose(time, lane) {
  const radius = (lane + REVERSE_RADIUS * Math.cos(TURN_ANGLE)) / (1 - Math.cos(TURN_ANGLE));
  const stage = time < 4.8 ? 0 : time < 9.2 ? 1 : 2;
  const t = Math.max(0, Math.min(1, stage === 0 ? time / 4.8 : stage === 1 ? (time - 4.8) / 4.4 : (time - 9.2) / 4.8));
  const angle = stage === 0 ? TURN_ANGLE * t : stage === 1 ? TURN_ANGLE + (Math.PI - 2 * TURN_ANGLE) * t : Math.PI - TURN_ANGLE + TURN_ANGLE * t;
  return {
    x: stage === 1 ? radius * Math.sin(TURN_ANGLE) - REVERSE_RADIUS * (Math.sin(angle) - Math.sin(TURN_ANGLE)) : radius * Math.sin(angle),
    y: stage === 0 ? lane - radius * (1 - Math.cos(angle)) : stage === 1 ? -REVERSE_RADIUS * Math.cos(angle) : -lane + radius * (1 + Math.cos(angle)),
    angle, reversing: stage === 1,
  };
}
export function turnaroundFits(car, widthFactor) {
  if (!(widthFactor > 0)) return false;
  const limit = 3.3 * widthFactor - 0.5;
  for (let i = 0; i <= 140; i++) {
    const p = localTurnPose(i / 10, 1.55 * widthFactor);
    const extent = Math.abs(p.y) + Math.abs(Math.sin(p.angle)) * car.length / 2 + Math.abs(Math.cos(p.angle)) * car.width * widthFactor / 2;
    if (extent > limit) return false;
  }
  return true;
}
// The body follows three small arcs, reversing on the middle arc. Endpoint
// position and heading exactly match its old/new lane, so changing route is not
// a visual teleport. Width changes affect the same lateral offsets as driving.
export function turnaroundPose(simulation, car, widthFactor = 1, alpha = 1) {
  const turn = car.turnaround;
  if (!turn || turn.preparing) return null;
  const time = turn.previousElapsed + (turn.elapsed - turn.previousElapsed) * Math.max(0, Math.min(1, alpha));
  const local = localTurnPose(time, laneOffset(turn.edge, 0) * widthFactor);
  const p = position(turn.edge, turn.centre + local.x);
  return {
    x: p.x + p.dy * local.y, y: p.y - p.dx * local.y,
    angle: Math.atan2(p.dy, p.dx) + local.angle,
    edge: turn.edge, reversing: local.reversing,
  };
}
