import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMap, createRealTown, setRealTraffic, updateRealTown, nearestNode, planRealTrip, realVehiclePose } from '../src/real-town.mjs';
import { canTurn } from '../src/kings-langley/engine/graph.mjs';
import { createScenery } from '../src/real-scenery.mjs';
const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const demand = JSON.parse(readFileSync(new URL('../data/kings-langley/demand.json', import.meta.url)));
const map = prepareMap(data);
const createTrafficTown = seed => createRealTown(map, demand, seed, { cyclists: 0, pedestrians: 0 });
const advance = (town, seconds) => { for (let i = 0; i < seconds * 10; i++) updateRealTown(town, 0.1); };
const nodeAt = (town, landmark) => data.nodes[landmark.nodeId] || nearestNode(map, landmark.p, town.simulation);

test('the bundled Kings Langley graph retains OSM topology, real landmarks, one-way roads and bridges', () => {
    assert.ok(data.edges.length > 500 && data.edges.length < 3037);
    assert.ok(data.ways.length > 100 && data.ways.length < 889);
    for (const name of ['High Street', 'Langley Hill', 'Common Lane', 'Love Lane', 'Station Road', 'Kings Langley Interchange'])
        assert.ok(map.roads.some(r => r.tags.name === name));
    assert.ok(map.context.some(item => item.tags.name === 'Grand Union Canal'));
    assert.ok(map.context.some(item => item.tags.name === 'West Coast Main Line'));
    assert.deepEqual(data.nodes[260730927].p, [-293.5698852628595, -110.61868400024565]);
    for (const [id, edge] of data.edges.entries()) {
        assert.equal(id, edge.id);
        assert.deepEqual(edge.points[0], data.nodes[edge.from].p);
        assert.deepEqual(edge.points.at(-1), data.nodes[edge.to].p);
        assert.ok(edge.length > 0 && edge.speed > 0);
        if (['yes', '1', 'true'].includes(edge.tags.oneway)) assert.equal(edge.forward, true);
        if (edge.tags.oneway === '-1') assert.equal(edge.forward, false);
    }
    const town = createTrafficTown(42);
    const motorway = data.edges.find(e => e.tags.highway === 'motorway' && e.tags.bridge);
    const local = data.edges.find(e => e.tags.highway === 'residential' && e.from !== motorway.to);
    assert.equal(canTurn(town.simulation.graph, motorway, local), false);
});

test('every named destination has a legal route to every other destination, including the J20 ring', () => {
    const town = createTrafficTown(42);
    const j20 = map.landmarks.find(l => l.id === 'j20');
    assert.ok(town.simulation.graph.out.get(j20.nodeId).some(e => e.tags.name === 'Kings Langley Interchange'));
    for (const from of map.landmarks) for (const to of map.landmarks) {
        if (from === to) continue;
        const trip = planRealTrip(town, nodeAt(town, from), nodeAt(town, to));
        assert.ok(trip?.ids.length, `${from.id} to ${to.id}`);
        assert.ok(trip.metres > 0 && Number.isFinite(trip.seconds));
        for (let i = 1; i < trip.edges.length; i++) assert.ok(canTurn(town.simulation.graph, trip.edges[i - 1], trip.edges[i]));
    }
});

test('Toms Lane remains connected while its low underpass excludes buses and lorries', () => {
    const town = createTrafficTown(42);
    const road = data.edges.find(edge => edge.restoredUnderpass);
    assert.ok(road, 'surveyed Toms Lane underpass is present');
    const from = data.nodes[road.from], to = data.nodes[260730927];
    const route = planRealTrip(town, from, to);
    assert.ok(route?.ids.length);
    for (const type of ['bus', 'lorry']) assert.equal(town.simulation.createVehicle([road.id], type).type, 'car');
    assert.equal(town.simulation.createVehicle([road.id], 'bicycle').type, 'bicycle');
});

test('new traffic and decorative seeds leave the actual street layout untouched', () => {
    const before = JSON.stringify(data);
    const a = createTrafficTown(42), b = createTrafficTown(73);
    const sceneryA = createScenery(map, 42), sceneryB = createScenery(map, 73);
    assert.notDeepEqual(sceneryA.buildings.map(b => [b.x, b.y]), sceneryB.buildings.map(b => [b.x, b.y]));
    assert.ok(sceneryA.buildings.length > 300 && sceneryA.trees.length > 300);
    advance(a, 10); advance(b, 10);
    assert.equal(JSON.stringify(data), before);
    assert.equal(a.map, b.map);
});

test('road widening changes only lateral display geometry and does not alter vehicle positions or queues', () => {
    const town = createTrafficTown(73);
    advance(town, 10);
    const before = town.simulation.cars.map(c => [c.id, c.q, c.v, c.length]);
    let moved = false;
    for (const car of town.simulation.cars) {
        const narrow = realVehiclePose(town, car, 1.5), wide = realVehiclePose(town, car, 4);
        for (const p of [narrow, wide]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle));
        moved ||= Math.hypot(narrow.x - wide.x, narrow.y - wide.y) > 1;
    }
    assert.ok(moved);
    assert.deepEqual(town.simulation.cars.map(c => [c.id, c.q, c.v, c.length]), before);
});

test('enlarged bodies stay separated across short map edges at ordinary and heavy traffic', () => {
    const town = createTrafficTown(42);
    let lowWaiting, lowSpeed;
    for (let i = 0; i < 2400; i++) {
        if (i === 1200) { lowWaiting = town.metrics.waiting; lowSpeed = town.metrics.meanSpeed; setRealTraffic(town, 6); }
        updateRealTown(town, 0.1);
        if (i % 5) continue;
        for (const [key, occupied] of town.simulation.occupancy()) for (let j = 1; j < occupied.length; j++) {
            assert.ok(occupied[j - 1].end <= occupied[j].start + 0.001, `overlap at ${key}, time ${i / 10}`);
        }
    }
    assert.ok(town.metrics.waiting > lowWaiting * 2);
    assert.ok(town.metrics.meanSpeed < lowSpeed);
    assert.ok(town.metrics.longestQueue > 300);
    const previous = new Set(town.simulation.cars.map(c => c.id));
    setRealTraffic(town, 0);
    assert.equal(town.simulation.cars.length, 0);
    assert.equal(town.simulation.reservations.size, 0);
    assert.equal(town.simulation.pendingTotal, 0);
    assert.ok(town.simulation.parking.zones.every(z => !z.claims.size && !z.parked.size && !z.waiting.size && z.narrow === (z.defaultBaseline > 0)));
    advance(town, 5);
    assert.equal(town.simulation.cars.length, 0);
    setRealTraffic(town, 1); advance(town, 15);
    assert.ok(town.simulation.cars.every(c => !previous.has(c.id)));
    assert.ok(town.simulation.cars.some(c => c.v > 5));
});
