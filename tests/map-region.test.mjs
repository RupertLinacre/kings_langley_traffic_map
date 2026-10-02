import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGION, inside, clip } from '../scripts/trim-map.mjs';
import { makeGraph, findRoute, canTurn } from '../src/kings-langley/engine/graph.mjs';

const network = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const demand = JSON.parse(readFileSync(new URL('../data/kings-langley/demand.json', import.meta.url)));
const graph = makeGraph(network);
const region = network.meta.region;
const length = points => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

// These test the user's named geographic boundaries, not an arbitrary snapshot size.
test('the village crop removes the requested neighbourhoods and preserves Lower Road', () => {
    for (const name of REGION.excludedNames) assert.ok(!network.ways.some(w => w.tags.name === name), name);
    for (const name of ['High Street', 'Langley Hill', 'Love Lane', 'Common Lane', 'Station Road', 'Red Lion Lane', 'Lower Road'])
        assert.ok(network.ways.some(w => w.tags.name === name), name);
    assert.ok(network.nodes[648389], 'the northern end of Lower Road remains');
    assert.ok(!network.places.some(p => p.name === 'Apsley'));
    assert.ok(network.edges.length < region.sourceCounts.edges / 2);
});

test('Hyde, Harthall and Toms Lane end at half the measured main alignment', () => {
    for (const [name, chain] of Object.entries(REGION.laneChains)) {
        const wayIds = new Set(chain.map(c => c.way));
        const ways = network.ways.filter(w => wayIds.has(w.sourceWay || w.id));
        const retained = ways.reduce((sum, w) => sum + length(w.points), 0);
        assert.ok(Math.abs(retained - region.laneHalves[name].sourceLength / 2) < .001, `${name}: ${retained}`);
        const end = Object.values(network.nodes).find(n => near(n.p, region.laneHalves[name].end));
        assert.ok(end?.cropBoundary, `${name} terminates at a shared crop node`);
        assert.ok(findRoute(graph, 260730927, end.id)?.length, `${name} reachable from High Street`);
        assert.ok(findRoute(graph, end.id, 260730927)?.length, `${name} returns to High Street`);
    }
    for (const edge of network.edges.filter(e => e.restoredUnderpass)) assert.equal(edge.tags.maxheight, `10'9"`);
});

test('south of the M25 there is only the junction, motorway and Watford Road terminal', () => {
    const terminalWays = new Set(REGION.terminalJunctionWays);
    for (const way of network.ways) {
        if (way.tags.ref === 'M25' || way.tags.name === 'Kings Langley Interchange' || terminalWays.has(way.id)) continue;
        if (way.tags.name === 'Watford Road') {
            assert.ok(way.points.every(p => p[1] <= REGION.watfordRoadEnd.p[1] + 1e-6));
            continue;
        }
        if (way.tags.name === 'Lower Road' || way.tags.name === 'Langleybury Lane') continue;
        assert.ok(way.points.every(p => inside(p, region.core)), way.tags.name || `way ${way.id}`);
    }
    assert.ok(network.nodes[REGION.watfordRoadEnd.node], 'Watford Road reaches the Langleybury Lane junction');
    for (const item of network.context) assert.ok(item.points.every(p => inside(p, region.core)), `context ${item.id}`);
});

test('the cropped graph and every demand segment retain valid contiguous topology', () => {
    const ways = new Set(network.ways.map(w => w.id));
    for (const [id, edge] of network.edges.entries()) {
        assert.equal(edge.id, id);
        assert.ok(ways.has(edge.way));
        assert.deepEqual(edge.points[0], network.nodes[edge.from].p);
        assert.deepEqual(edge.points.at(-1), network.nodes[edge.to].p);
        assert.ok(edge.length > 0 && edge.speed > 0);
    }
    const adjacent = new Map();
    for (const e of network.edges) for (const [a,b] of [[e.from,e.to],[e.to,e.from]]) {
        if (!adjacent.has(a)) adjacent.set(a, []);
        adjacent.get(a).push(b);
    }
    const reached = new Set([260730927]), queue = [...reached];
    for (let i = 0; i < queue.length; i++) for (const id of adjacent.get(queue[i]) || [])
        if (!reached.has(id)) { reached.add(id); queue.push(id); }
    assert.equal(reached.size, Object.keys(network.nodes).length, 'no isolated suburban fragments');
    for (const [id, route] of demand.routes.entries()) {
        assert.ok(route.path.length && route.rate > 0);
        for (const edge of route.path) assert.ok(network.edges[edge], `route ${id} references ${edge}`);
        for (let i = 1; i < route.path.length; i++)
            assert.ok(canTurn(graph, network.edges[route.path[i - 1]], network.edges[route.path[i]]), `route ${id}, turn ${i}`);
    }
    assert.ok(demand.routes.some(r => r.fromName.endsWith('boundary')));
    assert.ok(demand.routes.some(r => r.toName.endsWith('boundary')));
});

test('a clipped polyline never joins separate exits and entries across removed space', () => {
    const pieces = clip([[-1,1],[1,1],[3,1],[3,3],[1,3],[1,1]], [[0,0],[2,0],[2,2],[0,2]]);
    assert.deepEqual(pieces, [[[0,1],[1,1],[2,1]], [[1,2],[1,1]]]);
});
