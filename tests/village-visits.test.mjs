import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MiniatureSimulation } from '../src/real-town.mjs';
import { canTurn } from '../src/kings-langley/engine/graph.mjs';
import { stageParkingVisit, updateVillageVisits } from '../src/village-visits.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const makeTown = () => ({ simulation: new MiniatureSimulation(data, 27, { routes: [] }) });

test('neighbour visits use opposite legal approaches to the requested parking row and remain bounded', () => {
  for (const name of ['Coniston Road', 'Vicarage Lane']) {
    const town = makeTown(), simulation = town.simulation;
    assert.equal(stageParkingVisit(town, name), 2);
    const paths = town.villageVisits.pending.map(request => request.path);
    for (const path of paths) {
      assert.ok(!simulation.parking.byEdge.has(path[0]), 'birth is outside parked streets');
      assert.ok(!simulation.parking.byEdge.has(path.at(-1)), 'exit is outside parked streets');
      assert.ok(path.slice(1, -1).every(id => data.edges[id].tags.name === name));
      for (let i = 1; i < path.length; i++) assert.ok(canTurn(simulation.graph, data.edges[path[i - 1]], data.edges[path[i]]));
    }
    assert.equal(data.edges[paths[0][1]].from, data.edges[paths[1].at(-2)].to);
    assert.equal(stageParkingVisit(town, name), 2);
    assert.equal(stageParkingVisit(town, name), 0, 'four visits maximum');
    updateVillageVisits(town, 0.1);
    assert.equal(simulation.cars.length, 2, 'second pair waits behind first pair at the same birth points');
    assert.equal(town.villageVisits.pending.length, 2);
    assert.ok(simulation.cars.every(car => car.v === 0 && car.d - car.length >= 14));
    assert.equal(stageParkingVisit(town, name), 0, 'active visits also count towards the cap');
  }
});

test('visits wait for real traffic gaps and honour pedestrian, turnaround, parking and closure holds', () => {
  const town = makeTown(), simulation = town.simulation;
  stageParkingVisit(town, 'Coniston Road');
  simulation.crossingSpawnAllowed = () => false;
  updateVillageVisits(town, 0.5);
  assert.equal(simulation.cars.length, 0);
  simulation.crossingSpawnAllowed = () => true;
  const adaptiveAllowed = simulation.adaptive.spawnAllowed.bind(simulation.adaptive);
  simulation.adaptive.spawnAllowed = () => false;
  updateVillageVisits(town, 0.5);
  assert.equal(simulation.cars.length, 0);
  simulation.adaptive.spawnAllowed = adaptiveAllowed;
  const parkingAllowed = simulation.parking.spawnAllowed.bind(simulation.parking);
  simulation.parking.spawnAllowed = () => false;
  updateVillageVisits(town, 0.5);
  assert.equal(simulation.cars.length, 0);
  simulation.parking.spawnAllowed = parkingAllowed;
  const requests = town.villageVisits.pending;
  for (const request of requests) simulation.closures.ways.add(data.edges[request.path[0]].way);
  updateVillageVisits(town, 0.5);
  assert.equal(simulation.cars.length, 0);
  simulation.closures.ways.clear();
  const blockers = requests.map(request => {
    const car = simulation.createVehicle(request.path, 'car', request.car.q, 0);
    car.v = 10;
    return car;
  });
  simulation.cars.push(...blockers);
  updateVillageVisits(town, 0.5);
  assert.equal(town.villageVisits.pending.length, 2, 'occupied birth points wait');
  simulation.cars = [];
  updateVillageVisits(town, 0.5);
  assert.equal(town.villageVisits.pending.length, 0);
  assert.equal(simulation.cars.length, 2);
});

test('a staged pair actually gives way at Coniston then completes through ordinary simulation', () => {
  const town = makeTown(), simulation = town.simulation;
  stageParkingVisit(town, 'Coniston Road');
  let sawWaiting = false, completed = 0;
  for (let i = 0; i < 1800; i++) {
    updateVillageVisits(town, 0.1);
    simulation.step(0.1, 0);
    for (const zone of simulation.parking.zones.filter(zone => zone.localObservation)) {
      assert.ok(new Set([...zone.claims.values()].map(claim => claim.direction)).size <= 1);
      if (zone.claims.size && zone.waiting.size) sawWaiting = true;
    }
    completed = simulation.completed;
    if (completed === 2) break;
  }
  assert.ok(sawWaiting, 'one neighbour waits while the other comes through');
  assert.equal(completed, 2);
  updateVillageVisits(town, 0.5);
  assert.equal(town.villageVisits.active.size, 0);
  assert.equal(stageParkingVisit(town, 'Coniston Road'), 2, 'completed visits free the bounded queue');
});

test('turning moving traffic off discards pending visits and rejects new visits', () => {
  const town = makeTown();
  stageParkingVisit(town, 'Vicarage Lane');
  town.trafficLevel = 0;
  updateVillageVisits(town, 0.1);
  assert.equal(town.villageVisits.pending.length, 0);
  assert.equal(town.simulation.cars.length, 0);
  assert.equal(stageParkingVisit(town, 'Vicarage Lane'), 0);
  town.trafficLevel = 1;
  updateVillageVisits(town, 0.5);
  assert.equal(town.simulation.cars.length, 0, 'turning traffic back on does not replay an old click');
});
