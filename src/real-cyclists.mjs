import { canTurn } from './kings-langley/engine/graph.mjs';
import { line, rounded, circle } from './miniature-art.mjs';

const COLOURS = ['#d47a59', '#4f9692', '#d5aa42', '#727bae', '#759e6b', '#e8dbc0'];
const ROADS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'service', 'living_street']);

// Keep bicycles on the directed public street network. Turn restrictions and
// traffic signals remain shared with cars; motorway/trunk roads are excluded.
export function cycleAllowed(edge) {
    const tags = edge.tags || {};
    if (!ROADS.has(tags.highway) || tags.motorroad === 'yes' || ['no', 'private', 'dismount', 'use_sidepath'].includes(tags.bicycle)) return false;
    return !['no', 'private'].includes(tags.access) || ['yes', 'designated', 'permissive'].includes(tags.bicycle);
}

function makeRandom(seed) {
    return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
}

function makeRoutes(simulation, random) {
    const allowed = simulation.data.edges.filter(cycleAllowed), out = new Map(), routes = [];
    for (const edge of allowed) {
        if (!out.has(edge.from)) out.set(edge.from, []);
        out.get(edge.from).push(edge);
    }
    for (let attempt = 0; attempt < 420 && routes.length < 180 && allowed.length; attempt++) {
        let edge = allowed[Math.floor(random() * allowed.length)], length = 0;
        const path = [], visited = new Set([edge.from]), limit = 500 + random() * 1400;
        while (edge && path.length < 80) {
            path.push(edge.id); length += edge.length; visited.add(edge.to);
            if (length >= limit) break;
            const candidates = (out.get(edge.to) || []).filter(next => !visited.has(next.to) && canTurn(simulation.graph, edge, next));
            edge = candidates[Math.floor(random() * candidates.length)];
        }
        if (length > 100) routes.push({ path, length });
    }
    return routes;
}

export function attachCyclists(town, count = 24) {
    if (!town.cycling) {
        const random = makeRandom((town.seed ^ 0x43c1e57) >>> 0);
        town.cycling = { random, routes: makeRoutes(town.simulation, random), target: 0, clock: 0 };
    }
    setCyclistCount(town, count);
    return town.cycling;
}

function releaseRemoved(simulation, removed) {
    for (const [node, claims] of simulation.reservations) {
        const keep = claims.filter(claim => !removed.has(claim.car.id));
        if (keep.length) simulation.reservations.set(node, keep); else simulation.reservations.delete(node);
    }
    for (const zone of simulation.parking.zones) {
        for (const group of [zone.claims, zone.waiting, zone.parked]) for (const id of removed) group.delete(id);
        if (!zone.claims.size) { zone.direction = 0; zone.batch = 0; }
    }
}

export function setCyclistCount(town, count) {
    const value = Number(count);
    if (!Number.isFinite(value)) return;
    if (!town.cycling) { attachCyclists(town, value); return; }
    const state = town.cycling, simulation = town.simulation;
    state.target = Math.max(0, Math.min(150, Math.round(value)));
    const riders = simulation.cars.filter(car => car.type === 'bicycle');
    const removed = new Set(riders.slice(state.target).map(car => car.id));
    if (removed.size) {
        simulation.cars = simulation.cars.filter(car => !removed.has(car.id));
        releaseRemoved(simulation, removed);
    }
    replenish(town);
}

function replenish(town) {
    const state = town.cycling, simulation = town.simulation;
    let missing = state.target - simulation.cars.filter(car => car.type === 'bicycle').length;
    if (missing <= 0 || !state.routes.length) return;
    const attempts = Math.max(12, missing * 12);
    let occupied = simulation.occupancy();
    for (let attempt = 0; attempt < attempts && missing > 0; attempt++) {
        const route = state.routes[Math.floor(state.random() * state.routes.length)];
        if (route.path.some(id => simulation.closures.ways.has(simulation.data.edges[id].way))) continue;
        const distance = 15 + state.random() * Math.max(1, route.length - 40);
        // Bicycle controls have their own random stream, so changing the slider
        // does not consume the motor traffic demand generator's random numbers.
        const seed = simulation.seed;
        const car = simulation.createVehicle(route.path, 'bicycle', distance, 0);
        simulation.seed = seed;
        car.cyclist = true;
        car.length = 5.6;
        car.maxSpeed = 4.3 + state.random() * 1.7;
        car.desiredFactor = 1;
        car.paint = COLOURS[Math.floor(state.random() * COLOURS.length)];
        const edge = simulation.data.edges[car.route[car.index]];
        car.v = Math.min(edge.speed, car.maxSpeed) * 0.55;
        // Insert completely inside one shape edge, outside junction mouths and
        // narrow parking stretches. Never insert into a moving vehicle's gap.
        if (car.d < car.length + 8 || edge.length - car.d < 15) continue;
        if (car.parkingPassages.some(p => car.q > p.entry - 20 && car.q - car.length < p.exit + 20)) continue;
        if (simulation.crossingSpawnAllowed?.(car) === false) continue;
        const occupiedLane = occupied.get(`${edge.id}:0`) || [];
        if (occupiedLane.some(fragment => car.d + 12 > fragment.start && car.d - car.length - Math.max(16, fragment.car.v * 2) < fragment.end)) continue;
        simulation.cars.push(car);
        missing--;
        occupied = simulation.occupancy();
    }
}

export function maintainCyclists(town, dt) {
    if (!town.cycling) return;
    town.cycling.clock += dt;
    if (town.cycling.clock < 1) return;
    town.cycling.clock %= 1;
    replenish(town);
}

// The same tiny frame, handlebars, helmet and pedalling legs as the website.
// Draw at world coordinates; the wheel ends fit inside the physics body.
export function drawCyclist(g, car, pose, time, widthFactor = 2) {
    const pedal = Math.sin(car.q * 1.2) * 2.5;
    g.save(); g.translate(pose.x, pose.y); g.rotate(pose.angle);
    g.scale(car.length / 14, Math.min(0.85, Math.max(0.42, widthFactor * 0.25)));
    circle(g, 1, 1.5, 3.3, '#304b3c20');
    line(g, -5, 0, 5, 0, '#344f50', 1.5);
    for (const x of [-5, 5]) rounded(g, x - 2, -1, 4, 2, 1, '#33454a');
    line(g, -3, -pedal, 1, 0, '#ddd5b6', 1.6);
    line(g, -3, pedal, 1, 0, '#607e87', 1.6);
    line(g, 4, -3, 4, 3, '#344f50', 1.2);
    rounded(g, -2.5, -2.8, 6, 5.6, 2, car.paint);
    circle(g, 2, 0, 2.2, '#f4dba2');
    line(g, 2.5, -2, 4, -3, '#dfb994', 1);
    line(g, 2.5, 2, 4, 3, '#dfb994', 1);
    g.restore();
}
