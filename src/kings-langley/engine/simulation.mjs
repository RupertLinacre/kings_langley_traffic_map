import { Closures } from './closures.mjs';
import { AdaptiveTraffic } from './adaptive-traffic.mjs';
import { isCirculatory, junction20Signal } from './junction20.mjs';
import {
  cumulativeWeights,
  sampleCumulative,
  popularityClasses,
  popularityRates,
} from './demand.mjs';
import { Parking } from './parking.mjs';
import { makeGraph, findRoute, position, isSignal } from './graph.mjs';
import {
  VEHICLES,
  idmAcceleration,
  integrate,
  laneCount,
} from './traffic-model.mjs';
export { makeGraph, findRoute, canTurn, position, isSignal } from './graph.mjs';
export {
  laneCount,
  laneOffset,
  VEHICLES,
  idmAcceleration,
} from './traffic-model.mjs';
export function signalState(node, edge, time, cycle = 60, offset = 0) {
  const local = junction20Signal(node.id, time, cycle);
  if (local !== null) return local;
  if (!isSignal(node.tags)) return 'none';
  const direction =
    node.tags['traffic_signals:direction'] || node.tags.direction;
  if (
    (direction === 'forward' && !edge.forward) ||
    (direction === 'backward' && edge.forward)
  )
    return 'none';
  const p = position(edge, edge.length),
    crossing =
      node.tags.highway === 'crossing' ||
      node.tags.crossing === 'traffic_signals' ||
      node.tags['crossing:signals'] === 'yes';
  const axis = Math.abs(p.dx) > Math.abs(p.dy) ? 1 : 0,
    phase =
      (((time + offset + (crossing ? 0 : (axis * cycle) / 2)) % cycle) +
        cycle) %
      cycle;
  const green = crossing ? cycle * 0.72 : cycle / 2 - 5;
  return phase < green ? 'green' : phase < green + 3 ? 'amber' : 'red';
}
const key = (id, lane) => `${id}:${lane}`;
export class Simulation {
  /** @param {unknown} data @param {number} seed @param {import('./network-types').Demand|null} demand */
  constructor(data, seed = 42, demand = null) {
    this.data = data;
    this.graph = makeGraph(data);
    this.parking = new Parking(this);
    this.seed = seed;
    this.time = 0;
    this.cars = [];
    this.completed = 0;
    this.nextId = 0;
    this.generated = 0;
    this.initial = 0;
    this.totalDelay = 0;
    this.completedDelay = 0;
    this.travelTime = 0;
    this.demand = demand;
    this.scheduled = [];
    this.pending = new Map();
    this.pendingFleet = new Map();
    this.pendingTotal = 0;
    this.reservations = new Map();
    this.heldSignals = new Set();
    this.cycle = 60;
    this.busShare = null;
    this.maxVehicles = 3000;
    this.history = [];
    this.edgeStats = new Map();
    this.detectorCounts = new Map();
    this.lastSample = 0;
    this.laneTick = 0;
    this.signalOffsets = new Map();
    this.overrides = new Map();
    this.incoming = new Map();
    for (const e of data.edges) {
      if (!this.incoming.has(e.to)) this.incoming.set(e.to, []);
      this.incoming.get(e.to).push(e);
    }
    const signals = Object.values(data.nodes).filter((n) => isSignal(n.tags));
    for (const n of signals) {
      const neighbour = signals.find(
        (m) =>
          m.id < n.id &&
          n.p &&
          m.p &&
          Math.hypot(n.p[0] - m.p[0], n.p[1] - m.p[1]) < 65,
      );
      this.signalOffsets.set(
        n.id,
        neighbour
          ? (this.signalOffsets.get(neighbour.id) ?? neighbour.id % 37)
          : n.id % 37,
      );
    }
    this.routeSpecs = demand?.routes || [];
    if (!demand) {
      const nodes = [...this.graph.out.keys()];
      for (let i = 0; i < 250 && this.routeSpecs.length < 60; i++) {
        const from = nodes[Math.floor(this.random() * nodes.length)],
          to = nodes[Math.floor(this.random() * nodes.length)],
          path = findRoute(this.graph, from, to);
        if (path?.length)
          this.routeSpecs.push({
            path,
            rate: 20,
            group: 'local',
            fromName: 'Test source',
            toName: 'Test destination',
          });
      }
    }
    this.closures = new Closures(this);
    this.adaptive = new AdaptiveTraffic(this);
    this.routes = this.routeSpecs.map((r) => r.path);
    this.totalRate = this.routeSpecs.reduce((sum, r) => sum + r.rate, 0);
    this.popularityClasses = popularityClasses(data, this.routeSpecs);
    this.setPopularity(1);
    this.arrivalBudget = -Math.log(Math.max(1e-9, this.random()));
    this.detectorEdges = new Map();
    for (const detector of demand?.detectors || []) {
      this.detectorCounts.set(detector.id, 0);
      for (const id of detector.edgeIds) {
        if (!this.detectorEdges.has(id)) this.detectorEdges.set(id, []);
        this.detectorEdges.get(id).push(detector.id);
      }
    }
  }
  setPopularity(n) {
    this.arrivalRates = popularityRates(
      this.routeSpecs.map((r) => r.rate),
      this.popularityClasses,
      n,
    );
    this.popularity = n;
    this.routeCumulative = cumulativeWeights(this.arrivalRates);
    this.seedCumulative = cumulativeWeights(
      this.routeSpecs.map(
        (r, i) =>
          this.arrivalRates[i] *
          r.path.reduce(
            (sum, id) =>
              sum + this.data.edges[id].length / this.data.edges[id].speed,
            0,
          ),
      ),
    );
  }
  random() {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  pickRoute(weightDuration = false) {
    return sampleCumulative(
      weightDuration ? this.seedCumulative : this.routeCumulative,
      this.random(),
    );
  }

  createVehicle(path, type = 'car', distance = 0, lane = 0) {
    const def = VEHICLES[type];
    if (!def) throw Error('Unknown vehicle type');
    const offsets = [0];
    for (const id of path)
      offsets.push(offsets.at(-1) + this.data.edges[id].length);
    let current = Math.min(lane, laneCount(this.data.edges[path[0]]) - 1);
    const lanes = path.map((id, i) => {
      const e = this.data.edges[id],
        next = this.data.edges[path[i + 1]];
      current = Math.min(current, laneCount(e) - 1);
      if (next?.tags.highway === 'motorway_link') current = 0;
      return current;
    });
    let index = 0;
    while (index < path.length - 1 && distance >= offsets[index + 1]) index++;
    const vehicle = {
      ...def,
      length: type === 'car' ? 3.8 + this.random() * 1.4 : def.length,
      id: this.nextId++,
      type,
      route: path,
      offsets,
      lanes,
      index,
      q: distance,
      d: distance - offsets[index],
      v: 0,
      desiredFactor: 0.9 + 0.1 * this.random(),
      born: this.time,
      delay: 0,
      stopped: 0,
      parked: null,
      roadStop: null,
      counted: new Set(),
      destination: this.data.edges[path.at(-1)].to,
    };
    this.parking.prepare(vehicle);
    return vehicle;
  }
  occupancy() {
    const lanes = new Map();
    for (const c of this.cars) {
      if (c.parked) continue;
      for (let i = c.index; i >= 0; i--) {
        const start = c.q - c.length - c.offsets[i],
          end = c.q - c.offsets[i],
          edge = this.data.edges[c.route[i]];
        if (end <= 0) continue;
        if (start >= edge.length) break;
        const k = key(edge.id, c.lanes[i]);
        if (!lanes.has(k)) lanes.set(k, []);
        lanes.get(k).push({
          start: Math.max(0, start),
          end: Math.min(edge.length, end),
          front: end,
          car: c,
        });
        if (start >= 0) break;
      }
    }
    for (const group of lanes.values()) group.sort((a, b) => a.start - b.start);
    return lanes;
  }
  leader(c, occupied, lookahead = 250, startIndex = c.index, startQ = c.q) {
    let nearest = { gap: Infinity, frontGap: Infinity, v: 0, car: null };
    for (let i = startIndex; i < c.route.length; i++) {
      const base = c.offsets[i] - startQ;
      if (base > lookahead) break;
      for (const fragment of occupied.get(key(c.route[i], c.lanes[i])) || []) {
        if (fragment.car === c || base + fragment.end < -0.001) continue;
        const gap = base + fragment.start;
        if (gap < nearest.gap)
          nearest = {
            gap: Math.max(0, gap),
            frontGap: base + fragment.front,
            v: fragment.car.v,
            car: fragment.car,
          };
      }
    }
    return nearest;
  }
  signal(edge) {
    const state = signalState(
      this.data.nodes[edge.to],
      edge,
      this.time,
      this.cycle,
      this.signalOffsets.get(edge.to) || 0,
    );
    return state !== 'none' && this.heldSignals.has(edge.to) ? 'red' : state;
  }
  holdWay(way, hold) {
    for (const e of this.data.edges)
      if (e.way === way && this.signal(e) !== 'none') {
        if (hold) this.heldSignals.add(e.to);
        else this.heldSignals.delete(e.to);
      }
  }
  clearHolds() {
    this.heldSignals.clear();
  }
  // Extension seam for later roadworks: overrides do not alter source map tags.
  setRoadSpeed(edgeIds, factor) {
    if (!(factor > 0 && factor <= 1))
      throw Error('Speed factor must be in (0,1]');
    for (const id of edgeIds) this.overrides.set(id, factor);
  }
  isJunction(edge, next) {
    if (!next) return false;
    const ins = (this.incoming.get(edge.to) || []).filter(
        (p) => p.from !== next.to,
      ),
      outs = (this.graph.out.get(edge.to) || []).filter(
        (e) => e.to !== edge.from,
      );
    return (
      ins.length > 1 ||
      outs.length > 1 ||
      laneCount(edge) > 1 ||
      laneCount(next) > 1
    );
  }
  compatible(a, b) {
    if (a.edge === b.edge && a.next === b.next) return a.lane !== b.lane;
    const ea = this.data.edges[a.edge],
      na = this.data.edges[a.next],
      eb = this.data.edges[b.edge],
      nb = this.data.edges[b.next];
    if (na.id === nb.id)
      return na.tags.highway === 'motorway' && a.lane !== b.lane;
    const pa = position(ea, ea.length),
      qa = position(na, Math.min(5, na.length)),
      pb = position(eb, eb.length),
      qb = position(nb, Math.min(5, nb.length));
    return (
      pa.dx * qa.dx + pa.dy * qa.dy > 0.9 &&
      pb.dx * qb.dx + pb.dy * qb.dy > 0.9 &&
      pa.dx * pb.dx + pa.dy * pb.dy < -0.9
    );
  }
  priority(edge, next) {
    const ranks = {
      motorway: 6,
      trunk: 5,
      primary: 4,
      secondary: 3,
      tertiary: 2,
      residential: 1,
      service: 0,
    };
    let rank = ranks[edge.tags.highway] ?? 1;
    if (isCirculatory(edge.tags)) rank += 10;
    if (isCirculatory(next.tags) && !isCirculatory(edge.tags)) rank -= 5;
    const tag = this.data.nodes[edge.to].tags;
    if (['give_way', 'stop'].includes(tag.highway)) rank -= 2;
    return rank;
  }
  reserve(occupied) {
    // Only the front vehicle in a lane may reserve a crossing. A fast follower
    // must never reserve the junction that its slower leader needs to leave.
    const hasLeader = (c, crossing) => {
      const leader = this.leader(c, occupied, Math.max(250, crossing - c.q));
      return leader.frontGap < crossing - c.q + 0.01;
    };
    for (const [node, claims] of this.reservations) {
      const alive = claims.filter(
        (r) =>
          this.cars.includes(r.car) &&
          !r.car.parked && !r.car.turnaround &&
          r.car.q < r.crossing + r.car.length + 0.5 &&
          !(r.car.q < r.crossing && hasLeader(r.car, r.crossing)) &&
          this.parking.constraint(r.car).gap >= r.crossing - r.car.q &&
          (r.car.q >= r.crossing ||
            Math.min(this.closures.gap(r.car), this.adaptive.gap(r.car)) > r.crossing - r.car.q),
      );
      if (alive.length) this.reservations.set(node, alive);
      else this.reservations.delete(node);
    }
    const requests = [];
    for (const c of this.cars) {
      if (c.parked || c.turnaround) continue;
      const chain = [];
      let horizon = Math.max(25, c.length + 8, c.v * 2);
      for (let i = c.index; i < c.route.length - 1; i++) {
        const edge = this.data.edges[c.route[i]],
          next = this.data.edges[c.route[i + 1]],
          distance = c.offsets[i + 1] - c.q;
        if (
          distance > horizon ||
          this.parking.constraint(c).gap < distance ||
          Math.min(this.closures.gap(c), this.adaptive.gap(c)) <= distance
        )
          break;
        if (!this.isJunction(edge, next)) continue;
        const state = this.signal(edge);
        if (state === 'red' || state === 'amber') break;
        if (this.data.nodes[edge.to].tags.highway === 'stop' && c.stopped < 1)
          break;
        const downstream = this.leader(
          c,
          occupied,
          Math.max(30, c.length + 4),
          i + 1,
          c.offsets[i + 1],
        );
        if (downstream.gap < c.length + 3) break;
        horizon = Math.max(horizon, distance + c.length + 5);
        chain.push({
          car: c,
          edge: edge.id,
          next: next.id,
          lane: c.lanes[i + 1],
          crossing: c.offsets[i + 1],
          priority: this.priority(edge, next),
          eta: distance / Math.max(2, c.v),
        });
      }
      if (chain.length && !chain.some((r) => hasLeader(c, r.crossing)))
        requests.push(chain);
    }
    requests.sort(
      (a, b) =>
        b[0].priority - a[0].priority ||
        a[0].eta - b[0].eta ||
        a[0].car.born - b[0].car.born ||
        a[0].car.id - b[0].car.id,
    );
    for (const chain of requests) {
      // Reserve closely spaced OSM junction nodes atomically. Otherwise a bus
      // can stop before a two-metre connector while waiting to reserve its end.
      const shortConnectors = (claim) =>
        [claim.edge, claim.next]
          .map((id) => this.data.edges[id])
          .filter((e) => e.length < 15);
      const opposingConnector = (a, b) =>
        shortConnectors(a).some((e) =>
          shortConnectors(b).some(
            (f) => e.from === f.to && e.to === f.from && e.way === f.way,
          ),
        );
      const activeClaims = [...this.reservations.values()].flat();
      const feasible = chain.every(
        (r) =>
          activeClaims.every(
            (x) => x.car === r.car || !opposingConnector(r, x),
          ) &&
          (this.reservations.get(this.data.edges[r.edge].to) || []).every(
            (x) => x.car === r.car || this.compatible(r, x),
          ),
      );
      if (!feasible) continue;
      for (const r of chain) {
        const node = this.data.edges[r.edge].to,
          claims = this.reservations.get(node) || [];
        if (!claims.some((x) => x.car === r.car)) {
          claims.push(r);
          this.reservations.set(node, claims);
        }
      }
    }
  }
  chooseType(spec) {
    const mix = spec.mix || { car: 85, van: 10, bus: 1, lorry: 4 };
    const total = Object.values(mix).reduce((s, v) => s + v, 0);
    const bus = this.busShare ?? mix.bus / total;
    const draw = this.random();
    if (draw < bus) return 'bus';
    let remaining = ((draw - bus) / (1 - bus)) * (total - mix.bus);
    for (const type of ['car', 'van', 'lorry']) {
      remaining -= mix[type];
      if (remaining <= 0) return type;
    }
    return 'car';
  }
  seedCars(target = null) {
    if (!this.routes.length) return;
    const expected = this.routeSpecs.reduce(
      (s, r, i) =>
        s +
        (this.arrivalRates[i] *
          r.path.reduce(
            (n, id) =>
              n + this.data.edges[id].length / this.data.edges[id].speed,
            0,
          )) /
          3600,
      0,
    );
    const count = target ?? Math.min(1000, Math.round(expected));
    let occupied = this.occupancy();
    for (let i = 0; i < count * 4 && this.cars.length < count; i++) {
      const original = this.routeSpecs[this.pickRoute(true)],
        type = this.chooseType(original),
        spec = this.adaptive.entry(original, type),
        length = spec.path.reduce((s, id) => s + this.data.edges[id].length, 0),
        q = 20 + this.random() * Math.max(1, length - 40),
        lane = Math.floor(
          this.random() * laneCount(this.data.edges[spec.path[0]]),
        ),
        c = this.createVehicle(spec.path, type, q, lane);
      if (
        c.parkingPassages.some(
          (p) => c.q > p.entry - 20 && c.q - c.length < p.exit + 20,
        )
      )
        continue;
      const edge = this.data.edges[c.route[c.index]];
      c.v = Math.min(edge.speed, c.maxSpeed) * 0.65;
      if (this.crossingSpawnAllowed?.(c) === false || !this.adaptive.spawnAllowed(c)) continue;
      const spans = [];
      for (
        let j = c.index;
        j >= 0 &&
        c.q - c.length - c.offsets[j] < this.data.edges[c.route[j]].length;
        j--
      ) {
        const start = Math.max(0, c.q - c.length - c.offsets[j]),
          end = Math.min(
            this.data.edges[c.route[j]].length,
            c.q - c.offsets[j],
          );
        if (end > 0)
          spans.push({ key: key(c.route[j], c.lanes[j]), start, end });
      }
      if (
        spans.some((s) =>
          (occupied.get(s.key) || []).some(
            (f) => s.end + 15 > f.start && s.start - 15 < f.end,
          ),
        )
      )
        continue;
      c.born = -c.q / Math.max(1, c.v);
      this.cars.push(c);
      this.initial++;
      occupied = this.occupancy();
    }
  }
  schedule(events) {
    this.scheduled.push(...events);
    this.scheduled.sort((a, b) => a.at - b.at);
  }
  enqueue(id, type) {
    this.pending.set(id, (this.pending.get(id) || 0) + 1);
    if (!this.pendingFleet.has(id)) this.pendingFleet.set(id, []);
    this.pendingFleet.get(id).push(type);
    this.pendingTotal++;
    this.generated++;
  }
  arrivals(dt, multiplier) {
    while (this.scheduled.length && this.scheduled[0].at <= this.time) {
      const event = this.scheduled.shift();
      this.enqueue(event.route, event.type);
    }
    if (this.totalRate <= 0) return;
    this.arrivalBudget -= ((this.totalRate * multiplier) / 3600) * dt;
    while (this.arrivalBudget <= 0) {
      const id = this.pickRoute();
      this.enqueue(id, this.chooseType(this.routeSpecs[id]));
      this.arrivalBudget += -Math.log(Math.max(1e-9, this.random()));
    }
  }
  insert(occupied) {
    if (this.cars.length >= this.maxVehicles) return;
    for (const [id, count] of this.pending) {
      if (!count) continue;
      const original = this.closures.entry(id);
      if (!original) continue;
      const type = this.pendingFleet.get(id)[0],
        spec = this.adaptive.entry(original, type),
        edge = this.data.edges[spec.path[0]];
      let inserted = false;
      const first = Math.floor(this.random() * laneCount(edge));
      for (let i = 0; i < laneCount(edge); i++) {
        const lane = (first + i) % laneCount(edge),
          c = this.createVehicle(spec.path, type, VEHICLES[type].length, lane);
        if (c.q >= c.offsets.at(-1)) continue;
        if (this.crossingSpawnAllowed?.(c) === false || !this.adaptive.spawnAllowed(c) || !this.parking.spawnAllowed(c)) continue;
        const leader = this.leader(c, occupied);
        if (leader.gap < 3) continue;
        let intersects = false;
        for (let j = 0; j <= c.index; j++) {
          const a = Math.max(0, c.q - c.length - c.offsets[j]),
            b = Math.min(
              this.data.edges[c.route[j]].length,
              c.q - c.offsets[j],
            );
          if (
            b > 0 &&
            (occupied.get(key(c.route[j], c.lanes[j])) || []).some(
              (f) => b + 2 > f.start && a - 2 < f.end,
            )
          )
            intersects = true;
        }
        if (intersects) continue;
        c.specId = id;
        if (spec.roadStop)
          c.roadStop = { ...spec.roadStop, remaining: null, done: false };
        if (
          !c.roadStop &&
          type === 'car' &&
          spec.group !== 'scenario' &&
          this.random() < 0.12
        ) {
          const visit = c.parkingPassages.find(
            (p) => p.zone.id === 'high-street' && p.entry > c.q + 30,
          );
          if (visit)
            c.roadStop = {
              q: visit.exit - 8,
              duration: 120 + this.random() * 120,
              parkingZone: 'high-street',
              remaining: null,
              done: false,
            };
        }
        this.parking.claimSpawn(c);
        this.cars.push(c);
        this.pendingTotal--;
        this.pendingFleet.get(id).shift();
        if (count === 1) {
          this.pending.delete(id);
          this.pendingFleet.delete(id);
        } else this.pending.set(id, count - 1);
        occupied = this.occupancy();
        inserted = true;
        break;
      }
      if (inserted && this.cars.length >= this.maxVehicles) break;
    }
  }
  changeLanes(occupied) {
    for (const c of this.cars) {
      if (
        c.parked || c.turnaround ||
        c.parkingPassages.some(
          (p) => p.zone.narrow && c.q > p.entry - 30 && c.q < p.exit + 20,
        )
      )
        continue;
      if (c.roadStop && !c.roadStop.done && c.roadStop.q - c.q < 40) continue;
      const edge = this.data.edges[c.route[c.index]],
        lane = c.lanes[c.index];
      if (laneCount(edge) < 2 || c.d < c.length + 8 || edge.length - c.d < 80)
        continue;
      const old = this.leader(c, occupied),
        base = idmAcceleration(
          c,
          Math.min(edge.speed, c.maxSpeed),
          old.gap,
          old.v,
        );
      for (const target of [lane - 1, lane + 1]) {
        if (target < 0 || target >= laneCount(edge)) continue;
        const traffic = occupied.get(key(edge.id, target)) || [];
        if (
          traffic.some(
            (f) =>
              f.end > c.d - c.length - Math.max(3, f.car.v * 1.2) &&
              f.start < c.d + Math.max(3, c.v * 1.2),
          )
        )
          continue;
        c.lanes[c.index] = target;
        const next = this.leader(c, occupied),
          advantage =
            idmAcceleration(
              c,
              Math.min(edge.speed, c.maxSpeed),
              next.gap,
              next.v,
            ) - base;
        if (advantage > 0.4 || (target < lane && advantage > -0.05)) {
          for (let j = c.index + 1; j < c.route.length; j++) {
            const e = this.data.edges[c.route[j]];
            if (e.tags.highway.endsWith('_link')) break;
            c.lanes[j] = Math.min(target, laneCount(e) - 1);
          }
          occupied = this.occupancy();
          break;
        }
        c.lanes[c.index] = lane;
      }
    }
    return occupied;
  }
  step(dt, multiplier = 1) {
    if (!(dt > 0 && dt <= 0.2))
      throw Error('Use a fixed timestep no greater than 0.2 s');
    if (!(multiplier >= 0 && multiplier <= 4))
      throw Error('Demand multiplier must be 0–4');
    this.closures.updateCars();
    this.adaptive.update(dt);
    this.arrivals(dt, multiplier);
    let occupied = this.occupancy();
    this.insert(occupied);
    occupied = this.occupancy();
    if (this.time >= this.laneTick) {
      occupied = this.changeLanes(occupied);
      this.laneTick = this.time + 1;
    }
    this.parking.update(dt, occupied);
    occupied = this.occupancy();
    this.reserve(occupied);
    const updates = [];
    for (const c of this.cars) {
      if (c.parked || (c.turnaround && !c.turnaround.preparing)) continue;
      // A driver finding full bays carries on instead of waiting inside the
      // single-track section and trapping the parked cars that must leave first.
      if (
        c.roadStop?.parkingZone &&
        !c.roadStop.done &&
        c.roadStop.remaining === null &&
        c.roadStop.q - c.q < 30
      ) {
        const zone = this.parking.zones.find(
          (z) => z.id === c.roadStop.parkingZone,
        );
        if (zone && this.parking.count(zone) >= zone.capacity) {
          c.roadStop.done = true;
          this.parking.missed++;
        }
      }
      const restriction = this.parking.constraint(c);
      const edge = this.data.edges[c.route[c.index]],
        leader = this.leader(c, occupied),
        desired =
          Math.min(
            c.maxSpeed,
            restriction.speed,
            edge.speed * c.desiredFactor,
            isCirculatory(edge.tags) ? 8 : Infinity,
          ) * (this.overrides.get(edge.id) || 1);
      const diversionGap = Math.min(this.closures.gap(c), this.adaptive.gap(c));
      let gap = Math.min(leader.gap, restriction.gap, diversionGap),
        leaderSpeed =
          restriction.gap < leader.gap || diversionGap < leader.gap
            ? 0
            : leader.v;
      // Look across multiple shape edges: a bus's rear or a queue can occupy the upstream edge.
      const lookahead = Math.max(180, (c.v * c.v) / 3 + 20);
      for (let i = c.index; i < c.route.length; i++) {
        const e = this.data.edges[c.route[i]],
          distance = c.offsets[i + 1] - c.q;
        // The miniature's pavement system supplies occupied crossing stop lines.
        // A zebra can be midway along a long edge, well before its junction.
        // Check its own distance before limiting the search by that edge's end.
        const crossingDistance = c.offsets[i] + (this.crossingStop?.(c, e) ?? Infinity) - c.q;
        if (crossingDistance <= lookahead && crossingDistance < gap) {
          gap = Math.max(0, crossingDistance);
          leaderSpeed = 0;
        }
        if (distance > lookahead) break;
        const state = this.signal(e);
        if ((state === 'red' || state === 'amber') && distance < gap) {
          gap = Math.max(0, distance);
          leaderSpeed = 0;
        }
        {
          const next = this.data.edges[c.route[i + 1]];
          if (
            this.isJunction(e, next) &&
            !(this.reservations.get(e.to) || []).some((r) => r.car === c) &&
            distance < gap
          ) {
            gap = Math.max(0, distance);
            leaderSpeed = 0;
          }
        }
      }
      const stop = c.roadStop && !c.roadStop.done ? c.roadStop : null;
      if (stop && stop.remaining !== null) {
        updates.push({ c, move: 0, v: 0, desired });
        continue;
      }
      const stopDistance = stop ? Math.max(0, stop.q - c.q) : Infinity;
      if (stopDistance + c.minGap < gap) {
        gap = stopDistance + c.minGap;
        leaderSpeed = 0;
      }
      const acc = idmAcceleration(c, desired, gap, leaderSpeed),
        result = integrate(c.v, acc, dt);
      const move = Math.max(0, Math.min(result.move, gap - 0.25, stopDistance));
      updates.push({
        c,
        move,
        v: move + 1e-8 < result.move ? Math.min(result.v, move / dt) : result.v,
        desired,
      });
    }
    // Commit only after every acceleration has been computed from the same snapshot.
    const finished = new Set();
    for (const { c, move, v, desired } of updates) {
      c.q += move;
      c.v = v;
      const stop = c.roadStop;
      if (stop && !stop.done) {
        if (stop.remaining !== null) {
          stop.remaining = Math.max(0, stop.remaining - dt);
          if (stop.remaining < 1e-8) {
            stop.remaining = 0;
            stop.done = true;
          }
        } else if (stop.q - c.q <= 0.25 && v < 0.2) {
          if (stop.parkingZone) this.parking.tryPark(c);
          else stop.remaining = stop.duration;
          c.v = 0;
        }
      }
      c.stopped = v < 0.2 ? c.stopped + dt : 0;
      const delay = dt * Math.max(0, 1 - v / Math.max(0.1, desired));
      c.delay += delay;
      this.totalDelay += delay;
      while (c.index < c.route.length && c.q >= c.offsets[c.index + 1]) {
        for (const detector of this.detectorEdges.get(c.route[c.index]) || []) {
          if (!c.counted.has(detector)) {
            this.detectorCounts.set(
              detector,
              (this.detectorCounts.get(detector) || 0) + 1,
            );
            c.counted.add(detector);
          }
        }
        c.index++;
      }
      if (c.index === c.route.length) {
        const spec = this.routeSpecs[c.specId];
        if (spec?.returnRoute !== undefined)
          this.schedule([
            {
              at: Math.max(this.time + dt + spec.dwell, spec.releaseAfter || 0),
              route: spec.returnRoute,
              type: c.type,
            },
          ]);
        finished.add(c.id);
        this.completed++;
        this.completedDelay += c.delay;
        this.travelTime += this.time - c.born;
      } else c.d = c.q - c.offsets[c.index];
    }
    this.cars = this.cars.filter((c) => !finished.has(c.id));
    this.time += dt;
    if (this.time - this.lastSample >= 5) {
      this.lastSample = this.time;
      const stats = this.metrics();
      this.history.push({
        time: this.time,
        waiting: stats.waiting,
        active: stats.cars,
        backlog: this.pendingTotal,
        speed: stats.meanSpeed,
      });
      if (this.history.length > 120) this.history.shift();
    }
  }
  metrics() {
    const edgeStats = new Map();
    let waiting = 0,
      speed = 0;
    for (const c of this.cars) {
      if (c.parked) continue;
      speed += c.v;
      if (c.v < 0.5) waiting++;
      const id = c.route[c.index];
      if (!edgeStats.has(id))
        edgeStats.set(id, { count: 0, waiting: 0, speed: 0, queueMetres: 0 });
      const entry = edgeStats.get(id);
      entry.count++;
      entry.speed += c.v;
      if (c.v < 0.5) {
        entry.waiting++;
        entry.queueMetres += c.length + c.minGap;
      }
    }
    for (const s of edgeStats.values()) s.speed /= s.count;
    this.edgeStats = edgeStats;
    return {
      cars: this.cars.filter((c) => !c.parked).length,
      parked:
        this.cars.filter((c) => c.parked).length +
        this.parking.zones.reduce((n, z) => n + z.baseline, 0),
      parkingMissed: this.parking.missed,
      waiting,
      completed: this.completed,
      time: this.time,
      backlog: this.pendingTotal,
      meanSpeed:
        (speed / Math.max(1, this.cars.filter((c) => !c.parked).length)) *
        2.23694,
      delay: this.completed ? this.completedDelay / this.completed : 0,
      longestQueue: Math.max(
        0,
        ...[...edgeStats.values()].map((s) => s.queueMetres),
      ),
      capped: this.cars.length >= this.maxVehicles,
    };
  }
}
