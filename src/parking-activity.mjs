import { canTurn, findRoute, position } from './kings-langley/engine/graph.mjs';
import { laneOffset } from './kings-langley/engine/traffic-model.mjs';

const COLOURS = ['#8b9290', '#eee5d4', '#426e82', '#b96851', '#c6a357', '#55766a'];
const clamp = t => Math.max(0, Math.min(1, t));
const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const overlaps = (a, b) => a.start < b.end && a.end > b.start;
const legal = (sim, edge) => edge && !sim.closures?.ways.has(edge.way) &&
  !['no', 'private'].includes(edge.tags.access) && !['no', 'private'].includes(edge.tags.motor_vehicle) &&
  !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(edge.tags.highway);

// Finite-stay residents occupy the existing observed bays. Passing traffic can
// use real vacancies; each kerb manoeuvre first owns a bounded swept corridor.
export class ParkingActivity {
  constructor(parking) {
    this.parking = parking;
    this.sim = parking.sim;
    this.enabled = false;
    this.demand = 1;
    this.pockets = new Map();
    this.targets = new Map();
    this.returning = new Map();
    this.nextSearch = 0;
    this.counters = { arrivals: 0, departures: 0, searches: 0, full: 0 };
    this.reverse = new Map();
    for (const edge of this.sim.data.edges) {
      const reverse = this.sim.data.edges.find(other => other.way === edge.way && other.from === edge.to && other.to === edge.from);
      if (reverse) this.reverse.set(edge.id, reverse);
    }
  }
  random() { return this.sim.random ? this.sim.random() : 0.5; }
  enable(enabled = true) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) return;
    for (const zone of this.parking.zones) {
      if (zone.residents) continue;
      zone.residents = new Map();
      for (let slot = 0; slot < zone.baseline; slot++) zone.residents.set(slot, {
        id: `resident:${zone.id}:${slot}`, slot, zone, length: 9, width: 1.8,
        colour: COLOURS[(slot + zone.id.length) % COLOURS.length],
        remaining: this.random() < 0.22 ? 40 + this.random() * 140 : 300 + this.random() * 1500,
      });
      zone.sections = [];
      zone.waitHistory = new Map();
      zone.layoutKey = null;
    }
    this.refreshSections(true);
  }
  visibleSlots(zone) {
    if (!this.enabled) return [...Array.from({ length: zone.baseline }, (_, slot) => ({ slot, resident: true })),
      ...[...zone.parked.values()].map(car => ({ slot: car.parked.slot, car }))];
    return [...zone.residents.values()].map(actor => ({ ...actor, pendingCar: undefined, resident: true }))
      .concat([...zone.parked.values()].map(car => ({ slot: car.parked.slot, car, colour: car.colour,
        direction: car.parked.direction || 1 }))).sort((a, b) => a.slot - b.slot);
  }
  usedSlots(zone) {
    return new Set(this.visibleSlots(zone).map(actor => actor.slot));
  }
  targetKey(zone, slot) { return `${zone.id}:${slot}`; }
  releaseTarget(car) {
    for (const [key, target] of this.targets) if (target.car === car) this.targets.delete(key);
    if (car.parkingSearch?.target) car.parkingSearch.target = null;
  }
  cancel(car) {
    this.releaseTarget(car);
    this.pockets.delete(car.id);
    if (car.parkingActivity?.resident) {
      const actor = car.parkingActivity.resident;
      actor.zone.residents.set(actor.slot, actor);
      actor.zone.baseline = actor.zone.residents.size;
    }
    car.parkingActivity = null;
    car.parkingSearch = null;
    if (car.roadStop?.parkingZone && !car.parked) car.roadStop.done = true;
    for (const zone of this.parking.zones) {
      zone.claims.delete(car.id); zone.waiting.delete(car.id);
      for (const section of zone.sections || []) { section.claims.delete(car.id); section.waiting.delete(car.id); }
      if (zone.parked.get(car.id) === car && !this.sim.cars.includes(car)) zone.parked.delete(car.id);
    }
  }
  releaseMissing() {
    const alive = new Set(this.sim.cars);
    const ids = new Set(this.sim.cars.map(car => car.id));
    for (const target of [...this.targets.values()]) if (!alive.has(target.car)) this.cancel(target.car);
    for (const pocket of [...this.pockets.values()]) if (!alive.has(pocket.car)) this.cancel(pocket.car);
    for (const zone of this.parking.zones) {
      for (const [id, car] of zone.parked) if (!alive.has(car)) zone.parked.delete(id);
      for (const section of zone.sections || []) for (const [id, claim] of section.claims) {
        if (!alive.has(claim.car)) section.claims.delete(id);
      }
      for (const section of zone.sections || []) {
        for (const id of section.waiting.keys()) if (!ids.has(id)) section.waiting.delete(id);
        if (!section.claims.size) { section.direction = 0; section.batch = 0; }
      }
    }
    this.syncClaims(); this.refreshSections();
  }
  reset({ keepResidents = true } = {}) {
    for (const target of [...this.targets.values()]) this.cancel(target.car);
    for (const pocket of [...this.pockets.values()]) this.cancel(pocket.car);
    this.targets.clear(); this.pockets.clear();
    for (const request of this.returning.values()) request.prepared = false;
    for (const zone of this.parking.zones) {
      zone.claims.clear(); zone.waiting.clear();
      for (const section of zone.sections || []) { section.claims.clear(); section.waiting.clear(); section.direction = 0; }
      for (const [id, car] of zone.parked) if (!this.sim.cars.includes(car)) zone.parked.delete(id);
      if (!keepResidents) { zone.residents?.clear(); zone.baseline = 0; }
      zone.waitHistory?.clear();
      zone.reconfiguring = false;
    }
    this.refreshSections(true);
  }
  slotsAlongRoute(car, zone, options = {}) {
    const result = [];
    for (let slot = 0; slot < zone.capacity; slot++) {
      if (options.parkingSlot !== undefined && options.parkingSlot !== slot) continue;
      const p = this.parking.parkedPosition(zone, slot);
      if (options.slotFilter && !options.slotFilter({ zone, slot, position: p })) continue;
      for (let index = car.index; index < car.route.length; index++) {
        const edge = this.sim.data.edges[car.route[index]], reverse = this.reverse.get(p.edge.id);
        const direction = edge.id === p.edge.id ? 1 : edge.id === reverse?.id ? -1 : 0;
        if (!direction || !legal(this.sim, edge)) continue;
        const d = direction === 1 ? p.d : edge.length - p.d;
        // A whole car must fit without reversing through a junction or the end.
        const q = car.offsets[index] + d + car.length / 2 + 3.2;
        if (d < car.length / 2 + 3 || edge.length - d < car.length / 2 + 5 ||
            q < car.q + 3 || q >= car.offsets.at(-1) - 3) continue;
        result.push({ zone, slot, p, index, edge, direction, d, q });
      }
    }
    return result.sort((a, b) => a.q - b.q || a.slot - b.slot);
  }
  request(car, options = {}) {
    if (!this.enabled || !['car', 'van'].includes(car.type) || car.parked || car.parkingActivity) return false;
    const zone = this.parking.zones.find(zone => zone.id === options.zoneId);
    if (!zone || !this.slotsAlongRoute(car, zone, options).length) return false;
    this.releaseTarget(car);
    car.parkingManaged = true;
    car.parkingHold = Boolean(options.holdDeparture);
    car.parkingSearch = { state: 'searching', options: { ...options }, zone, began: this.sim.time,
      firstQ: this.slotsAlongRoute(car, zone, options)[0].q,
      duration: Math.max(8, options.duration ?? 25 + this.random() * 95) };
    this.counters.searches++;
    this.findTarget(car);
    return true;
  }
  findTarget(car) {
    const search = car.parkingSearch;
    if (!search || search.target || !['searching', 'full'].includes(search.state)) return;
    const used = this.usedSlots(search.zone);
    const candidates = this.slotsAlongRoute(car, search.zone, search.options);
    if (!candidates.length) { search.state = 'missed'; this.parking.missed++; return; }
    const target = candidates.find(candidate => !used.has(candidate.slot) && !this.targets.has(this.targetKey(candidate.zone, candidate.slot)));
    if (!target) {
      if (search.state !== 'full') this.counters.full++;
      search.state = 'full';
      return;
    }
    search.target = target; search.state = 'approaching';
    this.targets.set(this.targetKey(target.zone, target.slot), { ...target, car });
    car.roadStop = { q: target.q, parkingZone: target.zone.id, parkingSlot: target.slot,
      duration: search.duration, releaseAfter: search.options.releaseAfter || 0, remaining: null, done: false };
    car.behaviour = { kind: 'parking-search', description: `Found a space on ${target.zone.name}`, until: this.sim.time + 60 };
  }
  spansFor(target, car) {
    // Filling one gap may join two previously separate parked rows. Own that
    // entire prospective shared-lane corridor before moving towards the kerb.
    const section = this.sectionsFor(target.zone, target.slot).find(section => section.slots.includes(target.slot));
    if (!section) return [];
    const spans = [];
    for (const [id, segment] of section.segments) {
      const edge = this.sim.data.edges[id], padding = Math.max(12, car.length / 2 + 7);
      spans.push({ edge, start: Math.max(0, segment.start - padding), end: Math.min(edge.length, segment.end + padding) });
    }
    return spans;
  }
  gap(car) {
    let gap = Infinity;
    for (const pocket of this.pockets.values()) {
      if (pocket.car === car) continue;
      for (let i = car.index; i < car.route.length; i++) for (const span of pocket.spans) {
        if (span.edge.id !== car.route[i] || car.q - car.length > car.offsets[i] + span.end) continue;
        gap = Math.min(gap, Math.max(0, car.offsets[i] + span.start - car.q));
      }
    }
    return gap;
  }
  spawnAllowed(car) {
    for (const pocket of this.pockets.values()) {
      if (pocket.car === car) continue;
      for (let i = 0; i <= car.index; i++) for (const span of pocket.spans) {
        if (span.edge.id !== car.route[i]) continue;
        if (car.q > car.offsets[i] + span.start - 3 && car.q - car.length < car.offsets[i] + span.end + 3) return false;
      }
    }
    return true;
  }
  safePocket(car, target, spans) {
    const s = this.sim;
    if (!legal(s, target.edge) || s.crossingSpawnAllowed?.(car) === false ||
        s.busOvertaking?.spawnAllowed(car) === false || s.adaptive?.spawnAllowed(car) === false ||
        s.parkingManoeuvreAllowed?.(car, target.edge, target.d, car.length / 2 + 10) === false) return false;
    // A new bay may join parked rows far beyond the target itself. Reserve the
    // complete future single-file stretch only when the player's hull is clear
    // of every part of its swept road and pavement corridor.
    for (const span of spans) {
      if (s.parkingCorridorAllowed?.(car, span.edge, span.start, span.end) === false) return false;
      if (!s.parkingCorridorAllowed && s.emergency?.player &&
          s.emergency.corridorAllowed(span.edge, span.start, span.end,
            (s.emergency.body(car)?.roadHalfWidth || 3.3) + 3) === false) return false;
    }
    const occupancy = s.occupancy();
    for (const span of spans) for (const fragment of occupancy.get(`${span.edge.id}:0`) || []) {
      if (fragment.car !== car && overlaps(fragment, { start: span.start - 1, end: span.end + 1 })) return false;
    }
    for (const pocket of this.pockets.values()) {
      if (pocket.car === car) continue;
      if (pocket.spans.some(a => spans.some(b => a.edge.id === b.edge.id && overlaps(a, b)))) return false;
    }
    for (const pass of s.busOvertaking?.passes.values() || []) for (const span of pass.spans) {
      if (spans.some(part => part.edge.id === span.edge.id && overlaps(part, span) ||
        part.edge.id === span.reverse.id && overlaps(part, { start: span.reverseStart, end: span.reverseEnd }))) return false;
    }
    for (const other of s.cars) {
      if (other === car || other.parked) continue;
      const braking = Math.max(1, other.v * 1.6 + other.v ** 2 / (2 * Math.max(1, other.b || 2)));
      for (let index = Math.max(0, other.index - 1); index < other.route.length; index++) {
        if (other.offsets[index] - other.q > braking + 40) break;
        for (const span of spans) {
          if (other.route[index] !== span.edge.id) continue;
          const front = other.q - other.offsets[index], rear = front - other.length;
          if (front + braking > span.start && rear < span.end + 3) return false;
        }
      }
    }
    return true;
  }
  prepareApproach(car) {
    const target = car.parkingSearch?.target;
    if (!target || this.pockets.has(car.id)) return;
    const spans = this.spansFor(target, car);
    let firstEntry = target.q;
    for (let index = car.index; index <= target.index; index++) for (const span of spans) {
      if (car.route[index] === span.edge.id && car.offsets[index] + span.end >= car.q)
        firstEntry = Math.min(firstEntry, car.offsets[index] + span.start);
    }
    if (firstEntry - car.q > Math.max(70, car.v * car.v / 4 + 25)) return;
    const direction = target.zone.segments.get(target.edge.id)?.direction;
    if ([...target.zone.claims.values()].some(claim => claim.car !== car && claim.direction !== direction)) return;
    if (!this.safePocket(car, target, spans)) return;
    this.pockets.set(car.id, { car, target, zone: target.zone, slot: target.slot, spans,
      phase: 'pull-up', preparing: true, elapsed: 0, duration: 60 });
  }
  tryPark(car) {
    const stop = car.roadStop;
    let target = car.parkingSearch?.target;
    if (!target) {
      const zone = this.parking.zones.find(z => z.id === stop?.parkingZone);
      if (!zone) return false;
      const used = this.usedSlots(zone);
      const slot = stop.parkingSlot ?? Array.from({ length: zone.capacity }, (_, i) => i).find(i => !used.has(i));
      if (slot === undefined || used.has(slot)) { stop.done = true; this.parking.missed++; return false; }
      const p = this.parking.parkedPosition(zone, slot), edge = this.sim.data.edges[car.route[car.index]];
      const reverse = this.reverse.get(p.edge.id);
      const direction = edge.id === p.edge.id ? 1 : edge.id === reverse?.id ? -1 : 0;
      if (!direction) return false;
      target = { zone, slot, p, index: car.index, edge, direction, d: direction === 1 ? p.d : edge.length - p.d, q: car.q };
    }
    if (this.usedSlots(target.zone).has(target.slot)) { this.releaseTarget(car); stop.done = true; return false; }
    const spans = this.spansFor(target, car);
    if (!this.safePocket(car, target, spans)) {
      // A missed opportunity must not freeze a queue behind a stopped parker.
      if ((car.stopped || 0) > 12) {
        stop.done = true;
        if (car.parkingSearch) car.parkingSearch.state = 'missed';
        this.releaseTarget(car); this.pockets.delete(car.id); this.parking.missed++;
      }
      return false;
    }
    const centreQ = car.offsets[target.index] + target.d + car.length / 2;
    const activity = { car, zone: target.zone, slot: target.slot, target, spans, phase: 'reverse-in',
      elapsed: 0, previousElapsed: 0, duration: 7 + this.random() * 3, fromQ: car.q,
      targetQ: centreQ, fromLateral: this.parking.lateral(car, target.edge,
        car.q - car.length / 2 - car.offsets[target.index], laneOffset(target.edge, car.lanes[target.index])),
      toLateral: target.p.lateral * target.direction, reversing: true };
    car.parkingActivity = activity; car.parkingManaged = true; car.v = 0;
    this.pockets.set(car.id, activity);
    car.behaviour = { kind: 'parking', description: `Reversing into a space on ${target.zone.name}`, until: this.sim.time + 60 };
    return true;
  }
  routeFromResident(actor) {
    const start = this.parking.parkedPosition(actor.zone, actor.slot).edge;
    if (!legal(this.sim, start)) return null;
    const route = [start.id], seen = new Set(route);
    let current = start, metres = start.length;
    for (let i = 0; i < 8; i++) {
      const choices = (this.sim.graph.out.get(current.to) || []).filter(edge => legal(this.sim, edge) &&
        !seen.has(edge.id) && edge.to !== current.from && canTurn(this.sim.graph, current, edge))
        .sort((a, b) => a.tags.name === current.tags.name ? -1 : b.tags.name === current.tags.name ? 1 : a.id - b.id);
      if (!choices.length) break;
      current = choices[Math.floor(this.random() * Math.min(2, choices.length))];
      route.push(current.id); seen.add(current.id); metres += current.length;
      if (metres > 600) break;
    }
    return route.length > 1 ? route : null;
  }
  departResident(actor) {
    if (this.sim.cars.length >= this.sim.maxVehicles) return false;
    const p = this.parking.parkedPosition(actor.zone, actor.slot);
    if (!actor.pendingCar) {
      const route = this.routeFromResident(actor);
      if (!route) { actor.remaining = 20; return false; }
      const car = this.sim.createVehicle(route, 'car', 0, 0);
      car.length = actor.length; car.colour = car.paint = actor.colour;
      car.q = car.d = p.d + car.length / 2;
      car.parkingManaged = true;
      car.roadStop = { q: car.q, parkingZone: actor.zone.id, parkingSlot: actor.slot, duration: 0, remaining: 0, done: false };
      car.parked = { zone: actor.zone, slot: actor.slot, direction: 1 };
      actor.pendingCar = car;
    }
    const car = actor.pendingCar;
    const target = { zone: actor.zone, slot: actor.slot, p, index: 0, edge: p.edge, direction: 1, d: p.d, q: car.q };
    car.parkingPassages = this.parking.passages(car);
    if (!this.startDeparture(car, target, actor)) {
      actor.nextAttempt = this.sim.time + 0.9 + (actor.slot % 4) * 0.17;
      return false;
    }
    actor.exitRoute = [...car.route];
    actor.pendingCar = null;
    this.sim.cars.push(car); this.sim.generated++;
    return true;
  }
  startDeparture(car, target, resident = null) {
    const spans = this.spansFor(target, car);
    if (!this.safePocket(car, target, spans)) return false;
    // A car joins a compatible group; an opposite group must finish first.
    const direction = target.zone.segments.get(target.edge.id)?.direction;
    if ([...target.zone.claims.values()].some(claim => claim.car !== car && claim.direction !== direction)) return false;
    if ((target.zone.sections || []).some(section => section.direction === direction &&
      [...section.waiting].some(([id, since]) => this.sim.time - since > 50 &&
        this.sim.cars.find(other => other.id === id)?.parkingPassages.some(p => p.zone === target.zone && p.direction !== direction)))) return false;
    const activity = { car, zone: target.zone, slot: target.slot, target, resident, spans, phase: 'merge-out',
      elapsed: 0, previousElapsed: 0, duration: 4.8 + this.random() * 2,
      fromQ: car.q, targetQ: car.q + 3.2,
      fromLateral: target.p.lateral * target.direction,
      toLateral: this.parking.lateral(car, target.edge, target.d + 3.2, laneOffset(target.edge, car.lanes[target.index])), reversing: false };
    car.parked = null; car.parkingActivity = activity; car.v = 0;
    if (resident) car.parkingResident = resident;
    this.pockets.set(car.id, activity);
    if (resident) { target.zone.residents.delete(target.slot); target.zone.baseline = target.zone.residents.size; }
    else target.zone.parked.delete(car.id);
    this.parking.claimSpawn(car);
    car.behaviour = { kind: 'parking-departure', description: `Pulling out safely on ${target.zone.name}`, until: this.sim.time + 45 };
    return true;
  }
  update(dt) {
    if (!this.enabled || !(dt > 0)) return;
    const alive = new Set(this.sim.cars);
    for (const [key, target] of this.targets) if (!alive.has(target.car)) {
      this.targets.delete(key); target.car.parkingSearch = null;
    }
    for (const [id, activity] of this.pockets) {
      const car = activity.car;
      if (!alive.has(car)) { this.cancel(car); continue; }
      if (activity.preparing) {
        activity.elapsed += dt;
        if (activity.elapsed > activity.duration || car.roadStop?.done || car.parkingSearch?.target !== activity.target) {
          this.pockets.delete(id);
          if (!car.roadStop?.done && activity.elapsed > activity.duration) {
            car.roadStop.done = true; car.parkingSearch.state = 'missed'; this.releaseTarget(car);
          }
        }
        continue;
      }
      activity.previousElapsed = activity.elapsed;
      activity.elapsed += dt;
      if (activity.elapsed < activity.duration) continue;
      car.q = activity.targetQ;
      car.index = activity.target.index;
      car.d = car.q - car.offsets[car.index];
      car.parkingActivity = null; this.pockets.delete(id);
      if (activity.phase === 'reverse-in') {
        car.parked = { zone: activity.zone, slot: activity.slot, direction: activity.target.direction };
        activity.zone.parked.set(car.id, car);
        car.roadStop.remaining = Math.max(car.roadStop.duration || 30, (car.roadStop.releaseAfter || 0) - this.sim.time);
        if (car.parkingSearch) car.parkingSearch.state = 'parked';
        this.releaseTarget(car); this.counters.arrivals++;
        for (const section of activity.zone.sections || []) section.claims.delete(car.id);
        activity.zone.claims.delete(car.id);
      } else {
        car.roadStop.done = true; car.roadStop.remaining = 0;
        if (car.parkingSearch) car.parkingSearch.state = 'departed';
        this.counters.departures++;
        car.parkingSearched = true;
        this.parking.claimSpawn(car);
        if (car.parkingResident && !this.returning.has(car.id)) this.returning.set(car.id,
          { car, actor: car.parkingResident, remaining: 45 + this.random() * 150, prepared: false });
      }
    }
    for (const zone of this.parking.zones) {
      for (const [id, car] of zone.parked) if (!alive.has(car) || car.parked?.zone !== zone) zone.parked.delete(id);
      for (const car of zone.parked.values()) {
        if (!car.parkingManaged || car.parkingHold || this.demand === 0) continue;
        car.roadStop.remaining = Math.max(0, (car.roadStop.remaining || 0) - dt);
        if (car.roadStop.remaining > 0) continue;
        const p = this.parking.parkedPosition(zone, car.parked.slot), edge = this.sim.data.edges[car.route[car.index]];
        const direction = car.parked.direction || 1;
        this.startDeparture(car, { zone, slot: car.parked.slot, p, index: car.index, edge, direction,
          d: direction === 1 ? p.d : edge.length - p.d, q: car.q });
      }
      if (this.demand === 0) continue;
      for (const actor of [...zone.residents.values()]) {
        actor.remaining = Math.max(0, actor.remaining - dt);
        if (actor.remaining === 0 && this.sim.time >= (actor.nextAttempt || 0)) this.departResident(actor);
      }
    }
    if (this.demand === 0) return;
    this.updateReturns(dt);
    for (const car of this.sim.cars) if (!car.parked && !car.parkingActivity) {
      this.findTarget(car); this.prepareApproach(car);
    }
    if (this.sim.time < this.nextSearch) return;
    this.nextSearch = this.sim.time + 1.5;
    for (const car of this.sim.cars) {
      if (car.type !== 'car' || car.parkingSearched || car.stationVisit || car.journey || car.roadStop || car.parkingSearch || car.turnaround || car.busPass) continue;
      const zones = this.parking.zones.filter(zone => (zone.localObservation || zone.id === 'high-street') &&
        this.slotsAlongRoute(car, zone).some(target => target.q - car.q < 250));
      if (!zones.length) continue;
      car.parkingSearched = true;
      if (this.random() < 0.22) this.request(car, { zoneId: zones[0].id });
    }
  }
  returnRoute(request) {
    const { actor, car } = request, p = this.parking.parkedPosition(actor.zone, actor.slot);
    const cost = edge => legal(this.sim, edge) ? edge.length / Math.min(edge.speed, 12) : Infinity;
    const find = origin => findRoute(this.sim.graph, origin, p.edge.to, null, cost, p.edge.id);
    const valid = path => path?.length > 1 && path.every(id => legal(this.sim, this.sim.data.edges[id])) &&
      !this.parking.byEdge.has(path[0]) && this.sim.data.edges[path[0]].length > car.length + 25;
    let incoming = find(car.destination);
    if (!valid(incoming)) {
      // An errand can leave this cropped miniature and return at a different
      // surveyed approach. Every visible leg remains a legal connected route.
      const origins = this.sim.data.edges.filter(edge => legal(this.sim, edge) && edge.length > car.length + 25 &&
        !this.parking.byEdge.has(edge.id) && Math.hypot(edge.points[0][0] - p.x, edge.points[0][1] - p.y) < 650)
        .sort((a, b) => Math.hypot(a.points[0][0] - p.x, a.points[0][1] - p.y) - Math.hypot(b.points[0][0] - p.x, b.points[0][1] - p.y));
      incoming = null;
      for (const edge of origins.slice(0, 16)) {
        const path = find(edge.from);
        if (valid(path)) { incoming = path; break; }
      }
    }
    if (!incoming || !actor.exitRoute?.length) return null;
    const path = [...incoming, ...actor.exitRoute.slice(1)];
    if (!path.every((id, index) => legal(this.sim, this.sim.data.edges[id]) &&
      (!index || canTurn(this.sim.graph, this.sim.data.edges[path[index - 1]], this.sim.data.edges[id])))) return null;
    return path;
  }
  prepareReturn(request) {
    const path = this.returnRoute(request);
    if (!path) return false;
    const { car } = request, fresh = this.sim.createVehicle(path, 'car', 0, 0);
    // Preserve identity, driver personality and paint through the whole errand.
    for (const key of ['route', 'offsets', 'lanes', 'index', 'destination']) car[key] = fresh[key];
    car.q = car.d = car.length + 12; car.v = 0; car.born = this.sim.time; car.stopped = 0;
    car.parked = null; car.parkingActivity = null; car.parkingSearch = null;
    car.roadStop = null; car.driverState = null; car.counted = new Set();
    this.parking.prepare(car); request.prepared = true;
    return true;
  }
  updateReturns(dt) {
    for (const [id, request] of this.returning) {
      const { car, actor } = request;
      if (this.sim.cars.includes(car)) {
        if (car.parked?.zone === actor.zone && car.parked.slot === actor.slot) this.returning.delete(id);
        continue;
      }
      request.remaining = Math.max(0, request.remaining - dt);
      if (request.remaining > 0 || this.sim.cars.length >= this.sim.maxVehicles) continue;
      if (!request.prepared && !this.prepareReturn(request)) { request.remaining = 30; continue; }
      const edge = this.sim.data.edges[car.route[0]], occupancy = this.sim.occupancy();
      if (this.sim.crossingSpawnAllowed?.(car) === false || this.sim.adaptive?.spawnAllowed(car) === false ||
          this.sim.busOvertaking?.spawnAllowed(car) === false || !this.parking.spawnAllowed(car)) continue;
      if ((occupancy.get(`${edge.id}:0`) || []).some(fragment => {
        const braking = Math.max(12, fragment.car.v * 1.6 + fragment.car.v ** 2 / (2 * Math.max(1, fragment.car.b || 2)));
        return fragment.end > car.d - car.length - braking && fragment.start < car.d + 12;
      })) continue;
      if (!this.request(car, { zoneId: actor.zone.id, parkingSlot: actor.slot, purpose: 'returning-home',
        duration: 180 + this.random() * 720 })) { request.prepared = false; request.remaining = 20; continue; }
      this.sim.cars.push(car); this.sim.generated++;
      this.parking.claimSpawn(car);
      request.prepared = false; request.remaining = 20;
      car.behaviour = { kind: 'returning-home', description: `Returning home to ${actor.zone.name}`, until: this.sim.time + 60 };
    }
  }
  indicator(car) {
    const activity = car.parkingActivity;
    if (activity) return Math.sign(activity.phase === 'reverse-in' ? activity.toLateral - activity.fromLateral : activity.toLateral - activity.fromLateral) || 1;
    const target = car.parkingSearch?.target;
    return target && target.q - car.q < 30 ? Math.sign(target.p.lateral * target.direction) || 1 : 0;
  }
  drainingContinuation(passage, car) {
    const root = passage.zone;
    if (!root.reconfiguring) return false;
    // A layout transaction waits for its old row's bodies to leave. It must
    // still let an entered owner clear a second section of that same row;
    // stopping that owner between sections prevents the transaction draining.
    const entered = (root.sections || []).some(section => {
      const claim = section.claims.get(car.id);
      return claim && claim.direction === passage.direction && claim.entry < passage.entry &&
        car.q > claim.entry && car.q - car.length <= claim.exit + 2;
    });
    if (!entered) return false;
    // Turning away and returning later is a new visit, not a continuation.
    for (let i = car.index; i < car.route.length && car.offsets[i] < passage.entry; i++)
      if (this.sim.data.edges[car.route[i]].tags.name !== root.name) return false;
    return true;
  }
  preferredDirection(section) {
    const root = section.rootZone;
    if (!root?.localObservation) return 0;
    // Adjacent surveyed pieces of Coniston are one physical parked corridor.
    // A car must be able to clear one piece into the next without facing a
    // group that has just been admitted the other way around its short node.
    for (const other of this.parking.zones) {
      if (other === root || other.name !== root.name) continue;
      for (const claim of other.claims.values()) {
        const car = claim.car;
        const passage = car.parkingPassages?.find(p => this.parking.controller(p) === section &&
          p.exit + 2 >= car.q - car.length);
        if (!passage || passage.direction !== claim.direction) continue;
        // A same-name claim is relevant only while this driver continues
        // through the requested section along the same road. A resident may
        // turn into Osbourne Avenue, loop round Havelock/Belham, then return
        // to Coniston from the other end; that future visit cannot lock an
        // otherwise empty section in the direction of its current journey.
        let continuous = true;
        for (let i = car.index; i < car.route.length && car.offsets[i] < passage.entry; i++) {
          if (this.sim.data.edges[car.route[i]].tags.name !== root.name) {
            continuous = false;
            break;
          }
        }
        if (continuous) return passage.direction;
      }
    }
    return 0;
  }
  pose(car, widthFactor = 1, alpha = 1) {
    const activity = car.parkingActivity;
    if (!activity) {
      if (!car.parkingManaged || !car.parked?.zone) return null;
      const p = this.parking.parkedPosition(car.parked.zone, car.parked.slot, widthFactor);
      return { ...p, angle: Math.atan2(p.dy, p.dx) + (car.parked.direction === -1 ? Math.PI : 0), layer: Number(p.edge.tags.layer) || 0 };
    }
    const elapsed = activity.previousElapsed + (activity.elapsed - activity.previousElapsed) * clamp(alpha);
    const t = clamp(elapsed / activity.duration), blend = smooth(t);
    const centreQ = activity.fromQ + (activity.targetQ - activity.fromQ) * blend - car.length / 2;
    const edge = activity.target.edge, d = Math.max(0, Math.min(edge.length, centreQ - car.offsets[activity.target.index]));
    const p = position(edge, d);
    const lateral = (activity.fromLateral + (activity.toLateral - activity.fromLateral) * blend) * widthFactor;
    const yaw = Math.sin(Math.PI * t) * 0.24 * Math.sign(activity.toLateral - activity.fromLateral);
    return { x: p.x + p.dy * lateral, y: p.y - p.dx * lateral,
      angle: Math.atan2(p.dy, p.dx) + (activity.reversing ? -yaw : yaw), edge, layer: Number(edge.tags.layer) || 0,
      reversing: activity.reversing, parkingPhase: activity.phase };
  }
  sectionsFor(zone, additionalSlot = null) {
    const actors = this.visibleSlots(zone);
    if (additionalSlot !== null && !actors.some(actor => actor.slot === additionalSlot)) actors.push({ slot: additionalSlot });
    const occupied = actors.map(actor => {
      const usable = zone.displays.reduce((sum, part) => sum + part.end - part.start, 0);
      return { slot: actor.slot, start: (actor.slot + 0.5) * usable / zone.capacity - 4.5,
        end: (actor.slot + 0.5) * usable / zone.capacity + 4.5 };
    }).sort((a, b) => a.start - b.start);
    const runs = [];
    for (const part of occupied) {
      const last = runs.at(-1);
      // A useful clear stretch allows drivers to regain their own carriageway.
      if (last && part.start - last.end <= 32) { last.end = part.end; last.slots.push(part.slot); }
      else runs.push({ start: part.start, end: part.end, slots: [part.slot] });
    }
    return runs.map(run => {
      const segments = new Map(); let offset = 0;
      for (const part of zone.displays) {
        const length = part.end - part.start, start = Math.max(0, run.start - offset), end = Math.min(length, run.end - offset);
        if (end > start) {
          const seg = zone.segments.get(part.edge.id), reverse = this.reverse.get(part.edge.id);
          segments.set(part.edge.id, { start: part.start + start, end: part.start + end, direction: seg.direction });
          if (reverse) segments.set(reverse.id, { start: reverse.length - part.start - end,
            end: reverse.length - part.start - start, direction: -seg.direction });
        }
        offset += length;
      }
      return { id: `${zone.id}:${run.slots.join(',')}`, rootZone: zone, name: zone.name, segments, slots: run.slots,
        clearance: Math.max(12, zone.clearance), localObservation: zone.localObservation, parked: zone.parked,
        narrow: true, active: true, claims: new Map(), waiting: new Map(), direction: 0,
        batch: 0, batchLimit: 0, lastSwitch: 0, clearing: false };
    });
  }
  syncClaims() {
    if (!this.enabled) return;
    for (const zone of this.parking.zones) {
      zone.claims.clear(); zone.waiting.clear();
      for (const section of zone.sections || []) {
        for (const [id, claim] of section.claims) zone.claims.set(id, claim);
        for (const [id, since] of section.waiting) zone.waiting.set(id, since);
      }
      zone.direction = (zone.sections || []).find(section => section.claims.size)?.direction || 0;
      zone.baseline = zone.residents.size;
      zone.narrow = this.parking.count(zone) > 0;
      const alive = new Set(this.sim.cars.map(car => car.id));
      for (const id of zone.waitHistory.keys()) if (!alive.has(id)) zone.waitHistory.delete(id);
    }
  }
  refreshSections(force = false) {
    if (!this.enabled) return;
    let changed = false;
    const replaced = new Set();
    for (const zone of this.parking.zones) {
      const key = this.visibleSlots(zone).map(actor => actor.slot).sort((a, b) => a - b).join(',');
      if (key === zone.layoutKey) {
        // A cancelled departure/arrival can restore the already active row
        // while a previous change was waiting for its claims to drain. There
        // is then no pending layout to protect, so admit traffic normally.
        zone.reconfiguring = false;
        continue;
      }
      if (!force && zone.claims.size) { zone.reconfiguring = true; continue; }
      const proposed = this.sectionsFor(zone);
      if (!force && !this.safeLayout(proposed)) { zone.reconfiguring = true; continue; }
      zone.sections = proposed;
      zone.layoutKey = key; zone.reconfiguring = false;
      zone.narrow = this.parking.count(zone) > 0; changed = true;
      replaced.add(zone);
    }
    if (changed) {
      for (const car of this.sim.cars || []) car.parkingPassages = this.parking.passages(car);
      // Existing bodies own a newly activated taper immediately. A birth or
      // returning car can run before the next update, so leaving this section
      // directionless for one frame could otherwise admit an opposing body.
      for (const car of this.sim.cars || []) {
        if (car.parked) continue;
        for (const passage of car.parkingPassages) {
          if (!replaced.has(passage.zone) || car.q <= passage.entry || car.q - car.length >= passage.exit + 2) continue;
          const section = passage.section;
          if (!section.direction) this.parking.beginGroup(section, passage.direction);
          section.claims.set(car.id, { ...passage, car, grantedAt: this.sim.time }); section.batch++;
        }
      }
    }
    this.syncClaims();
  }
  safeLayout(sections) {
    for (const section of sections) {
      const directions = new Set();
      // Use exactly the route-distance envelope adopted below, including a
      // front or tail still on the preceding short surveyed shape edge.
      for (const car of this.sim.cars) {
        if (car.parked) continue;
        for (let index = 0; index < car.route.length; index++) {
          const segment = section.segments.get(car.route[index]);
          if (!segment) continue;
          const entry = car.offsets[index] + segment.start - section.clearance;
          const exit = car.offsets[index] + segment.end + section.clearance;
          if (car.q > entry && car.q - car.length < exit + 2) directions.add(segment.direction);
        }
      }
      if (directions.size > 1) return false;
    }
    return true;
  }
}
