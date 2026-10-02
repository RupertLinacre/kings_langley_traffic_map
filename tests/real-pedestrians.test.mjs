import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMap, MiniatureSimulation } from '../src/real-town.mjs';
import { createPedestrians, setPedestrianCount, updatePedestrians, pedestrianPose, pedestrianTrafficLimit, pedestrianSpawnAllowed } from '../src/real-pedestrians.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const map = prepareMap(data);
function townFor(realMap = map) {
    const town = { map: realMap, seed: 42, simulation: { cars: [] } };
    createPedestrians(town, 42);
    return town;
}
function crossingTown() {
    const forward = { id: 0, way: 1, from: 10, to: 20, forward: true, length: 240, speed: 12, points: [[0, 0], [240, 0]] };
    const backward = { ...forward, id: 1, from: 20, to: 10, forward: false, points: [[240, 0], [0, 0]] };
    const road = { id: 1, tags: { highway: 'residential', name: 'High Street' }, baseWidth: 6.6, size: 1, layer: 0 };
    const map = { roadById: new Map([[1, road]]), roads: [road], context: [],
        data: { nodes: { 10: { p: [0, 0] }, 20: { p: [240, 0] } }, edges: [forward, backward] } };
    const town = townFor(map);
    const crossing = town.walking.crossings[0];
    assert.ok(crossing);
    const link = town.walking.links.find(l => l.type === 'crossing');
    const person = { id: 0, speed: 1.5, pause: 0, trips: 0, node: link.from, route: [link], index: 0, progress: 0, state: 'walking' };
    town.people.push(person);
    return { town, crossing, person, edge: forward };
}
function carAt(front, speed = 0, id = 5, edge = 0) {
    return { id, route: [edge], index: 0, offsets: [0, 240], q: front, d: front, v: speed, length: 9 };
}

test('real walking routes use legal local pavements and preserve contiguous journeys at every road width', () => {
    const town = townFor();
    setPedestrianCount(town, 160);
    assert.equal(town.people.length, 160);
    assert.ok(town.walking.crossings.length);
    for (const link of town.walking.links) {
        assert.ok(!/motorway|trunk/.test(link.from.section.road.tags.highway));
        assert.notEqual(link.from.section.road.tags.foot, 'no');
        assert.notEqual(link.from.section.road.tags.sidewalk, 'no');
        assert.equal(link.from.section.road.layer, link.to.section.road.layer);
    }
    for (const person of town.people) {
        assert.ok(person.route.length);
        assert.equal(person.route.at(-1).to, person.destination);
        for (let i = 1; i < person.route.length; i++) {
            assert.equal(person.route[i - 1].to, person.route[i].from);
            for (const width of [1.5, 4]) {
                const a = pedestrianPose(town, { ...person, index: i - 1, progress: 1 }, width);
                const b = pedestrianPose(town, { ...person, index: i, progress: 0 }, width);
                assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.0001);
            }
        }
        for (const width of [1.5, 4]) {
            const p = pedestrianPose(town, person, width);
            assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle));
            assert.equal(p.layer, p.road.layer);
        }
    }
});

test('pavement positions follow road width without moving the pedestrian along the route', () => {
    const { town, crossing } = crossingTown();
    const node = crossing.section.sides.get(1)[1];
    const person = { node, route: [], index: 0 };
    for (const width of [1.5, 2.5, 4]) {
        const p = pedestrianPose(town, person, width);
        assert.equal(p.x, 120);
        assert.equal(Math.abs(p.y), crossing.section.road.baseWidth * width / 2 + 1.5);
    }
});

test('pedestrians advance with simulation dt, pause at destinations, and count reductions release crossings', () => {
    const town = townFor();
    setPedestrianCount(town, 80);
    const before = town.people.map(p => [p.index, p.progress, p.trips]);
    updatePedestrians(town, 0);
    assert.deepEqual(town.people.map(p => [p.index, p.progress, p.trips]), before);
    for (let i = 0; i < 1200; i++) updatePedestrians(town, 0.1);
    assert.notDeepEqual(town.people.map(p => [p.index, p.progress, p.trips]), before);
    assert.ok(town.people.some(p => p.trips > 0));
    setPedestrianCount(town, 10);
    assert.equal(town.people.length, 10);
    for (const crossing of town.walking.crossings) for (const person of crossing.users) assert.ok(town.people.includes(person));
    setPedestrianCount(town, 0);
    assert.ok(town.walking.crossings.every(c => c.users.size === 0 && c.exempt.size === 0));
});

test('a zebra reserves both directions and waits for already-close traffic to clear', () => {
    const { town, crossing, person, edge } = crossingTown();
    const close = carAt(115, 7), approaching = carAt(30, 5, 6), reverse = carAt(25, 3, 7, 1);
    town.simulation.cars = [close, approaching, reverse];
    updatePedestrians(town, 0.1);
    assert.equal(person.state, 'crossing_wait');
    assert.equal(pedestrianTrafficLimit(town, close, edge), Infinity);
    assert.equal(pedestrianTrafficLimit(town, approaching, edge), crossing.distance - 5.5);
    assert.equal(pedestrianTrafficLimit(town, reverse, town.map.data.edges[1]), 240 - crossing.distance - 5.5);
    updatePedestrians(town, 1);
    assert.equal(person.progress, 0);
    close.q = close.d = 140;
    approaching.v = 0; reverse.v = 0;
    updatePedestrians(town, 0.1);
    assert.equal(person.state, 'crossing');
    assert.ok(person.progress > 0);
    const p = pedestrianPose(town, person, 4);
    assert.equal(p.x, 120);
    for (let i = 0; i < 200 && person.trips === 0; i++) updatePedestrians(town, 0.1);
    assert.ok(person.crossing === null);
    assert.equal(crossing.users.size, 0);
    assert.equal(pedestrianTrafficLimit(town, approaching, edge), Infinity);
});

