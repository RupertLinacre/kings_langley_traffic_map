import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, canTurn, position } from '../src/kings-langley/engine/simulation.mjs';
import { turnaroundFits, turnaroundPose } from '../src/kings-langley/engine/adaptive-traffic.mjs';
import { laneOffset } from '../src/kings-langley/engine/traffic-model.mjs';

function fixture() {
  const nodes = Object.fromEntries(Object.entries({ S: [-100, 0], A: [0, 0], B: [200, 0], C: [0, 50], D: [200, 50] }).map(([id, p]) => [id, { id, p, tags: {} }]));
  const edges = [];
  const add = (from, to, highway, way = edges.length, extra = {}) => {
    const points = [nodes[from].p, nodes[to].p];
    const edge = { id: edges.length, from, to, way, points, length: Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]), speed: 10, forward: true, tags: { highway }, ...extra };
    edges.push(edge); return edge.id;
  };
  const approach = add('S', 'A', 'secondary');
  const main = add('A', 'B', 'secondary');
  const finish = add('B', 'D', 'secondary');
  const side = add('A', 'C', 'residential');
  const bypass = add('C', 'D', 'residential');
  const reverse = add('B', 'A', 'secondary', edges[main].way, { forward: false });
  const data = { nodes, edges, restrictions: [], ways: [] };
  const sim = new Simulation(data, 21, { routes: [{ path: [approach, main, finish], rate: 0 }] });
  return { sim, data, approach, main, finish, side, bypass, reverse };
}

test('default motor routes prefer main roads to a slightly shorter residential shortcut', () => {
  const { sim, approach, main, finish, side, bypass } = fixture();
  const original = { path: [approach, side, bypass], rate: 1 };
  assert.deepEqual(sim.adaptive.entry(original, 'car').path, [approach, main, finish]);
  assert.deepEqual(sim.adaptive.entry(original, 'bus').path, original.path, 'scheduled buses retain their intended route');
  assert.deepEqual(sim.adaptive.entry({ ...original, roadStop: { q: 30 } }, 'car').path, original.path, 'a planned pickup is preserved');
});

test('congestion changes the future route while preserving destination, position and cooldown', () => {
  const { sim, approach, main, finish, side, bypass } = fixture();
  const car = sim.createVehicle([approach, main, finish], 'car', 25);
  sim.cars.push(car); sim.time = 50;
  sim.adaptive.delay.set(main, 100);
  sim.adaptive.consider(car);
  assert.deepEqual(car.route, [approach, side, bypass]);
  assert.equal(car.q, 25); assert.equal(car.index, 0); assert.equal(car.destination, 'D');
  assert.equal(car.behaviour.kind, 'diversion'); assert.ok(car.behaviour.savedSeconds > 18);
  for (let i = 1; i < car.route.length; i++) assert.ok(canTurn(sim.graph, sim.data.edges[car.route[i - 1]], sim.data.edges[car.route[i]]));
  sim.adaptive.delay.clear(); sim.adaptive.delay.set(side, 140);
  sim.time += 10; sim.adaptive.consider(car);
  assert.deepEqual(car.route, [approach, side, bypass], 'a driver does not bounce between routes');
  sim.time += 50; sim.adaptive.consider(car);
  assert.deepEqual(car.route, [approach, main, finish]);
});

test('diversions obey turn restrictions and cannot route lorries through the low underpass', () => {
  const f = fixture(), { sim, data, approach, main, finish, side, bypass } = f;
  data.restrictions.push({ via: 'A', from: data.edges[approach].way, to: data.edges[side].way, type: 'no_left_turn' });
  sim.adaptive.graphRevision = -1;
  const car = sim.createVehicle([approach, main, finish], 'car', 20);
  sim.cars.push(car); sim.adaptive.delay.set(main, 100); sim.adaptive.consider(car);
  assert.deepEqual(car.route, [approach, main, finish]);
  data.restrictions.length = 0; data.edges[main].restoredUnderpass = true;
  sim.adaptive.graphRevision = -1;
  assert.deepEqual(sim.adaptive.entry({ path: [approach, main, finish] }, 'lorry').path, [approach, side, bypass]);
});

function turningFixture() {
  const f = fixture(), { sim, data, main, finish } = f;
  data.edges[main].tags.highway = data.edges[f.reverse].tags.highway = 'residential';
  const car = sim.createVehicle([main, finish], 'car', 100);
  car.stopped = 45; sim.cars.push(car); sim.time = 45;
  sim.adaptive.delay.set(main, 150);
  return { ...f, car };
}

