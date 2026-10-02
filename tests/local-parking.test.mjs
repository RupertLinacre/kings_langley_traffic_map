import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parking } from '../src/kings-langley/engine/parking.mjs';
import { Simulation } from '../src/kings-langley/engine/simulation.mjs';
import { position } from '../src/kings-langley/engine/graph.mjs';
import { laneOffset } from '../src/kings-langley/engine/traffic-model.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));

test('local parking follows the northwest side of Coniston and only the requested north side of Vicarage', () => {
  const parking = new Parking({ data });
  const coniston = parking.zones.filter(z => z.id.startsWith('coniston-road-'));
  assert.equal(coniston.length, 4);
  const vicarage = parking.zones.find(z => z.id === 'vicarage-lane');
  assert.deepEqual(vicarage.displays.map(p => p.edge.id), [227, 229, 231]);
  assert.equal(vicarage.displays[0].edge.from, 260731012, 'starts at Five Acres');
  assert.equal(vicarage.displays.at(-1).edge.to, 260731500, 'ends at Marwood Close');
  assert.ok(vicarage.displays[0].start >= 20 && vicarage.displays.at(-1).end <= vicarage.displays.at(-1).edge.length - 20);
  for (const zone of [...coniston, vicarage]) {
    assert.ok(zone.defaultBaseline > 0 && zone.baseline === zone.defaultBaseline);
    assert.ok(zone.narrow && zone.localObservation);
    const parked = Array.from({ length: zone.capacity }, (_, slot) => parking.parkedPosition(zone, slot));
    let northwest = 0;
    for (const p of parked) {
      const centre = position(p.edge, p.d);
      if (zone === vicarage) assert.ok(p.y < centre.y, 'parked on north side');
      else northwest += (p.x - centre.x) * -1 + (p.y - centre.y) * -1;
      const segment = zone.segments.get(p.edge.id);
      assert.ok(p.d >= segment.start + 4.5 && p.d <= segment.end - 4.5 || zone.displays.length > 1);
      const reverse = data.edges.find(e => e.from === p.edge.to && e.to === p.edge.from && e.way === p.edge.way);
      const frontLane = parking.lateral({}, p.edge, p.d, 1.65);
      const backLane = parking.lateral({}, reverse, reverse.length - p.d, 1.65);
      assert.ok(Math.abs(frontLane + backLane) < 1e-8, 'both directions share the same physical passing lane');
      assert.ok(Math.abs(frontLane - p.lateral) > 3, 'parked row clears the shared passing lane');
    }
    if (zone !== vicarage) assert.ok(northwest / parked.length > 1.5, 'parking mainly follows the northwest kerb');
    for (let i = 1; i < parked.length; i++)
      assert.ok(Math.hypot(parked[i].x - parked[i - 1].x, parked[i].y - parked[i - 1].y) > 12, 'illustrated parked bodies have space between them');
  }
});

function trafficFixture(seed = 73, approach = 100) {
  const points = [0, approach, approach + 200, approach * 2 + 200];
  const nodes = Object.fromEntries(points.map((x, id) => [id, { id, p: [x, 0], tags: {} }]));
  const edges = [];
  for (let i = 0; i < 3; i++) for (const forward of [true, false]) {
    const from = forward ? i : i + 1, to = forward ? i + 1 : i;
    edges.push({ id: edges.length, way: i, from, to, forward,
      points: [nodes[from].p, nodes[to].p], length: i === 1 ? 200 : approach, speed: 13.4,
      tags: { highway: 'residential', name: i === 1 ? 'Coniston Road' : 'Approach' } });
  }
  const map = { nodes, edges, ways: [], restrictions: [] };
  const routes = [[0, 2, 4], [5, 3, 1]];
  return { sim: new Simulation(map, seed, { routes: routes.map(path => ({ path, rate: 0 })) }), routes };
}

test('full queues follow through in varied groups of up to ten, with both directions clearing safely', () => {
  const firstGroups = new Set();
  for (const seed of [12, 42, 73, 99]) {
    const { sim, routes } = trafficFixture(seed, 300);
    const zone = sim.parking.zones.find(z => z.localObservation);
    for (const path of routes) for (let i = 0; i < 12; i++) {
      const car = sim.createVehicle(path, 'car', 308 - i * 17);
      car.length = 9; sim.cars.push(car);
    }
    const entered = new Set(), groups = [];
    for (let i = 0; i < 10000 && sim.cars.length; i++) {
      sim.step(0.1, 0);
      assert.ok(new Set([...zone.claims.values()].map(c => c.direction)).size <= 1);
      for (const lane of sim.occupancy().values()) for (let j = 1; j < lane.length; j++)
        assert.ok(lane[j - 1].end <= lane[j].start + 0.001, 'following bodies stay separated');
      for (const car of sim.cars) {
        const passage = car.parkingPassages[0];
        if (entered.has(car.id) || car.q <= passage.entry) continue;
        entered.add(car.id);
        if (groups.at(-1)?.direction === passage.direction) groups.at(-1).count++;
        else groups.push({ direction: passage.direction, count: 1 });
      }
    }
    assert.equal(sim.completed, 24, 'both queues drain without starving or deadlocking');
    assert.equal(entered.size, 24);
    assert.ok(groups[0].count >= 3 && groups[0].count <= 10, 'the first queue gets a proper group');
    assert.ok(groups.every(group => group.count <= 10), 'a waiting opposite queue gets its next turn');
    assert.ok(groups.some(group => group.direction === -1) && groups.some(group => group.direction === 1));
    firstGroups.add(groups[0].count);
  }
  assert.ok(firstGroups.size > 1, 'group sizes vary between seeded villages');
});

