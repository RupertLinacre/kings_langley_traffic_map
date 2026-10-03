import { isSignal, position } from './graph.mjs';
import { laneCount, laneOffset } from './traffic-model.mjs';

const TRANSITION_SECONDS = 2.4;
const PASS_SPEED = 6;
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// A pass owns a short, straight piece of BOTH carriageways. The bus remains a
// normal obstacle for everybody else, and the claim lasts through the merge.
export class BusOvertaking {
  constructor(simulation) {
    this.sim = simulation;
    this.passes = new Map();
    this.reverse = new Map();
    const paired = new Map(simulation.data.edges.map(e => [`${e.way}:${e.from}:${e.to}`, e]));
    for (const edge of simulation.data.edges) {
      const reverse = paired.get(`${edge.way}:${edge.to}:${edge.from}`);
      if (reverse) this.reverse.set(edge.id, reverse);
    }
  }
  authoritativeBlend(car) {
    const pass = car.busPass;
    if (!pass) return 0;
    if (pass.phase === 'out') return smooth(pass.elapsed / TRANSITION_SECONDS);
    if (pass.phase === 'return') return 1 - smooth(pass.elapsed / TRANSITION_SECONDS);
    return 1;
  }
  blend(car, alpha = 1) {
    const current = this.authoritativeBlend(car);
    return car.busPass ? (car.busPass.previousBlend ?? current) + (current - (car.busPass.previousBlend ?? current)) * Math.max(0, Math.min(1, alpha)) : 0;
  }
  lateral(car, edge, _d, normal, alpha = 1) {
    if (!car.busPass || !car.busPass.spans.some(s => s.edge.id === edge.id)) return normal;
    return normal * (1 - 2 * this.blend(car, alpha));
  }
  steering(car, widthFactor = 1, _alpha = 1) {
    const pass = car.busPass;
    if (!pass || !pass.stepDt) return 0;
    const rate = (this.authoritativeBlend(car) - pass.previousBlend) / pass.stepDt;
    const edge = this.sim.data.edges[car.route[car.index]];
    const yaw = Math.atan2(2 * laneOffset(edge, 0) * widthFactor * rate, Math.max(1.5, car.v));
    return Math.max(-0.2, Math.min(0.2, yaw));
  }
  occupiesOwnLane(car) {
    return !car.busPass || car.busPass.phase !== 'passing';
  }
  oppositeFragment(car, edge, start, end) {
    if (!car.busPass || this.blend(car) <= 0.001) return null;
    const reverse = this.reverse.get(edge.id);
    return reverse ? { edge: reverse, start: reverse.length - end, end: reverse.length - start } : null;
  }
  skipsBus(car, bus) {
    return car.busPass?.bus === bus && car.busPass.phase !== 'out';
  }
  busHeld(bus) {
    return [...this.passes.values()].some(pass => pass.bus === bus);
  }
  releaseMissing() {
    const present = new Set(this.sim.cars);
    for (const [id, pass] of this.passes) {
      if (present.has(pass.car)) continue;
      pass.car.busPass = null;
      this.passes.delete(id);
    }
  }
  speed(car) {
    return !car.busPass ? Infinity : car.busPass.phase === 'out' ? 3 : car.busPass.phase === 'return' ? 4 : PASS_SPEED;
  }
  nearJunction(nodeId) {
    const node = this.sim.data.nodes[nodeId];
    const neighbours = new Set([
      ...(this.sim.graph.out.get(nodeId) || []).map(e => e.to),
      ...(this.sim.incoming.get(nodeId) || []).map(e => e.from),
    ]);
    return isSignal(node.tags) || ['crossing', 'mini_roundabout', 'give_way', 'stop'].includes(node.tags.highway) ||
      Boolean(node.tags.crossing) || neighbours.size > 2;
  }
  corridor(car, fromQ, toQ) {
    if (fromQ < 0 || toQ >= car.offsets.at(-1) - 2) return null;
    const spans = [];
    let direction = null;
    for (let i = 0; i < car.route.length; i++) {
      if (car.offsets[i + 1] <= fromQ || car.offsets[i] >= toQ) continue;
      const edge = this.sim.data.edges[car.route[i]], reverse = this.reverse.get(edge.id);
      const start = Math.max(0, fromQ - car.offsets[i]), end = Math.min(edge.length, toQ - car.offsets[i]);
      const tags = edge.tags;
      const width = Number.parseFloat(tags.width) || 6.6;
      if (!reverse || laneCount(edge) !== 1 || laneCount(reverse) !== 1 ||
          !['primary', 'secondary', 'tertiary', 'unclassified', 'residential'].includes(tags.highway) ||
          tags.junction || tags.bridge && tags.bridge !== 'no' || tags.tunnel && tags.tunnel !== 'no' || edge.restoredUnderpass ||
          tags.overtaking === 'no' || tags[`overtaking:${edge.forward ? 'forward' : 'backward'}`] === 'no' ||
          width < car.width + 2.5 + 0.8 || this.sim.closures.ways.has(edge.way)) return null;
      if (this.nearJunction(edge.from) && start < 18 || this.nearJunction(edge.to) && edge.length - end < 18) return null;
      const parking = this.sim.parking.byEdge.get(edge.id);
      if (parking?.zone.narrow && start < parking.end + 12 && end > parking.start - 12) return null;
      if (this.sim.busPassAllowed?.(car, edge, start, end) === false) return null;
      const samples = [start, (start + end) / 2, end];
      let pointDistance = 0;
      for (let n = 1; n < edge.points.length; n++) {
        pointDistance += Math.hypot(edge.points[n][0] - edge.points[n - 1][0], edge.points[n][1] - edge.points[n - 1][1]);
        if (pointDistance > start && pointDistance < end) samples.push(pointDistance - 0.001, pointDistance + 0.001);
      }
      for (const d of samples) {
        const p = position(edge, d);
        if (direction && direction.dx * p.dx + direction.dy * p.dy < 0.985) return null;
        direction ??= p;
      }
      if (spans.length) {
        const previous = spans.at(-1);
        if (this.sim.isJunction(previous.edge, edge)) return null;
      }
      spans.push({ edge, reverse, index: i, start, end, reverseStart: reverse.length - end, reverseEnd: reverse.length - start });
    }
    return spans.length ? spans : null;
  }
  overlaps(a, b) {
    return a.some(x => b.some(y => (x.edge.id === y.edge.id || x.edge.id === y.reverse.id) && x.start < (x.edge.id === y.edge.id ? y.end : y.reverseEnd) && x.end > (x.edge.id === y.edge.id ? y.start : y.reverseStart)));
  }
  approaching(car, spans, horizon) {
    // Check the complete approaching route, including traffic on a preceding
    // shape edge. Looking at just the opposite edge misses imminent arrivals.
    for (let i = Math.max(0, car.index - 2); i < car.route.length; i++) {
      const id = car.route[i];
      for (const span of spans) {
        if (id !== span.reverse.id) continue;
        const entry = car.offsets[i] + span.reverseStart, exit = car.offsets[i] + span.reverseEnd;
        if (car.q - car.length >= exit + 2) continue;
        if (car.q >= entry - 2) return true;
        const distance = entry - car.q;
        const approachSpeed = Math.max(car.v, ...car.route.slice(car.index, i + 1).map(routeId => this.sim.data.edges[routeId].speed));
        const futureSpeed = Math.min(car.maxSpeed, approachSpeed);
        const braking = car.v * car.v / (2 * Math.max(1, car.b)) + car.v * 1.5 + 5;
        if (distance < braking || distance / Math.max(2, futureSpeed) < horizon) return true;
      }
    }
    return false;
  }
  tryPass(car, occupied = this.sim.occupancy()) {
    if (!['car', 'van'].includes(car.type) || car.busPass || car.parked || car.parkingActivity || car.turnaround || car.v > 5 ||
        car.roadStop && !car.roadStop.done) return false;
    const leader = this.sim.leader(car, occupied, 80), bus = leader.car;
    if (!bus || bus.type !== 'bus' || bus.v > 0.2 || !bus.roadStop || bus.roadStop.done ||
        !Number.isFinite(bus.roadStop.remaining) || bus.roadStop.remaining < 4 || leader.gap > 40 || this.busHeld(bus)) return false;
    const busIndex = car.route.indexOf(bus.route[bus.index], car.index);
    if (busIndex < 0) return false;
    const busFrontQ = car.offsets[busIndex] + bus.d;
    const returnStartQ = busFrontQ + car.length + 3;
    const endQ = returnStartQ + PASS_SPEED * TRANSITION_SECONDS + 8;
    const spans = this.corridor(car, car.q - car.length - 0.75, endQ);
    if (!spans || [...this.passes.values()].some(pass => this.overlaps(spans, pass.spans))) return false;
    if (Math.min(this.sim.adaptive.gap(car), this.sim.closures.gap(car)) < endQ - car.q) return false;
    for (const span of spans) {
      for (const fragment of occupied.get(`${span.edge.id}:0`) || []) {
        if (fragment.car === car || fragment.car === bus) continue;
        if (fragment.end + 1 > span.start && fragment.start - 2 < span.end) return false;
      }
    }
    const distance = returnStartQ - car.q;
    const horizon = TRANSITION_SECONDS * 2 + Math.sqrt(2 * Math.max(0, distance) / Math.max(0.5, car.a)) + distance / PASS_SPEED + 4;
    if (this.sim.cars.some(other => other !== car && other !== bus && !other.parked && this.approaching(other, spans, horizon))) return false;
    const pass = { car, bus, busFrontQ, returnStartQ, endQ, spans, phase: 'out', elapsed: 0, previousBlend: 0, stepDt: 0 };
    car.busPass = pass;
    car.behaviour = { kind: 'passing-bus', description: 'Carefully passing a stopped bus', until: this.sim.time + horizon };
    this.passes.set(car.id, pass);
    return true;
  }
  update(dt, occupied) {
    this.releaseMissing();
    for (const [id, pass] of this.passes) {
      pass.previousBlend = this.authoritativeBlend(pass.car);
      pass.stepDt = dt;
      pass.elapsed += dt;
      if (pass.phase === 'out' && pass.elapsed >= TRANSITION_SECONDS) { pass.phase = 'passing'; pass.elapsed = 0; }
      if (pass.phase === 'passing' && pass.car.q >= pass.returnStartQ) { pass.phase = 'return'; pass.elapsed = 0; }
      if (pass.phase === 'return' && pass.elapsed >= TRANSITION_SECONDS) {
        pass.car.busPass = null;
        pass.car.closureBarrierRevision = -1;
        this.passes.delete(id);
      }
    }
    // Recompute after each claim so two queued cars cannot win the same pocket.
    if (!this.sim.cars.some(car => car.type === 'bus' && car.roadStop && !car.roadStop.done && car.roadStop.remaining !== null && car.roadStop.remaining >= 4 && car.v < 0.2)) return;
    for (const car of this.sim.cars) if (this.tryPass(car, occupied)) occupied = this.sim.occupancy();
  }
  gap(car) {
    let gap = Infinity;
    for (const pass of this.passes.values()) {
      if (pass.car === car || pass.bus === car) continue;
      for (let i = car.index; i < car.route.length; i++) for (const span of pass.spans) {
        const id = car.route[i], start = id === span.edge.id ? span.start : id === span.reverse.id ? span.reverseStart : null;
        if (start === null) continue;
        const end = id === span.edge.id ? span.end : span.reverseEnd;
        if (car.q - car.length > car.offsets[i] + end + 1) continue;
        gap = Math.min(gap, Math.max(0, car.offsets[i] + start - 2 - car.q));
      }
    }
    return gap;
  }
  spawnAllowed(car) {
    for (const pass of this.passes.values()) for (let i = 0; i <= car.index; i++) for (const span of pass.spans) {
      const id = car.route[i], start = id === span.edge.id ? span.start : id === span.reverse.id ? span.reverseStart : null;
      if (start === null) continue;
      const end = id === span.edge.id ? span.end : span.reverseEnd;
      if (car.q > car.offsets[i] + start - 5 && car.q - car.length < car.offsets[i] + end + 5) return false;
    }
    return true;
  }
}
