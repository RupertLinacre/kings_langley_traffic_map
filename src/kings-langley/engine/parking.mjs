import { SCHOOLS } from './schools.mjs';
import { position } from './graph.mjs';
import { ParkingActivity } from '../../parking-activity.mjs';

// The two residential stretches below follow the user's local observations.
// Bay spacing and clearance are miniature assumptions, not surveyed markings.
export function parkingZones(data) {
  const zones = [];
  const add = (id, name, edges, baseline = 0, options = {}) => {
    const segments = new Map();
    for (const { edge, start, end } of edges) {
      segments.set(edge.id, { start, end, direction: edge.forward ? 1 : -1 });
      const reverse = data.edges.find(
        (e) => e.from === edge.to && e.to === edge.from && e.way === edge.way,
      );
      if (reverse)
        segments.set(reverse.id, {
          start: edge.length - end,
          end: edge.length - start,
          direction: edge.forward ? -1 : 1,
        });
    }
    if (!segments.size) return;
    const longest = edges
      .slice()
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    zones.push({
      id,
      name,
      segments,
      capacity: options.capacity || 6,
      baseline,
      defaultBaseline: baseline,
      parked: new Map(),
      claims: new Map(),
      waiting: new Map(),
      direction: 0,
      batch: 0,
      batchLimit: 0,
      lastSwitch: 0,
      clearing: false,
      narrow: baseline > 0,
      display: longest,
      displays: edges,
      parkingSide: options.parkingSide ?? 1,
      parkingSides: options.parkingSides,
      passingOffsets: options.passingOffsets,
      parkingOffset: options.parkingOffset ?? 3.8,
      // Both directions use the centre of the lane opposite the parked row.
      passingOffset: options.passingOffset ?? -(options.parkingSide ?? 1) * (longest.edge.forward ? 1 : -1) * 1.55,
      clearance: options.clearance ?? 0,
      localObservation: Boolean(options.localObservation),
    });
  };
  for (const school of SCHOOLS) {
    const edges = data.edges.filter(
      (e) => e.to === school.node && e.tags.name === school.road,
    );
    const centre = school.outline.reduce((p, point) => [p[0] + point[0] / school.outline.length,
      p[1] + point[1] / school.outline.length], [0, 0]);
    const parkingSides = new Map(), passingOffsets = new Map();
    for (const edge of edges) {
      const p = position(edge, Math.max(0, edge.length - 22));
      const side = Math.sign((centre[0] - p.x) * p.dy - (centre[1] - p.y) * p.dx) || 1;
      parkingSides.set(edge.id, side); passingOffsets.set(edge.id, -side * 1.55);
      const reverse = data.edges.find(other => other.way === edge.way && other.from === edge.to && other.to === edge.from);
      if (reverse) { parkingSides.set(reverse.id, -side); passingOffsets.set(reverse.id, side * 1.55); }
    }
    const longest = [...edges].sort((a, b) => b.length - a.length)[0];
    add(
      school.id,
      school.road,
      edges.map((edge) => ({
        edge,
        start: Math.max(0, edge.length - 45),
        end: edge.length,
      })),
      0,
      { parkingSide: parkingSides.get(longest?.id) || 1, parkingSides, passingOffsets },
    );
  }
  const high = data.edges
    .filter((e) => e.tags.name === 'High Street' && e.forward && e.length > 70)
    .sort((a, b) => b.length - a.length)[0];
  if (high) {
    const middle = high.length / 2;
    add(
      'high-street',
      'High Street',
      [{ edge: high, start: middle - 30, end: middle + 30 }],
      3,
    );
  }
  const residential = (id, name, edges, parkingSide) => {
    const metres = edges.reduce((sum, part) => sum + part.end - part.start, 0);
    // Nine-metre illustrated cars need room between bumpers even at full bays.
    const capacity = Math.max(1, Math.floor(metres / 15));
    add(id, name, edges, capacity, {
      // Centre each car over the kerb: half on the road, half on the pavement.
      capacity, parkingSide, parkingOffset: 3.3,
      clearance: 12,
      localObservation: true,
    });
  };
  for (const edge of data.edges.filter(e => e.forward && e.tags.name === 'Coniston Road' && e.length > 60)) {
    // Junctions and the short bend into Barnes Lane remain clear for passing.
    residential(`coniston-road-${edge.from}`, 'Coniston Road', [
      { edge, start: 22, end: edge.length - 22 },
    ], -1);
  }
  // Follow the road graph from Five Acres to Marwood Close rather than relying
  // on array indexes or including the rest of Vicarage Lane by accident.
  const junction = name => {
    const nodes = new Set(data.edges.filter(e => e.tags.name === name).flatMap(e => [e.from, e.to]));
    return data.edges.find(e => e.tags.name === 'Vicarage Lane' && nodes.has(e.from))?.from;
  };
  const fiveAcres = junction('Five Acres'), marwood = junction('Marwood Close');
  if (fiveAcres !== undefined && marwood !== undefined) {
    const search = [[fiveAcres, []]], visited = new Set();
    let path = null;
    while (search.length) {
      const [node, trail] = search.shift();
      if (node === marwood) { path = trail; break; }
      if (visited.has(node)) continue;
      visited.add(node);
      for (const edge of data.edges.filter(e => e.from === node && e.tags.name === 'Vicarage Lane'))
        if (!visited.has(edge.to)) search.push([edge.to, [...trail, edge]]);
    }
    if (path?.length) residential('vicarage-lane', 'Vicarage Lane', path.map((edge, i) => ({
      edge, start: i === 0 ? 22 : 0, end: edge.length - (i === path.length - 1 ? 22 : 0),
    })), 1);
  }
  return zones;
}

