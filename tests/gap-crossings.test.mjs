import test from 'node:test';
import assert from 'node:assert/strict';
import { createPedestrians, updatePedestrians, setPedestrianCount, pedestrianPose, pedestrianTrafficLimit, pedestrianSpawnAllowed } from '../src/real-pedestrians.mjs';

function fixture({ tags = {}, parking } = {}) {
    const road = { id: 1, baseWidth: 6.6, size: 1, layer: 0, tags: { highway: 'residential', name: 'A local street', ...tags } };
    const forward = { id: 0, way: 1, from: 10, to: 20, forward: true, length: 140, speed: 12, tags: road.tags, points: [[0, 0], [140, 0]] };
    const backward = { ...forward, id: 1, from: 20, to: 10, forward: false, points: [[140, 0], [0, 0]] };
    const map = { roads: [road], roadById: new Map([[1, road]]), context: [],
        data: { nodes: { 10: { p: [0, 0] }, 20: { p: [140, 0] } }, edges: [forward, backward] } };
    const town = { map, seed: 42, simulation: { cars: [], parking } };
    createPedestrians(town);
    const crossing = town.walking.crossings.find(c => c.kind === 'gap');
    const link = town.walking.links.find(l => l.crossing === crossing && crossing);
    if (!link) return { town };
    const person = { id: 0, speed: 3, pause: 0, trips: 0, node: link.from, route: [link], index: 0, progress: 0, state: 'walking' };
    town.people.push(person);
    return { town, crossing, person, forward, backward };
}
function carAt(front, speed = 0, edge = 1, id = 5) {
    return { id, route: [edge], index: 0, offsets: [0, 140], q: front, d: front, v: speed, length: 9 };
}

test('unmarked crossing waits for real gaps, then independently checks the second lane', () => {
    const { town, person, crossing, forward, backward } = fixture();
    assert.ok(crossing);
    const near = carAt(50, 8), far = carAt(50, 8, 0, 6);
    town.simulation.cars = [near, far];
    updatePedestrians(town, 0.1);
    updatePedestrians(town, 1);
    assert.equal(person.state, 'gap_wait');
    assert.equal(person.progress, 0);
    assert.equal(pedestrianTrafficLimit(town, near, backward), Infinity, 'waiting on the pavement cannot command traffic to stop');
    assert.equal(pedestrianTrafficLimit(town, far, forward), Infinity);
    near.q = near.d = 95;
    updatePedestrians(town, 0.1);
    assert.equal(person.state, 'gap_crossing');
    assert.deepEqual(person.gapChecks, { nearClear: true, farClear: false, queued: false });
    assert.deepEqual([...crossing.occupiedEdges], [1]);
    assert.equal(pedestrianTrafficLimit(town, far, forward), Infinity, 'the opposite lane continues until the walker has found its own gap');
    assert.equal(pedestrianTrafficLimit(town, near, backward), Infinity, 'a rear bumper already past the crossing continues');
    updatePedestrians(town, 4);
    assert.equal(person.state, 'gap_middle_wait');
    assert.ok(person.progress < 0.5);
    assert.deepEqual([...crossing.occupiedEdges], [1], 'the near lane remains held while the walker waits inside it');
    assert.ok(Math.abs(pedestrianPose(town, person).y - 2) < 1e-8);
    assert.equal(pedestrianTrafficLimit(town, far, forward), Infinity);
    far.q = far.d = 95;
    updatePedestrians(town, 0.1);
    assert.equal(person.state, 'gap_crossing');
    assert.deepEqual([...crossing.occupiedEdges], [1, 0], 'both lanes stay held until the person fully clears the near side');
    updatePedestrians(town, 4);
    assert.equal(person.trips, 1);
    assert.equal(crossing.users.size, 0);
    assert.equal(crossing.occupiedEdges.size, 0);
});

test('a stationary body blocks the walker, but a space in a queue is usable and held', () => {
    const { town, person, crossing, backward, forward } = fixture();
    const blocking = carAt(75), queued = carAt(64, 0, 1, 6), opposite = carAt(20, 10, 0, 7);
    town.simulation.cars = [blocking, queued, opposite];
    updatePedestrians(town, 0.1);
    updatePedestrians(town, 1);
    assert.equal(person.progress, 0, 'the body spanning 66–75m covers the crossing at 70m');
    blocking.q = blocking.d = 82;
    updatePedestrians(town, 0.1);
    assert.ok(person.progress > 0, 'the space from 64–73m is wide enough to cross');
    assert.match(person.activity, /queue/);
    assert.equal(pedestrianTrafficLimit(town, queued, backward), crossing.distance - 2.4);
    assert.equal(pedestrianTrafficLimit(town, opposite, forward), Infinity);
    assert.equal(pedestrianTrafficLimit(town, blocking, backward), Infinity);
});

