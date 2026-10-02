import { SCHOOLS } from './schools.mjs';
import { position } from './graph.mjs';

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
      lastSwitch: 0,
      clearing: false,
      narrow: baseline > 0,
      display: longest,
      displays: edges,
      parkingSide: options.parkingSide ?? 1,
      parkingOffset: options.parkingOffset ?? 3.8,
      passingOffset: options.passingOffset ?? 0,
      clearance: options.clearance ?? 0,
      localObservation: Boolean(options.localObservation),
    });
  };
  for (const school of SCHOOLS) {
    const edges = data.edges.filter(
      (e) => e.to === school.node && e.tags.name === school.road,
    );
    add(
      school.id,
      school.road,
      edges.map((edge) => ({
        edge,
        start: Math.max(0, edge.length - 45),
        end: edge.length,
      })),
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
      passingOffset: -parkingSide * 1.25, clearance: 12,
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
  }
  passages(c) {
    const result = [];
    for (let i = 0; i < c.route.length; i++) {
      const segment = this.byEdge.get(c.route[i]);
      if (!segment) continue;
      const entry = c.offsets[i] + segment.start,
        exit = c.offsets[i] + segment.end;
      const prev = result.at(-1);
      if (
        prev &&
        prev.zone === segment.zone &&
        prev.direction === segment.direction &&
        entry - prev.exit < 1
      )
        prev.exit = exit;
      else
        result.push({
          zone: segment.zone,
          direction: segment.direction,
          entry,
          exit,
        });
    }
    for (const passage of result) {
      // Reserve the taper too: a long vehicle's rear must be back in its own
      // lane before the waiting oncoming car can start around the parked row.
      passage.entry -= passage.zone.clearance;
      passage.exit += passage.zone.clearance;
    }
    return result;
  }
  prepare(c) {
    // A fresh route invalidates route-distance claims, including a waiting car
    // whose old approach is no longer on its route after a diversion.
    for (const zone of this.zones) {
      zone.claims.delete(c.id);
      zone.waiting.delete(c.id);
    }
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
    const lateral = zone.parkingSide * zone.parkingOffset * widthFactor;
    return { ...p, x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, edge, d, lateral, length: 9 };
  }
  spawnAllowed(c) {
    return (c.parkingPassages || []).every(p => {
      if (!p.zone.narrow || c.q <= p.entry || c.q - c.length >= p.exit + 2) return true;
      return !p.zone.clearing && (!p.zone.direction || p.zone.direction === p.direction) &&
        [...p.zone.claims.values()].every(r => r.direction === p.direction);
    });
  }
  claimSpawn(c) {
    for (const p of c.parkingPassages || []) {
      if (!p.zone.narrow || c.q <= p.entry || c.q - c.length >= p.exit + 2) continue;
      p.zone.claims.set(c.id, { ...p, car: c });
      p.zone.direction = p.direction;
      p.zone.batch += c.length > 12 ? 2 : 1;
    }
  }
  count(zone) {
    return zone.baseline + zone.parked.size;
  }
  update(dt, occupied) {
    const s = this.sim;
    for (const c of s.cars)
      if (c.parked) {
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
          zone.claims.set(c.id, { ...passage, car: c });
          zone.direction = passage.direction;
          zone.batch++;
        }
        zone.parked.delete(c.id);
        occupied = s.occupancy();
      }
    for (const zone of this.zones) {
      for (const [id, c] of zone.parked)
        if (!s.cars.includes(c) || c.parked?.zone !== zone) zone.parked.delete(id);
      const active = this.count(zone) > 0;
      if (active && !zone.narrow) zone.clearing = true;
      zone.narrow = active;
      for (const [id, claim] of zone.claims)
        if (
          claim.car.parked ||
          !s.cars.includes(claim.car) ||
          claim.car.q - claim.car.length > claim.exit + 2
        )
          zone.claims.delete(id);
      const requests = [];
      for (const c of s.cars) {
        if (c.parked) continue;
        for (const p of c.parkingPassages || []) {
          if (
            p.zone !== zone ||
            c.q - c.length > p.exit + 2 ||
            p.entry - c.q > Math.max(45, c.v * 3)
          )
            continue;
          if (c.q > p.entry && !zone.claims.has(c.id))
            zone.claims.set(c.id, { ...p, car: c });
          if (c.q <= p.entry && !zone.claims.has(c.id)) {
            const leader = s.leader(c, occupied, Math.max(250, p.entry - c.q));
            if (leader.frontGap < p.entry - c.q) continue;
            if (!zone.waiting.has(c.id)) zone.waiting.set(c.id, s.time);
            requests.push({ ...p, car: c, since: zone.waiting.get(c.id) });
          }
        }
      }
      const requestIds = new Set(requests.map((r) => r.car.id));
      for (const id of zone.waiting.keys())
        if (!requestIds.has(id)) zone.waiting.delete(id);
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
      const yieldNow =
        zone.direction &&
        opposed.length &&
        (zone.batch >= 3 ||
          s.time - Math.min(...opposed.map((r) => r.since)) > 15);
      if (
        !zone.claims.size &&
        (yieldNow || !requests.some((r) => r.direction === zone.direction))
      ) {
        zone.direction = 0;
        zone.batch = 0;
      }
      if (!zone.direction && requests.length) {
        // Earlier arrivals win; after a group has drained the longest waiter goes.
        requests.sort(
          (a, b) =>
            a.since - b.since ||
            b.direction - a.direction ||
            a.car.id - b.car.id,
        );
        zone.direction = requests[0].direction;
        zone.lastSwitch = s.time;
      }
      for (const r of requests.sort(
        (a, b) => a.entry - a.car.q - (b.entry - b.car.q),
      )) {
        if (r.direction !== zone.direction || (yieldNow && zone.claims.size))
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
        if (opposed.length && zone.batch >= 3) continue;
        zone.claims.set(r.car.id, r);
        zone.batch += r.car.length > 12 ? 2 : 1;
      }
    }
  }
  constraint(c) {
    let gap = Infinity,
      speed = Infinity;
    for (const p of c.parkingPassages || []) {
      if (!p.zone.narrow || c.q - c.length > p.exit + 2) continue;
      if (c.q >= p.entry - 10 && c.q <= p.exit)
        speed = Math.min(speed, c.length > 12 ? 3 : 5);
      if (!p.zone.claims.has(c.id) && c.q <= p.entry) {
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
    return { gap, speed };
  }
  tryPark(c) {
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
    const blend = Math.max(
      0,
      Math.min(1, (d - seg.start + 10) / 10, (seg.end + 10 - d) / 10),
    );
    const sharedLane = seg.zone.passingOffset * seg.direction;
    return normal * (1 - blend) + sharedLane * blend;
  }
}