export class Parking {
  constructor(sim) {
    this.sim = sim;
    this.missed = 0;
    this.zones = parkingZones(sim.data);
    this.byEdge = new Map();
    for (const zone of this.zones)
      for (const [id, segment] of zone.segments)
        this.byEdge.set(id, { zone, ...segment });
    this.activity = new ParkingActivity(this);
  }
  enableActivities(enabled = true) { return this.activity.enable(enabled); }
  setActivityDemand(level) { this.activity.demand = Math.max(0, Number(level) || 0); }
  resetActivities(options) { return this.activity.reset(options); }
  releaseMissing() { return this.activity.releaseMissing(); }
  visibleSlots(zone) { return this.activity.visibleSlots(zone); }
  request(c, options) { return this.activity.request(c, options); }
  cancel(c) { return this.activity.cancel(c); }
  pose(c, widthFactor = 1, alpha = 1) { return this.activity.pose(c, widthFactor, alpha); }
  indicator(c) { return this.activity.indicator(c); }
  managesMotion(c) { return Boolean(c.parkingActivity); }
  gap(c) { return this.activity.gap(c); }
  controller(p) { return p.section || p.zone; }
  controllers() { return this.activity.enabled ? this.zones.flatMap(z => z.sections || []) : this.zones; }
  passages(c) {
    const result = [];
    for (let i = 0; i < c.route.length; i++) {
      const original = this.byEdge.get(c.route[i]);
      if (!original) continue;
      const candidates = this.activity.enabled
        ? (original.zone.sections || []).map(section => ({ ...section.segments.get(c.route[i]), zone: original.zone, section }))
          .filter(segment => Number.isFinite(segment.start))
        : [original];
      for (const segment of candidates) {
      const entry = c.offsets[i] + segment.start,
        exit = c.offsets[i] + segment.end;
      const prev = result.at(-1);
      if (
        prev &&
        prev.zone === segment.zone &&
        prev.section === segment.section &&
        prev.direction === segment.direction &&
        entry - prev.exit < 1
      )
        prev.exit = exit;
      else
        result.push({
          zone: segment.zone,
          section: segment.section,
          direction: segment.direction,
          entry,
          exit,
        });
      }
    }
    for (const passage of result) {
      // Reserve the taper too: a long vehicle's rear must be back in its own
      // lane before the waiting oncoming car can start around the parked row.
      passage.entry -= this.controller(passage).clearance;
      passage.exit += this.controller(passage).clearance;
    }
    return result;
  }
  prepare(c) {
    // A fresh route invalidates route-distance claims, including a waiting car
    // whose old approach is no longer on its route after a diversion.
    for (const zone of this.zones) {
      zone.claims.delete(c.id);
      zone.waiting.delete(c.id);
      for (const section of zone.sections || []) { section.claims.delete(c.id); section.waiting.delete(c.id); }
    }
    this.activity.releaseTarget(c);
    c.parkingPassages = this.passages(c);
  }
  parkedPosition(zone, slot, widthFactor = 1) {
    const displays = zone.displays || [zone.display];
    const usable = displays.reduce((sum, part) => sum + part.end - part.start, 0);
    let along = ((slot + 0.5) * usable) / zone.capacity;
    let part = displays.at(-1);
    for (const candidate of displays) {
      part = candidate;
      if (along <= candidate.end - candidate.start) break;
      along -= candidate.end - candidate.start;
    }
    const { edge, start } = part, d = start + along;
    const p = position(edge, d);
    const lateral = (zone.parkingSides?.get(edge.id) ?? zone.parkingSide) * zone.parkingOffset * widthFactor;
    return { ...p, x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, edge, d, lateral, length: 9 };
  }
  spawnAllowed(c) {
    if (!this.activity.spawnAllowed(c)) return false;
    return (c.parkingPassages || []).every(p => {
      const group = this.controller(p);
      if (!group.narrow || c.q <= p.entry || c.q - c.length >= p.exit + 2) return true;
      return !group.clearing && (!group.direction || group.direction === p.direction) &&
        [...group.claims.values()].every(r => r.direction === p.direction);
    });
  }
  beginGroup(zone, direction) {
    zone.direction = direction;
    zone.batch = 0;
    // Busy queues tend to follow one another; choose a new-sized group each turn.
    zone.batchLimit = 3 + Math.floor(this.sim.random() * 8);
    zone.lastSwitch = this.sim.time;
  }
  claimSpawn(c) {
    for (const p of c.parkingPassages || []) {
      const group = this.controller(p);
      if (!group.narrow || c.q <= p.entry || c.q - c.length >= p.exit + 2) continue;
      if (group.direction !== p.direction) this.beginGroup(group, p.direction);
      group.claims.set(c.id, { ...p, car: c, grantedAt: this.sim.time });
      group.batch++;
    }
    this.activity.syncClaims();
  }
  count(zone) {
    return zone.baseline + zone.parked.size;
  }
  update(dt, occupied) {
    const s = this.sim;
    this.activity.update(dt, occupied);
    for (const c of s.cars)
      if (c.parked && !c.parkingManaged) {
        c.roadStop.remaining = Math.max(0, c.roadStop.remaining - dt);
        if (c.roadStop.remaining > 0) continue;
        const zone = c.parked.zone;
        // Rejoin at the saved route position only if both front and rear are clear.
        const e = s.data.edges[c.route[c.index]],
          lane = c.lanes[c.index];
        const conflict = (occupied.get(`${e.id}:${lane}`) || []).some(
          (f) =>
            f.end > c.d - c.length - Math.max(5, f.car.v * 1.5) &&
            f.start < c.d + 8,
        );
        const passage = c.parkingPassages.find(
          (p) => p.zone === zone && p.entry <= c.q && p.exit >= c.q,
        );
        const opposing = [...zone.claims.values()].some(
          (r) => r.direction !== passage?.direction,
        );
        if (conflict || opposing || zone.clearing) continue;
        // Merge into the current group, but do not prolong it if the opposite side waits.
        if (zone.direction && zone.direction !== passage?.direction) continue;
        c.parked = null;
        c.roadStop.done = true;
        if (passage) {
          if (!zone.direction) this.beginGroup(zone, passage.direction);
          zone.claims.set(c.id, { ...passage, car: c, grantedAt: s.time });
          zone.batch++;
        }
        zone.parked.delete(c.id);
        occupied = s.occupancy();
      }
    for (const zone of this.controllers()) {
      const ownerZone = zone.rootZone || zone;
      for (const [id, c] of zone.parked)
        if (!s.cars.includes(c) || c.parked?.zone !== ownerZone) zone.parked.delete(id);
      const active = zone.rootZone ? zone.active : this.count(zone) > 0;
      if (active && !zone.narrow) zone.clearing = true;
      zone.narrow = active;
      for (const [id, claim] of zone.claims)
        if (
          claim.car.parked ||
          s.cooperative?.suspendsParking(claim.car) ||
          !s.cars.includes(claim.car) ||
          claim.car.q - claim.car.length > claim.exit + 2
        )
          zone.claims.delete(id);
      const requests = [];
      for (const c of s.cars) {
        if (c.parked || c.parkingActivity || s.cooperative?.suspendsParking(c)) continue;
        for (const p of c.parkingPassages || []) {
          if (
            this.controller(p) !== zone ||
            c.q - c.length > p.exit + 2 ||
            p.entry - c.q > Math.max(45, c.v * 3)
          )
            continue;
          if (c.q > p.entry && !zone.claims.has(c.id)) {
            if (!zone.direction) this.beginGroup(zone, p.direction);
            zone.claims.set(c.id, { ...p, car: c, grantedAt: s.time });
            zone.batch++;
          }
          if (c.q <= p.entry && !zone.claims.has(c.id)) {
            const leader = s.leader(c, occupied, Math.max(250, p.entry - c.q));
            // A follower may join its leader's group before reaching the stop
            // line. Ordinary following distances still control its movement.
            if (leader.frontGap < p.entry - c.q && !zone.claims.has(leader.car?.id)) continue;
            if (!zone.waiting.has(c.id)) zone.waiting.set(c.id, zone.rootZone?.waitHistory?.get(c.id) ?? s.time);
            if (zone.rootZone) zone.rootZone.waitHistory.set(c.id, zone.waiting.get(c.id));
            requests.push({ ...p, car: c, since: zone.waiting.get(c.id) });
          }
        }
      }
      const requestIds = new Set(requests.map((r) => r.car.id));
      for (const id of zone.waiting.keys())
        if (!requestIds.has(id)) zone.waiting.delete(id);
      const overdueOpposed = zone.rootZone && requests.some(r => r.direction !== zone.direction && s.time - r.since >= 50);
      if (overdueOpposed) for (const [id, claim] of zone.claims) {
        // An unused promise before a junction must not hold the opposite side
        // while its owner is itself waiting for that side to clear the turn.
        // Entered bodies and moving commitments retain their complete taper.
        if (claim.car.q > claim.entry || claim.car.v >= 0.2 || claim.car.stopped < 8 ||
            s.time - (claim.grantedAt ?? -Infinity) < 8) continue;
        zone.claims.delete(id);
        const since = zone.rootZone.waitHistory.get(id) ?? s.time;
        zone.waiting.set(id, since);
        requests.push({ ...claim, since });
      }
      if (!active) {
        zone.direction = 0;
        zone.batch = 0;
        zone.clearing = false;
        continue;
      }
      if (zone.clearing) {
        if (zone.claims.size) continue;
        zone.clearing = false;
        zone.direction = 0;
      }
      const opposed = requests.filter((r) => r.direction !== zone.direction);
      const yieldingDirection = zone.direction;
      const yieldNow =
        zone.direction &&
        opposed.length &&
        (zone.batch >= zone.batchLimit || zone.rootZone && opposed.some(r => s.time - r.since >= 50));
      const nextDirection = yieldNow ? -zone.direction : 0;
      if (
        !zone.claims.size &&
        (yieldNow || !requests.some((r) => r.direction === zone.direction))
      ) {
        zone.direction = 0;
        zone.batch = 0;
      }
      if (!zone.direction && requests.length) {
        // Earlier arrivals win initially; a full group hands over to its queue.
        requests.sort(
          (a, b) =>
            a.since - b.since ||
            b.direction - a.direction ||
            a.car.id - b.car.id,
        );
        const next = requests.find(r => r.direction === nextDirection) || requests[0];
        this.beginGroup(zone, next.direction);
      }
      const preferred = this.activity.preferredDirection(zone);
      if (preferred && !zone.claims.size && zone.direction !== preferred) this.beginGroup(zone, preferred);
      for (const r of requests.sort(
        (a, b) => a.entry - a.car.q - (b.entry - b.car.q),
      )) {
        if (zone.rootZone?.reconfiguring) continue;
        if (r.direction !== zone.direction)
          continue;
        if ([...zone.claims.values()].some((x) => x.direction !== r.direction))
          continue;
        let exitIndex = r.car.index;
        while (
          exitIndex < r.car.route.length - 1 &&
          r.car.offsets[exitIndex + 1] <= r.exit
        )
          exitIndex++;
        const downstream = s.leader(
          r.car,
          occupied,
          r.car.length + 15,
          exitIndex,
          r.exit,
        );
        if (downstream.gap < r.car.length + 4) continue;
        if (requests.some(x => x.direction !== zone.direction) &&
            (zone.batch >= zone.batchLimit || yieldNow && zone.direction === yieldingDirection)) continue;
        zone.claims.set(r.car.id, { ...r, grantedAt: s.time });
        zone.batch++;
      }
    }
    this.activity.syncClaims();
    this.activity.refreshSections();
  }
  constraint(c) {
    let gap = Infinity,
      speed = Infinity;
    for (const p of c.parkingPassages || []) {
      const group = this.controller(p);
      if (!group.narrow || c.q - c.length > p.exit + 2) continue;
      if (c.q >= p.entry - 10 && c.q <= p.exit)
        speed = Math.min(speed, c.length > 12 ? 3 : 5);
      if (!group.claims.has(c.id) && c.q <= p.entry) {
        let holdingPoint = p.entry;
        if (p.zone.localObservation) {
          const junction = c.offsets.findLast(offset => offset <= p.entry);
          // A queue must not leave its enlarged tail in the junction through
          // which the oncoming group needs to exit. Wait before turning in
          // when the short clear approach cannot accommodate the whole body.
          if (junction > 0 && p.entry - junction < c.length + c.minGap + 2 && c.q < junction)
            holdingPoint = junction - 1;
        }
        gap = Math.min(gap, Math.max(0, holdingPoint - c.q));
      }
    }
    const search = c.parkingSearch;
    if (search && ['searching', 'full', 'approaching'].includes(search.state)) {
      const distance = (search.target?.q ?? search.firstQ) - c.q;
      if (distance < 75 && distance > -40) speed = Math.min(speed, 4);
    }
    return { gap, speed };
  }
  tryPark(c) {
    if (this.activity.enabled) return this.activity.tryPark(c);
    const stop = c.roadStop;
    const zone = this.zones.find((z) => z.id === stop.parkingZone);
    if (!zone || this.count(zone) >= zone.capacity) return false;
    const used = new Set([...zone.parked.values()].map((c) => c.parked.slot));
    let slot = zone.baseline;
    while (used.has(slot)) slot++;
    c.parked = { zone, slot };
    stop.remaining = Math.max(
      stop.duration,
      (stop.releaseAfter || 0) - this.sim.time,
    );
    c.v = 0;
    zone.parked.set(c.id, c);
    zone.claims.delete(c.id);
    return true;
  }
  lateral(c, edge, d, normal) {
    const seg = this.byEdge.get(edge.id);
    if (!seg || !seg.zone.narrow || seg.zone.clearing) return normal;
    if (this.activity.enabled) {
      const part = (seg.zone.sections || []).map(section => ({ ...section.segments.get(edge.id), section }))
        .find(part => Number.isFinite(part.start) && d >= part.start - 10 && d <= part.end + 10);
      if (!part) return normal;
      const blend = Math.max(0, Math.min(1, (d - part.start + 10) / 10, (part.end + 10 - d) / 10));
      const sharedLane = seg.zone.passingOffsets?.get(edge.id) ?? seg.zone.passingOffset * seg.direction;
      return normal * (1 - blend) + sharedLane * blend;
    }
    const blend = Math.max(
      0,
      Math.min(1, (d - seg.start + 10) / 10, (seg.end + 10 - d) / 10),
    );
    const sharedLane = seg.zone.passingOffsets?.get(edge.id) ?? seg.zone.passingOffset * seg.direction;
    return normal * (1 - blend) + sharedLane * blend;
  }
}
