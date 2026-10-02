import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, canTurn } from '../src/kings-langley/engine/simulation.mjs';
import { attachCyclists, cycleAllowed, setCyclistCount, maintainCyclists } from '../src/real-cyclists.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const demand = JSON.parse(readFileSync(new URL('../data/kings-langley/demand.json', import.meta.url)));
const makeTown = (seed = 42) => ({ simulation: new Simulation(data, seed, demand), seed });
const bikes = town => town.simulation.cars.filter(car => car.type === 'bicycle');
const separated = simulation => {
    for (const [key, occupied] of simulation.occupancy()) for (let i = 1; i < occupied.length; i++)
        assert.ok(occupied[i - 1].end <= occupied[i].start + 0.001, `vehicles overlap at ${key}, time ${simulation.time}`);
};

test('riders take legal directed local routes with an independent reproducible random seed', () => {
    const town = makeTown(), again = makeTown();
    const seed = town.simulation.seed;
    attachCyclists(town, 80); attachCyclists(again, 80);
    assert.equal(town.simulation.seed, seed);
    assert.equal(bikes(town).length, 80);
    assert.deepEqual(bikes(town).map(c => [c.route, c.q, c.maxSpeed]), bikes(again).map(c => [c.route, c.q, c.maxSpeed]));
    for (const car of bikes(town)) {
        assert.ok(car.maxSpeed >= 4.3 && car.maxSpeed <= 6);
        assert.ok(car.route.every(id => cycleAllowed(data.edges[id])));
        assert.ok(car.route.every(id => !/motorway|trunk/.test(data.edges[id].tags.highway)));
        for (let i = 1; i < car.route.length; i++) assert.ok(canTurn(town.simulation.graph, data.edges[car.route[i - 1]], data.edges[car.route[i]]));
    }
    assert.equal(cycleAllowed({ tags: { highway: 'residential', bicycle: 'no' } }), false);
    assert.equal(cycleAllowed({ tags: { highway: 'service', access: 'private' } }), false);
    assert.equal(cycleAllowed({ tags: { highway: 'service', access: 'private', bicycle: 'yes' } }), true);
    separated(town.simulation);
});

test('cyclist counts clamp, remove all reservations immediately, and keep motor vehicles', () => {
    const town = makeTown(), simulation = town.simulation;
    simulation.seedCars(40);
    const motors = [...simulation.cars];
    attachCyclists(town, 24);
    const car = bikes(town)[0], zone = simulation.parking.zones[0];
    simulation.reservations.set(-1, [{ car }]);
    zone.claims.set(car.id, { car }); zone.waiting.set(car.id, 0);
    setCyclistCount(town, 0);
    assert.deepEqual(simulation.cars, motors);
    assert.equal(simulation.reservations.has(-1), false);
    assert.equal(zone.claims.has(car.id), false);
    assert.equal(zone.waiting.has(car.id), false);
    setCyclistCount(town, 999);
    assert.equal(town.cycling.target, 150);
    assert.equal(bikes(town).length, 150);
    setCyclistCount(town, '12');
    assert.equal(bikes(town).length, 12);
    setCyclistCount(town, -5);
    for (let i = 0; i < 20; i++) maintainCyclists(town, 0.1);
    assert.equal(bikes(town).length, 0);
});

test('adding riders keeps occupied pedestrian crossings clear', () => {
    const town = makeTown();
    town.simulation.crossingSpawnAllowed = car => {
        assert.ok(car.v > 0, 'crossing clearance must use the rider\'s insertion speed');
        const stop = data.edges[car.route[car.index]].length / 2;
        return car.d <= stop - 8 || car.d - car.length >= stop + 20;
    };
    attachCyclists(town, 80);
    assert.equal(bikes(town).length, 80);
    for (const car of bikes(town)) {
        const edge = data.edges[car.route[car.index]], stop = edge.length / 2;
        assert.ok(car.d <= stop - 8 || car.d - car.length >= stop + 20);
    }
});

function straightRoad() {
    const nodes = Object.fromEntries([0, 1, 2].map(id => [id, { id, p: [id * 150, 0], tags: id === 1 ? { highway: 'traffic_signals' } : {} }]));
    const edges = [0, 1].map(id => ({ id, from: id, to: id + 1, way: id + 1, forward: true, length: 150, speed: 13.4,
        points: [nodes[id].p, nodes[id + 1].p], tags: { highway: 'residential', oneway: 'yes' } }));
    return { nodes, edges, restrictions: [] };
}

test('bicycles obey red lights and cars follow them without crossing their bodies', () => {
    const simulation = new Simulation(straightRoad(), 42, { routes: [] });
    simulation.time = 10; simulation.signalOffsets.set(1, 0);
    const bicycle = simulation.createVehicle([0, 1], 'bicycle', 115);
    const car = simulation.createVehicle([0, 1], 'car', 82);
    bicycle.v = 5; car.v = 12;
    simulation.cars.push(car, bicycle);
    for (let i = 0; i < 140; i++) {
        simulation.step(0.1, 0); separated(simulation);
        assert.ok(bicycle.q < 150, 'rider crossed a red signal');
        assert.ok(car.q < bicycle.q - bicycle.length);
    }
    assert.ok(bicycle.v < 0.5);
    for (let i = 0; i < 230; i++) { simulation.step(0.1, 0); separated(simulation); }
    assert.ok(bicycle.q > 170, 'rider should continue when green');
    assert.ok(car.q < bicycle.q - bicycle.length);
});

test('mixed traffic stays separated and finished bicycle journeys replenish over time', () => {
    const town = makeTown(73), simulation = town.simulation;
    simulation.seedCars(100);
    attachCyclists(town, 48);
    const original = new Set(bikes(town).map(car => car.id));
    for (let i = 0; i < 1500; i++) {
        simulation.step(0.1, 0.2); maintainCyclists(town, 0.1);
        if (i % 5 === 0) separated(simulation);
    }
    assert.ok(bikes(town).some(car => !original.has(car.id)), 'finished bicycle journeys should be replaced');
    assert.ok(bikes(town).some(car => car.v > 2));
    assert.equal(bikes(town).length, 48);
    setCyclistCount(town, 0);
    for (const claims of simulation.reservations.values()) assert.ok(claims.every(claim => claim.car.type !== 'bicycle'));
    for (const zone of simulation.parking.zones) assert.ok([...zone.claims.values()].every(claim => claim.car.type !== 'bicycle'));
});