test('spawn protection and count cleanup reserve only the occupied half of an unmarked crossing', () => {
    const { town, crossing, person } = fixture();
    updatePedestrians(town, 0.1);
    assert.equal(pedestrianSpawnAllowed(town, carAt(70)), true, 'curb waiting is not a traffic reservation');
    updatePedestrians(town, 0.1);
    assert.equal(pedestrianSpawnAllowed(town, carAt(70)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(65, 9)), false);
    assert.equal(pedestrianSpawnAllowed(town, carAt(70, 0, 0)), true);
    assert.equal(pedestrianSpawnAllowed(town, carAt(100)), true);
    setPedestrianCount(town, 0);
    assert.equal(crossing.users.size, 0);
    assert.equal(crossing.occupiedEdges.size, 0);
    assert.equal(pedestrianSpawnAllowed(town, carAt(70)), true);
    assert.equal(town.people.includes(person), false);
    createPedestrians(town);
    assert.ok(town.walking.crossings.every(c => c.users.size === 0 && c.occupiedEdges.size === 0));
});

test('gap acceptance allows enough time for the displayed road width', () => {
    const { town, person } = fixture();
    const approaching = carAt(15, 10);
    town.simulation.cars = [approaching];
    town.walking.widthFactor = 4;
    updatePedestrians(town, 0.1);
    updatePedestrians(town, 0.1);
    assert.equal(person.progress, 0, 'the wide display needs more time than this gap offers');
    town.walking.widthFactor = 1.5;
    updatePedestrians(town, 0.1);
    assert.ok(person.progress > 0);
    assert.equal(pedestrianPose(town, { ...person, progress: 0.5 }, 1.5).y, 0);
    assert.equal(pedestrianPose(town, { ...person, progress: 0.5 }, 4).y, 0);
});

test('unmarked crossings avoid parked bottlenecks, bridges, tunnels, one-way and multilane streets', () => {
    for (const tags of [{ bridge: 'yes' }, { tunnel: 'yes' }, { lanes: '4' }, { oneway: 'yes' }, { highway: 'motorway' }, { highway: 'trunk' }]) {
        assert.equal(fixture({ tags }).town.walking.crossings.length, 0);
    }
    const parking = { byEdge: new Map([[0, { start: 55, end: 85 }]]) };
    assert.equal(fixture({ parking }).town.walking.crossings.length, 0);
});

test('waiting beside the centre leaves room for passing buses at narrow and normal widths', () => {
    for (const width of [1.5, 2.5]) for (const reverse of [false, true]) {
        const { town, person, crossing, forward, backward } = fixture();
        town.walking.widthFactor = width;
        if (reverse) {
            const back = person.route[0].to.links.find(link => link.crossing === crossing);
            person.route = [back]; person.node = back.from;
        }
        const nearId = reverse ? 0 : 1, farId = reverse ? 1 : 0;
        const waitingCar = carAt(60, 0, nearId), bus = { ...carAt(50, 8, farId, 8), type: 'bus', width: 2.5, length: 17.4 };
        town.simulation.cars = [waitingCar, bus];
        updatePedestrians(town, 0.1);
        updatePedestrians(town, 8);
        assert.equal(person.state, 'gap_middle_wait');
        const side = reverse ? -1 : 1;
        const pose = pedestrianPose(town, person, width);
        assert.ok(Math.abs(pose.y - side * 2) < 1e-8);
        const busInner = -side * (1.55 - bus.width / 2) * width;
        const walkerLeadingPoint = pose.y - side * 1.6;
        assert.ok(side * (walkerLeadingPoint - busInner) > 0.3, 'the waiting body has clearance from the moving bus envelope');
        assert.equal(pedestrianTrafficLimit(town, bus, farId === 0 ? forward : backward), Infinity);
        assert.ok(Number.isFinite(pedestrianTrafficLimit(town, waitingCar, nearId === 0 ? forward : backward)));
        // A width change while paused preserves a safe waiting place visually.
        assert.ok(Math.abs(pedestrianPose(town, person, width === 1.5 ? 2.5 : 1.5).y - side * 2) < 1e-8);
        const curb = 6.6 * width / 2 + 1.5;
        bus.q = bus.d = 70 - ((curb / person.speed + 1.2) * bus.v + 1);
        updatePedestrians(town, 0.1);
        assert.equal(person.state, 'gap_middle_wait', 'the second gap covers the extra two metres from the waiting point');
        bus.q = bus.d = 105;
        updatePedestrians(town, 0.1);
        assert.deepEqual([...crossing.occupiedEdges].sort(), [0, 1]);
        assert.equal(pedestrianSpawnAllowed(town, carAt(70, 0, nearId)), false);
        assert.equal(pedestrianSpawnAllowed(town, carAt(70, 0, farId)), false);
        setPedestrianCount(town, 1);
        assert.deepEqual([...crossing.occupiedEdges].sort(), [0, 1], 'count updates preserve both reservations for an existing walker');
        let released = false;
        for (let i = 0; i < 200 && !person.trips; i++) {
            updatePedestrians(town, 0.05);
            if (!crossing.occupiedEdges.has(nearId) && person.crossing) {
                const p = pedestrianPose(town, person, width);
                const trailingFeet = p.y + side * 2.675;
                const nearBusInner = side * (1.55 - 2.5 / 2) * width;
                assert.ok(side * (nearBusInner - trailingFeet) > 0.25, 'the near lane releases only after the whole walking sprite clears it');
                released = true;
                break;
            }
        }
        assert.ok(released);
        assert.deepEqual([...crossing.occupiedEdges], [farId]);
        setPedestrianCount(town, 0);
        assert.equal(crossing.occupiedEdges.size, 0);
    }
});