test('count changes cannot spawn a car or bicycle over an active crossing or too close to stop', () => {
    const { town, crossing } = crossingTown();
    assert.equal(pedestrianSpawnAllowed(town, carAt(120, 0)), true);
    updatePedestrians(town, 0.1);
    assert.equal(crossing.users.size, 1);
    assert.equal(pedestrianSpawnAllowed(town, carAt(120, 0)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(126, 0)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(105, 8)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(120, 0, 9, 1)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(60, 0)), true);
    assert.equal(pedestrianSpawnAllowed(town, carAt(145, 8)), true);
    setPedestrianCount(town, 0);
    assert.equal(pedestrianSpawnAllowed(town, carAt(120, 0)), true);
});

test('drivers yield at a crossing midway along a long street before its end enters junction lookahead', () => {
    for (const reverse of [false, true]) {
        const town = townFor();
        const simulation = town.simulation = new MiniatureSimulation(map.data, 42, { routes: [] });
        simulation.crossingStop = (car, edge) => pedestrianTrafficLimit(town, car, edge);
        const crossing = town.walking.crossings.find(c => c.kind === 'zebra' && c.section.path.length > 1000);
        assert.ok(crossing, 'the long Rucklers Lane crossing is covered');
        const edge = crossing.section.edges.find(e => e.forward === !reverse);
        const distance = crossing.edgeDistances.get(edge.id);
        assert.ok(edge.length - distance > 180, 'the crossing lies before the end-based junction lookahead');
        const link = town.walking.links.find(l => l.crossing === crossing);
        const person = { id: 0, speed: 1.2, pause: 0, trips: 0, node: link.from, route: [link], index: 0, progress: 0, state: 'walking' };
        town.people.push(person);
        town.walking.widthFactor = 4;
        const car = simulation.createVehicle([edge.id], 'car', distance - 150);
        car.v = 20;
        simulation.cars.push(car);
        let stopped = false, entered = false;
        for (let step = 0; step < 700 && !person.trips; step++) {
            updatePedestrians(town, 0.1);
            simulation.step(0.1, 0);
            if (person.state === 'crossing') {
                entered = true;
                assert.ok(car.d < distance - 3.5, 'the vehicle stays behind the occupied zebra');
                stopped ||= car.v < 0.5;
            }
        }
        assert.ok(entered && stopped && person.trips === 1, 'the walker crosses while the driver waits');
        setPedestrianCount(town, 0);
        for (let step = 0; step < 200; step++) simulation.step(0.1, 0);
        assert.ok(car.d > distance + car.length, 'traffic resumes once the zebra clears');
    }
});

test('actual vehicle physics holds a stopped queue only while a gap walker occupies its lane', () => {
    const town = townFor();
    const simulation = town.simulation = new MiniatureSimulation(map.data, 42, { routes: [] });
    simulation.crossingStop = (car, edge) => pedestrianTrafficLimit(town, car, edge);
    const crossing = town.walking.crossings.find(c => c.kind === 'gap' && c.section.path.length > 140);
    assert.ok(crossing);
    const link = town.walking.links.find(l => l.crossing === crossing);
    const nearEdge = crossing.section.edges.find(e => e.from !== crossing.section.edge.from);
    const farEdge = crossing.section.edge;
    const nearDistance = crossing.edgeDistances.get(nearEdge.id), farDistance = crossing.edgeDistances.get(farEdge.id);
    const person = { id: 0, speed: 1.3, pause: 0, trips: 0, node: link.from, route: [link], index: 0, progress: 0, state: 'walking' };
    town.people.push(person); town.walking.widthFactor = 4;
    const queued = simulation.createVehicle([nearEdge.id], 'car', nearDistance - 8);
    const opposite = simulation.createVehicle([farEdge.id], 'car', farDistance - 25);
    opposite.v = 10;
    simulation.cars.push(queued, opposite);
    let held = false, oppositePassed = false;
    for (let step = 0; step < 600 && !person.trips; step++) {
        updatePedestrians(town, 0.1);
        simulation.step(0.1, 0);
        for (const car of simulation.cars) {
            if (!crossing.occupiedEdges.has(car.route[car.index])) continue;
            const d = crossing.edgeDistances.get(car.route[car.index]);
            assert.ok(car.d < d - 1.4 || car.d - car.length > d + 1.4, 'a moving or stopped vehicle body cannot occupy the same half as the walker');
        }
        if (person.crossingLane === nearEdge.id) {
            held ||= queued.v < 0.1 && person.progress > 0.1;
            oppositePassed ||= opposite.d - opposite.length > farDistance;
        }
    }
    assert.ok(held, 'the queue does not restart through a crossing person');
    assert.ok(oppositePassed, 'traffic in the other lane remains free to pass');
    assert.equal(person.trips, 1);
    for (let step = 0; step < 100; step++) simulation.step(0.1, 0);
    assert.ok(queued.d > nearDistance, 'the released lane starts moving again');
});