test('parking moves both directions onto the clear-side lane instead of the road centre', () => {
  const parking = new Parking({ data });
  for (const zone of parking.zones.filter(zone => zone.defaultBaseline > 0)) {
    const edge = zone.display.edge, reverse = data.edges.find(e => e.way === edge.way && e.from === edge.to && e.to === edge.from);
    if (!reverse) continue;
    const d = (zone.display.start + zone.display.end) / 2;
    const passing = parking.lateral({}, edge, d, laneOffset(edge, 0));
    assert.equal(passing, -zone.parkingSide * laneOffset(edge, 0), 'parked-side drivers use the opposite carriageway');
    assert.equal(parking.lateral({}, reverse, reverse.length - d, laneOffset(reverse, 0)), -passing, 'oncoming drivers stay in that same clear lane');
  }
});

test('parked rows alternate traffic fairly and keep long vehicle rears clear of opposing claims', () => {
  const { sim, routes } = trafficFixture();
  const zone = sim.parking.zones.find(z => z.localObservation);
  for (const [direction, path] of routes.entries()) for (let i = 0; i < 4; i++) {
    const c = sim.createVehicle(path, i === 0 ? 'bus' : 'car', 108 - i * 28);
    c.length = i === 0 ? 19.8 : 9;
    c.born = -i - direction;
    sim.cars.push(c);
  }
  const firstPass = new Map(), lastClaims = new Map();
  for (let i = 0; i < 5000 && sim.cars.length; i++) {
    sim.step(0.1, 0);
    const directions = new Set([...zone.claims.values()].map(c => c.direction));
    assert.ok(directions.size <= 1, `opposing claims at ${sim.time}`);
    for (const claim of zone.claims.values()) {
      if (!firstPass.has(claim.direction)) firstPass.set(claim.direction, sim.time);
      lastClaims.set(claim.car.id, claim);
    }
    for (const [id, claim] of lastClaims) {
      if (zone.claims.has(id) || !sim.cars.includes(claim.car)) continue;
      assert.ok(claim.car.q - claim.car.length > claim.exit + 2, 'rear clears the complete taper before the claim is released');
      lastClaims.delete(id);
    }
  }
  assert.equal(firstPass.size, 2, 'both waiting directions get a turn');
  assert.ok(Math.max(...firstPass.values()) < 130, 'the opposed queue does not starve');
  assert.equal(sim.cars.length, 0, 'both queues completely drain');
  assert.equal(sim.completed, 8);
});

test('births and reroutes cannot bypass an active single-file passage', () => {
  const { sim, routes } = trafficFixture();
  const a = sim.createVehicle(routes[0], 'car', 130);
  const b = sim.createVehicle(routes[1], 'car', 130);
  sim.cars.push(a);
  assert.ok(sim.parking.spawnAllowed(a));
  sim.parking.claimSpawn(a);
  assert.equal(sim.parking.spawnAllowed(b), false);
  const zone = a.parkingPassages[0].zone;
  zone.waiting.set(a.id, 0);
  a.route = [0]; a.offsets = [0, 100]; a.index = 0; a.q = 30; a.d = 30;
  sim.parking.prepare(a);
  assert.equal(zone.claims.has(a.id), false);
  assert.equal(zone.waiting.has(a.id), false);
  assert.equal(a.parkingPassages.length, 0);
  sim.parking.update(0.1, sim.occupancy());
  assert.equal(zone.direction, 0, 'the released direction does not block future arrivals');
  assert.ok(sim.parking.spawnAllowed(b));
});

test('rerouting remains valid while another car is parked and removed parked cars are cleaned up', () => {
  const { sim, routes } = trafficFixture();
  const zone = sim.parking.zones.find(z => z.localObservation);
  zone.baseline = 0;
  const parked = sim.createVehicle(routes[0], 'car', 150);
  parked.roadStop = { parkingZone: zone.id, duration: 30, done: false };
  sim.cars.push(parked);
  assert.ok(sim.parking.tryPark(parked));
  const passing = sim.createVehicle(routes[1], 'car', 20);
  sim.cars.push(passing);
  passing.route = [5]; passing.offsets = [0, 100];
  assert.doesNotThrow(() => sim.parking.prepare(passing));
  assert.equal(zone.parked.size, 1, 'preparing a route preserves the parked neighbour');
  sim.cars = [passing];
  sim.parking.update(0.1, sim.occupancy());
  assert.equal(zone.parked.size, 0, 'removed parked neighbours are collected on update');
});
