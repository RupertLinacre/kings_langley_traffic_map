import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMap, createRealTown, setRealTraffic, updateRealTown } from '../src/real-town.mjs';
import { stageTurnDemonstration } from '../src/turn-demonstration.mjs';
import { canTurn } from '../src/kings-langley/engine/graph.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const demand = JSON.parse(readFileSync(new URL('../data/kings-langley/demand.json', import.meta.url)));
const map = prepareMap(data);

test('the labelled Water Lane demonstration completes a real turn and releases its temporary stop', () => {
  const town = createRealTown(map, demand, 42, { cyclists: 0, pedestrians: 0 });
  setRealTraffic(town, 0);
  town.walking.widthFactor = 3;
  const car = stageTurnDemonstration(town);
  assert.ok(car?.turnaround);
  assert.equal(car.demonstration, 'three-point-turn');
  assert.equal(data.edges[car.route[0]].tags.name, 'Water Lane');
  const sim = town.simulation, blocker = sim.cars.find(candidate => candidate !== car);
  const blockerStart = blocker.q, destination = car.destination;
  assert.equal(sim.cars.length, 2);
  for (let i = 0; i < 550; i++) {
    updateRealTown(town, 0.1);
    for (const lane of sim.occupancy().values()) for (let j = 1; j < lane.length; j++) assert.ok(lane[j - 1].end <= lane[j].start + 0.001);
  }
  assert.equal(car.turnaround, null); assert.equal(sim.adaptive.threePointTurns, 1);
  assert.equal(car.destination, destination);
  for (let i = 1; i < car.route.length; i++) assert.ok(canTurn(sim.graph, data.edges[car.route[i - 1]], data.edges[car.route[i]]));
  assert.ok(blocker.roadStop.done && blocker.q > blockerStart + 15, 'the staged obstruction drives away after32seconds');
  assert.equal(sim.adaptive.turns.size, 0);
});

test('a blocked demonstration changes no existing traffic and cannot stack turns', () => {
  const town = createRealTown(map, demand, 73, { cyclists: 0, pedestrians: 0 });
  setRealTraffic(town, 0);
  town.walking.widthFactor = 3;
  const sim = town.simulation;
  sim.turnaroundAllowed = () => false;
  const before = [...sim.cars];
  assert.equal(stageTurnDemonstration(town), null);
  assert.deepEqual(sim.cars, before); assert.equal(sim.adaptive.turns.size, 0);
  sim.turnaroundAllowed = () => true;
  assert.ok(stageTurnDemonstration(town));
  const staged = [...sim.cars];
  assert.equal(stageTurnDemonstration(town), null);
  assert.deepEqual(sim.cars, staged);
});