test('a three-point turn uses forward/reverse/forward arcs with continuous lane endpoints', () => {
  const { sim, data, car, main, reverse } = turningFixture();
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), true);
  const turn = car.turnaround, width = 3, centre = position(data.edges[main], car.d - car.length / 2), lateral = laneOffset(data.edges[main], 0) * width;
  const start = turnaroundPose(sim, car, width);
  assert.ok(Math.hypot(start.x - centre.x - centre.dy * lateral, start.y - centre.y + centre.dx * lateral) < 1e-8);
  let previous = start, reversed = false;
  for (let t = 0.1; t < 14; t += 0.1) {
    turn.elapsed = turn.previousElapsed = t;
    const pose = turnaroundPose(sim, car, width);
    assert.ok(Number.isFinite(pose.angle));
    assert.ok(Math.hypot(pose.x - previous.x, pose.y - previous.y) < 0.65, 'the body moves continuously');
    reversed ||= pose.reversing; previous = pose;
  }
  assert.ok(reversed);
  turn.elapsed = turn.previousElapsed = 14;
  const final = turnaroundPose(sim, car, width);
  sim.adaptive.update(0.1);
  assert.equal(car.turnaround, null); assert.equal(car.route[0], reverse); assert.equal(car.destination, 'D');
  const p = position(data.edges[reverse], car.d - car.length / 2), lane = laneOffset(data.edges[reverse], 0) * width;
  assert.ok(Math.hypot(final.x - p.x - p.dy * lane, final.y - p.y + p.dx * lane) < 1e-8);
  assert.ok(Math.abs(Math.cos(final.angle) - p.dx) < 1e-8);
  assert.equal(sim.adaptive.threePointTurns, 1);
  assert.equal(sim.adaptive.turns.size, 0);
  assert.equal(car.parkingPassages.length, sim.parking.passages(car).length);
});

test('three-point turns require clear space on both sides and reserve both carriageways', () => {
  const { sim, data, car, main, reverse } = turningFixture();
  const opposing = sim.createVehicle([reverse], 'car', 104); sim.cars.push(opposing);
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), false, 'opposing traffic prevents a turn');
  sim.cars.pop(); sim.turnaroundAllowed = () => false;
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), false, 'a pedestrian crossing veto is honoured');
  sim.turnaroundAllowed = () => true;
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), true);
  const follower = sim.createVehicle([main], 'car', 35), oncoming = sim.createVehicle([reverse], 'car', 35);
  assert.ok(sim.adaptive.gap(follower) > 0 && sim.adaptive.gap(follower) < 80);
  assert.ok(sim.adaptive.gap(oncoming) > 0 && sim.adaptive.gap(oncoming) < 80);
  const bornInside = sim.createVehicle([reverse], 'car', data.edges[main].length - car.turnaround.centre);
  assert.equal(sim.adaptive.spawnAllowed(bornInside), false);
  sim.cars = [];
  sim.adaptive.update(0.1);
  assert.equal(sim.adaptive.turns.size, 0, 'traffic reset releases the road');
});

test('an approaching driver brakes inside reserved space before starting a turn', () => {
  const { sim, car, main, reverse } = turningFixture();
  car.v = 4; car.stopped = 0;
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), true);
  assert.equal(car.turnaround.preparing, true);
  assert.equal(turnaroundPose(sim, car, 3), null, 'braking uses the ordinary driving pose');
  const firstQ = car.q, follower = sim.createVehicle([main], 'car', 35), opposing = sim.createVehicle([reverse], 'car', 35);
  follower.v = opposing.v = 6; sim.cars.push(follower, opposing);
  let arcStarted = false;
  for (let i = 0; i < 240; i++) {
    sim.step(0.1, 0);
    if (car.turnaround && !car.turnaround.preparing) arcStarted = true;
    if (car.turnaround) {
      const turn = car.turnaround;
      assert.ok(follower.d < turn.centre - turn.radius + 0.01, 'following traffic stays outside the reserved pocket');
      assert.ok(opposing.d < turn.edge.length - turn.centre - turn.radius + 0.01, 'opposing traffic stays outside the reserved pocket');
    }
    for (const lane of sim.occupancy().values()) for (let j = 1; j < lane.length; j++) assert.ok(lane[j - 1].end <= lane[j].start + 0.001);
  }
  assert.ok(arcStarted); assert.equal(car.turnaround, null);
  assert.equal(sim.adaptive.threePointTurns, 1);
  assert.ok(car.route[0] === reverse);
  assert.ok(firstQ > 0);
});

test('turning bodies stay inside the kerb at every accepted display width', () => {
  const { sim, car } = turningFixture();
  assert.equal(sim.adaptive.tryTurnaround(car, 'D'), true);
  for (const length of [7.98, 9.4, 10.92]) for (const factor of [1.44, 1.92, 2.4, 2.88, 3.84]) {
    car.length = length;
    if (!turnaroundFits(car, factor)) continue;
    for (let time = 0; time <= 14; time += 0.025) {
      car.turnaround.elapsed = car.turnaround.previousElapsed = time;
      const pose = turnaroundPose(sim, car, factor);
      const lateral = Math.abs(pose.y) + Math.abs(Math.sin(pose.angle)) * length / 2 + Math.abs(Math.cos(pose.angle)) * car.width * factor / 2;
      assert.ok(lateral <= 3.3 * factor - 0.495, `body stays clear of pavement at width ${factor}, length ${length}, time ${time}`);
      const longitudinal = Math.abs(pose.x - car.turnaround.centre) + Math.abs(Math.cos(pose.angle)) * length / 2 + Math.abs(Math.sin(pose.angle)) * car.width * factor / 2;
      assert.ok(longitudinal < car.turnaround.radius - 2, 'the full swept body fits within the traffic reservation');
    }
  }
  car.length = 10.92;
  assert.equal(turnaroundFits(car, 1.44), false, 'a long illustrated body cannot turn across a narrower carriageway');
  assert.equal(turnaroundFits(car, 2.88), true, 'ordinary display width accommodates the longest car');
});
