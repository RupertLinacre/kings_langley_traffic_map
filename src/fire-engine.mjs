import { position } from './kings-langley/engine/graph.mjs';
import { laneOffset } from './kings-langley/engine/traffic-model.mjs';
import { pedestrianPose } from './real-pedestrians.mjs';
import { groupPose } from './purposeful-journeys.mjs';
import { stationPassengerPose, stationReservedBodies } from './station-visits.mjs';
import { pathPoint } from './street-geometry.mjs';
import { orientedBodiesOverlap } from './body-geometry.mjs';
import { fireStationGeometry, fireStationContainsPoint } from './fire-station.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const styleFactor = (road, size) => Math.min(size * (road.size || 1), road.widthCap || Infinity);
const geometries = new WeakMap();
const buildingGeometry = new WeakMap();
const stations = new WeakMap();
const CELL = 48;
const PAVEMENT = 3;
// The map and simulation use metres and seconds, including accelerated play.
export const FIRE_ENGINE_MAX_SPEED_MPS = 80 * 0.44704;
const DRIVE_STEP_SECONDS = 0.01;

function segment(a, b, extra = {}) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return { a, b, dx, dy, square: dx * dx + dy * dy, ...extra };
}
function projection(p, s) {
    const raw = ((p.x - s.a.x) * s.dx + (p.y - s.a.y) * s.dy) / (s.square || 1), t = clamp(raw, 0, 1);
    return { distance: Math.hypot(p.x - s.a.x - s.dx * t, p.y - s.a.y - s.dy * t), t, raw };
}
function put(grid, s, radius) {
    for (let x = Math.floor((Math.min(s.a.x, s.b.x) - radius) / CELL); x <= Math.floor((Math.max(s.a.x, s.b.x) + radius) / CELL); x++)
        for (let y = Math.floor((Math.min(s.a.y, s.b.y) - radius) / CELL); y <= Math.floor((Math.max(s.a.y, s.b.y) + radius) / CELL); y++) {
            const key = `${x}:${y}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(s);
        }
}
const nearby = (grid, p) => grid.get(`${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`) || [];

// Match the rounded path actually drawn by RealMapRenderer, including its
// quadratic corner fillets. Surveyed straight chords would permit grass at a
// corner while rejecting part of the visibly paved bend.
function roundedRoad(road) {
    const input = road.points.map(([x, y]) => ({ x, y })), points = [input[0]];
    for (let i = 1; i < input.length - 1; i++) {
        const a = input[i - 1], p = input[i], b = input[i + 1];
        const before = Math.hypot(p.x - a.x, p.y - a.y), after = Math.hypot(b.x - p.x, b.y - p.y);
        if (!before || !after) continue;
        const r = Math.min(4, before * 0.25, after * 0.25);
        const start = { x: p.x + (a.x - p.x) * r / before, y: p.y + (a.y - p.y) * r / before };
        const end = { x: p.x + (b.x - p.x) * r / after, y: p.y + (b.y - p.y) * r / after };
        points.push(start);
        for (let n = 1, count = Math.max(4, Math.ceil(r * 3)); n <= count; n++) {
            const t = n / count, u = 1 - t;
            points.push({ x: u * u * start.x + 2 * u * t * p.x + t * t * end.x,
                y: u * u * start.y + 2 * u * t * p.y + t * t * end.y });
        }
    }
    points.push(input.at(-1));
    return points;
}
function geometry(town) {
    if (geometries.has(town.map)) return geometries.get(town.map);
    const grid = new Map(), water = new Map(), rails = new Map(), nodes = new Map();
    for (const road of town.map.roads) {
        const points = roundedRoad(road);
        for (let i = 1; i < points.length; i++) put(grid, segment(points[i - 1], points[i],
            { road, first: i === 1, last: i === points.length - 1 }), road.baseWidth * 4.4 / 2 + PAVEMENT + 1);
        for (const edge of road.edges) for (const id of [edge.from, edge.to]) {
            if (!nodes.has(id)) nodes.set(id, new Set());
            nodes.get(id).add(road);
        }
    }
    for (const item of town.map.context || []) {
        const isWater = item.tags.waterway, isRail = item.tags.railway;
        if (!isWater && !isRail) continue;
        const target = isWater ? water : rails, radius = isWater ? (isWater === 'stream' ? 2 : 4.5) : 2;
        const points = item.points.map(([x, y]) => ({ x, y }));
        for (let i = 1; i < points.length; i++) put(target, segment(points[i - 1], points[i], { layer: item.layer || 0, radius }), radius + 1);
    }
    const result = { grid, water, rails, nodes, portals: new Map() };
    geometries.set(town.map, result);
    return result;
}
function halfSurface(road, size, p, s) {
    const half = road.baseWidth * styleFactor(road, size) / 2;
    // Use the visible pavement border. Where the map explicitly excludes a
    // pavement, the appliance must remain on the asphalt itself.
    const tags = road.tags || {};
    let pavement = /motorway|trunk/.test(tags.highway) || tags.sidewalk === 'no' || tags.sidewalk === 'separate' || tags.foot === 'no' ? 0 : PAVEMENT;
    if (tags.sidewalk === 'left' || tags.sidewalk === 'right') {
        const left = s.dx * (p.y - s.a.y) - s.dy * (p.x - s.a.x) < 0;
        if (left !== (tags.sidewalk === 'left')) pavement = 0;
    }
    return half + pavement - 0.12;
}
function portals(town, road) {
    const geo = geometry(town);
    if (geo.portals.has(road)) return geo.portals.get(road);
    const result = [];
    for (const edge of road?.edges || []) for (const node of [edge.from, edge.to]) {
        const point = town.map.data.nodes[node]?.p;
        if (!point) continue;
        for (const next of geo.nodes.get(node) || []) {
            if (next.layer !== road.layer) result.push({ road: next, point: { x: point[0], y: point[1] } });
        }
    }
    geo.portals.set(road, result);
    return result;
}
function fullBodySamples(body) {
    const c = Math.cos(body.angle), s = Math.sin(body.angle), points = [];
    const nx = Math.ceil(body.length / 0.65), ny = Math.ceil(body.width / 0.65);
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
        const x = (i / nx - 0.5) * body.length, y = (j / ny - 0.5) * body.width;
        points.push({ x: body.x + c * x - s * y, y: body.y + s * x + c * y });
    }
    return points;
}
function sceneryBodies(town) {
    const scenery = town.scenery || town.fireEngineScenery;
    if (!scenery) return [];
    if (!buildingGeometry.has(scenery)) buildingGeometry.set(scenery, (scenery.buildings || []).map(b =>
        // The artwork includes roof/eave overhang. Use the wall footprint so a
        // tiny decorative corner cannot snag the appliance's side mirror.
        ({ x: b.x, y: b.y, angle: b.angle || 0, length: Math.max(1, b.w - 0.5), width: Math.max(1, b.h - 0.5), layer: 0, kind: 'building' })));
    return buildingGeometry.get(scenery);
}
function stationFor(town) {
    if (town.fireStation) return town.fireStation;
    if (!stations.has(town.map)) stations.set(town.map, fireStationGeometry(town.map));
    return stations.get(town.map);
}
function wallBodies(town) {
    return [...sceneryBodies(town), ...(stationFor(town)?.buildings || []).map(b => ({ ...b, kind: 'building' }))];
}
function bodyOnSurface(town, body, size, currentRoad = body.road) {
    const geo = geometry(town), joins = portals(town, currentRoad), station = stationFor(town);
    const limit = body.length + body.width + 2;
    for (const p of fullBodySamples(body)) {
        const surfaces = nearby(geo.grid, p).filter(s => {
            if ((s.road.layer || 0) !== (body.layer || 0) && !joins.some(join =>
                (join.road === s.road || s.road === currentRoad && join.road.layer === body.layer) &&
                Math.hypot(join.point.x - p.x, join.point.y - p.y) <= limit)) return false;
            const projected = projection(p, s);
            if (s.road.layer > 0 && (s.first && projected.raw < 0 || s.last && projected.raw > 1)) return false;
            return projected.distance <= halfSurface(s.road, size, p, s);
        });
        if (!surfaces.length && !fireStationContainsPoint(station, { ...p, layer: body.layer })) return false;
        // Only a surveyed road bridge/tunnel may carry a body over water or
        // rails; a nearby enlarged street cannot manufacture such a crossing.
        for (const mask of [geo.water, geo.rails]) for (const s of nearby(mask, p)) {
            if (projection(p, s).distance >= s.radius + 0.1) continue;
            if (!surfaces.some(surface => (surface.road.layer || 0) !== s.layer &&
                (surface.road.tags.bridge && surface.road.tags.bridge !== 'no' || surface.road.tags.tunnel && surface.road.tags.tunnel !== 'no'))) return false;
        }
    }
    return !wallBodies(town).some(b => Math.hypot(b.x - body.x, b.y - body.y) < (b.length + b.width + body.length + body.width) / 2 && orientedBodiesOverlap(body, b, 0.03));
}

/** The shared physical surface guard for arbitrary, already scaled vehicle
 * hulls. Emergency traffic and the player use the same paved boundary, scenery
 * masks and connected bridge portals when choosing a safe place to move. */
export function bodyOnPavedSurface(town, body, widthFactor = town.walking?.widthFactor || 3, { road = body?.road } = {}) {
    if (!body || !road || ![body.x, body.y, body.angle, body.length, body.width, widthFactor].every(Number.isFinite) ||
        body.length <= 0 || body.width <= 0 || widthFactor <= 0) return false;
    return bodyOnSurface(town, { ...body, road, layer: body.layer ?? road.layer ?? 0 }, widthFactor, road);
}

/** Full rendered truck body on the paved corridor; also useful to audits. */
export function fireEngineFits(town, widthFactor = town.fireEngine?.widthFactor || town.walking?.widthFactor || 3) {
    const engine = town.fireEngine;
    if (!engine?.active) return false;
    return bodyOnPavedSurface(town, engine.pose || renderedBody(engine, widthFactor), widthFactor);
}
function renderedBody(engine, size) {
    return { x: engine.x, y: engine.y, angle: engine.angle, length: engine.length,
        width: engine.width * styleFactor(engine.road, size), layer: engine.layer, road: engine.road,
        visible: engine.active, active: engine.active, siren: engine.siren, speed: engine.speed };
}
function nearestRoad(town, body, currentRoad) {
    const joins = portals(town, currentRoad), radius = body.length + body.width + 2;
    let best = currentRoad, distance = Infinity;
    for (const s of nearby(geometry(town).grid, body)) {
        if (s.road.layer !== body.layer && !joins.some(join => join.road === s.road && Math.hypot(join.point.x - body.x, join.point.y - body.y) < radius)) continue;
        const d = projection(body, s).distance;
        if (d < distance) { distance = d; best = s.road; }
    }
    return best;
}
function addSpanBodies(result, town, span, size, kind, ownerId) {
    const road = town.map.roadById.get(span.edge.way);
    if (!road) return;
    const count = Math.max(1, Math.ceil((span.end - span.start) / 4));
    for (let i = 0; i < count; i++) {
        const from = span.start + (span.end - span.start) * i / count, to = span.start + (span.end - span.start) * (i + 1) / count;
        const a = position(span.edge, from), b = position(span.edge, to);
        result.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x),
            length: Math.hypot(b.x - a.x, b.y - a.y) + 1.1, width: road.baseWidth * styleFactor(road, size) + 6,
            layer: road.layer, kind, ownerId });
    }
}

/** Static people/parked bodies and promised manoeuvre sweeps. Traffic uses the
 * same provider when choosing somewhere safe to pull over for the siren. */
export function fireEngineObstacles(town, widthFactor = town.walking?.widthFactor || 3) {
    const result = wallBodies(town), sim = town.simulation;
    for (const zone of sim.parking?.zones || []) for (const actor of sim.parking.visibleSlots(zone)) {
        const raw = sim.parking.parkedPosition(zone, actor.slot), road = town.map.roadById.get(raw.edge.way);
        const factor = styleFactor(road, widthFactor), p = sim.parking.parkedPosition(zone, actor.slot, factor);
        result.push({ x: p.x, y: p.y, angle: Math.atan2(p.dy, p.dx) + (actor.direction === -1 ? Math.PI : 0),
            length: actor.car?.length || actor.length || 9, width: (actor.car?.width || actor.width || 1.8) * factor,
            layer: road.layer, kind: 'parked car', ownerId: actor.car?.id ?? actor.id ?? `resident:${zone.id}:${actor.slot}` });
    }
    for (const person of town.people || []) {
        const p = pedestrianPose(town, person, widthFactor);
        if (p.visible === false) continue;
        result.push({ ...p, length: 2.6, width: 2.1, layer: p.layer || 0, kind: 'pedestrian', ownerId: `walker:${person.id}` });
    }
    for (const group of town.purposefulJourneys?.groups || []) {
        const p = groupPose(town, group, widthFactor);
        if (!p.visible) continue;
        const walker = group.walker, link = walker.route?.[walker.index];
        const d = link?.type === 'walk' ? link.from.distance + (link.to.distance - link.from.distance) * walker.progress : walker.node.distance;
        const canonical = pathPoint(group.walk.section.path, d).angle, side = group.walk.side;
        for (const [i, member] of group.members.entries()) result.push({ ...p,
            x: p.x + Math.sin(canonical) * side * i * 2.15, y: p.y - Math.cos(canonical) * side * i * 2.15,
            length: member.role === 'child' ? 2 : 2.6, width: member.role === 'child' ? 1.6 : 2.1,
            kind: 'pedestrian', ownerId: `family:${group.id}:${i}` });
    }
    for (const person of town.stationVisits?.passengers || []) {
        const p = stationPassengerPose(town, person, widthFactor, 1);
        if (!p.visible) continue;
        result.push({ ...p, length: 2.6, width: 2.1, kind: 'pedestrian', ownerId: `station:${person.id}` });
    }
    for (const pocket of sim.parking?.activity?.pockets?.values() || [])
        for (const span of pocket.spans) addSpanBodies(result, town, span, widthFactor, 'parking manoeuvre', pocket.car.id);
    for (const turn of sim.adaptive?.turns?.values() || [])
        addSpanBodies(result, town, { edge: turn.edge, start: Math.max(0, turn.centre - turn.radius), end: Math.min(turn.edge.length, turn.centre + turn.radius) }, widthFactor, 'turning car', turn.car.id);
    for (const pass of sim.busOvertaking?.passes?.values() || [])
        for (const span of pass.spans) addSpanBodies(result, town, span, widthFactor, 'overtaking car', pass.car.id);
    // Recovery bodies use only the shared pose provider, so this does not call
    // the obstacle provider recursively. A new player manoeuvre must respect
    // the space an ordinary driver has already promised to reverse/merge into.
    result.push(...(sim.cooperative?.reservedBodies?.() || []));
    result.push(...stationReservedBodies(town));
    return result;
}
function carBody(town, car, size) {
    if (town.simulation.emergency?.body) return { ...town.simulation.emergency.body(car), car, ownerId: car.id,
        kind: car.type === 'bicycle' ? 'cyclist' : car.parked ? 'parked car' : 'traffic' };
    const edges = town.map.data.edges;
    let index = Math.min(car.index, car.route.length - 1), d = car.q - car.length / 2 - car.offsets[index];
    while (d < 0 && index > 0) { index--; d += edges[car.route[index]].length; }
    const edge = edges[car.route[index]], road = town.map.roadById.get(edge.way), factor = styleFactor(road, size);
    const parked = town.simulation.parking?.pose?.(car, factor, 1);
    if (parked) return { ...parked, length: car.length, width: car.width * factor, layer: road.layer, kind: 'parked car', car, ownerId: car.id };
    const p = position(edge, Math.max(0, d)), lateral = laneOffset(edge, car.lane || 0) * factor;
    return { x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, angle: Math.atan2(p.dy, p.dx),
        length: car.length, width: car.width * factor, layer: road.layer,
        kind: car.type === 'bicycle' ? 'cyclist' : 'traffic', car, ownerId: car.id };
}
function collision(body, obstacles) {
    return obstacles.find(other => other && Math.hypot(body.x - other.x, body.y - other.y) <
        (body.length + body.width + other.length + other.width) / 2 + 1 &&
        orientedBodiesOverlap(body, other, other.kind === 'building' ? 0.03 : 0.25));
}
function obstaclesForMove(town, size) {
    return [...fireEngineObstacles(town, size), ...(town.simulation.cars || []).map(car => carBody(town, car, size))];
}

function movementPose(town, engine, x, y, angle, size) {
    const next = { ...engine, x, y, angle }, body = renderedBody(next, size);
    next.road = nearestRoad(town, body, engine.road); next.layer = next.road.layer;
    body.road = next.road; body.layer = next.layer; body.width = next.width * styleFactor(next.road, size);
    return { next, body };
}
function edgeSlide(town, engine, speed, h, size, obstacles) {
    let guide = null, distance = Infinity;
    for (const s of nearby(geometry(town).grid, engine)) {
        if (s.road !== engine.road) continue;
        const d = projection(engine, s).distance;
        if (d < distance) { distance = d; guide = s; }
    }
    if (!guide || !guide.square) return null;
    let tangent = Math.atan2(guide.dy, guide.dx);
    if (Math.cos(tangent - engine.angle) < 0) tangent += Math.PI;
    const alignment = Math.cos(tangent - engine.angle);
    // Only help a truck already travelling along a verge. A nose aimed at
    // grass, water, a building or a closed end must still stop normally.
    if (alignment < 0.82) return null;
    const slipSpeed = Math.sign(speed) * Math.min(5, Math.abs(speed)) * alignment;
    const angle = engine.angle + clamp(angleDifference(tangent, engine.angle), -0.65 * h, 0.65 * h);
    const candidate = movementPose(town, engine, engine.x + Math.cos(tangent) * slipSpeed * h,
        engine.y + Math.sin(tangent) * slipSpeed * h, angle, size);
    if (collision(candidate.body, obstacles) || !bodyOnSurface(town, candidate.body, size, engine.road)) return null;
    return { ...candidate, speed: slipSpeed };
}

/** Start on the real Common Lane fire station's paved apron, facing its road
 * exit. Busy access remains a reason to wait rather than moving other actors. */
export function startFireEngine(town, { widthFactor = town.walking?.widthFactor || 3 } = {}) {
    const station = stationFor(town), obstacles = obstaclesForMove(town, widthFactor);
    for (const candidate of station?.spawnCandidates || []) {
        const engine = { ...candidate, active: true, speed: 0, length: 9, width: 2.5, siren: true,
            distance: 0, blocked: '', widthFactor, steering: 0, braking: false, time: 0 };
        engine.pose = renderedBody(engine, widthFactor);
        if (!bodyOnSurface(town, engine.pose, widthFactor) || collision(engine.pose, obstacles)) continue;
        engine.previous = { ...engine.pose };
        town.fireEngine = engine;
        town.simulation.emergency?.setPlayer(engine.pose);
        return engine;
    }
    town.fireEngine = { active: false, blocked: station ? 'The station forecourt is busy — try again shortly' :
        'The fire station access is unavailable', speed: 0, siren: false };
    town.simulation.emergency?.setPlayer(null);
    return null;
}
export function stopFireEngine(town) {
    if (town.fireEngine) { town.fireEngine.active = false; town.fireEngine.speed = 0; town.fireEngine.siren = false; }
    town.simulation.emergency?.setPlayer(null);
}

export function updateFireEngine(town, dt, input = {}, widthFactor = town.fireEngine?.widthFactor || 3) {
    const engine = town.fireEngine;
    if (!engine?.active || !(dt > 0) || !Number.isFinite(dt)) return;
    engine.previous = { ...engine.pose };
    const throttle = clamp(Number(input.throttle) || 0, -1, 1), steer = clamp(Number(input.steer) || 0, -1, 1);
    engine.braking = Boolean(input.brake) || throttle && Math.sign(throttle) !== Math.sign(engine.speed) && Math.abs(engine.speed) > 0.3;
    engine.blocked = '';
    engine.edgeAssist = false;
    const obstacles = obstaclesForMove(town, widthFactor);
    // At 80 mph each swept step travels at most 36 cm. Check rotation too,
    // preserving small-obstacle protection and the same motion at 1× and 8×.
    const steps = Math.max(1, Math.ceil(Math.min(dt, 1) / DRIVE_STEP_SECONDS)), h = Math.min(dt, 1) / steps;
    for (let i = 0; i < steps; i++) {
        engine.time += h;
        // Generous steering lock helps parking-speed village corners; limiting
        // lock as speed rises prevents a held arrow making a sudden tight spin.
        const steeringTarget = steer * (0.78 / (1 + (Math.abs(engine.speed) / 7) ** 2));
        engine.steering += clamp(steeringTarget - engine.steering, -2.2 * h, 2.2 * h);
        let speed = engine.speed;
        if (engine.braking) speed = Math.sign(speed) * Math.max(0, Math.abs(speed) - 7 * h);
        else if (throttle) speed = clamp(speed + throttle * (throttle > 0 ? 3.4 : 2.5) * h, -3.5, FIRE_ENGINE_MAX_SPEED_MPS);
        else speed = Math.sign(speed) * Math.max(0, Math.abs(speed) - (0.7 + Math.abs(speed) * 0.06) * h);
        if (Math.abs(speed) < 1e-9) speed = 0;
        const turn = speed / 5.7 * Math.tan(engine.steering) * h;
        const angle = engine.angle + turn, middle = engine.angle + turn / 2;
        let { next, body } = movementPose(town, engine, engine.x + Math.cos(middle) * speed * h,
            engine.y + Math.sin(middle) * speed * h, angle, widthFactor);
        let obstruction = collision(body, obstacles);
        let paved = bodyOnSurface(town, body, widthFactor, engine.road);
        if (paved && obstruction?.kind === 'traffic' && obstruction.car && throttle &&
            town.simulation.emergency?.tryNudge) {
            const force = Math.min(8, Math.abs(speed) + Math.abs(throttle) * 0.8);
            if (town.simulation.emergency.tryNudge(obstruction.car, body, force)) {
                const freshImpact = engine.bumpId !== obstruction.car.id || engine.time - (engine.bumpTime ?? -Infinity) > 0.6;
                engine.bumpId = obstruction.car.id; engine.bumpTime = engine.time;
                engine.bumpKind = obstruction.car.type || 'car'; engine.bumpStrength = force;
                if (freshImpact) { engine.bumpCount = (engine.bumpCount || 0) + 1; speed *= 0.82; }
                Object.assign(obstruction, carBody(town, obstruction.car, widthFactor));
                obstruction = collision(body, obstacles);
            }
        }
        if ((!paved || obstruction?.kind === 'building') && (!obstruction || obstruction.kind === 'building') && Math.abs(speed) > 0.05) {
            const slide = edgeSlide(town, engine, speed, h, widthFactor, obstacles);
            if (slide) {
                next = slide.next; body = slide.body; speed = slide.speed; paved = true; obstruction = null;
                engine.edgeAssist = true;
            }
        }
        if (!paved || obstruction) {
            engine.speed = 0;
            engine.blocked = obstruction ? obstruction.kind === 'pedestrian' ? 'Waiting for people to cross' :
                obstruction.kind?.includes('manoeuvre') || obstruction.kind?.includes('turning') || obstruction.kind?.includes('overtaking') ? 'Waiting for a car to finish manoeuvring' : 'Waiting for a clear gap' : 'Stay on the road or pavement';
            engine.time += (steps - i - 1) * h;
            break;
        }
        engine.distance += Math.hypot(next.x - engine.x, next.y - engine.y);
        engine.x = next.x; engine.y = next.y; engine.angle = next.angle;
        engine.road = next.road; engine.layer = next.layer; engine.speed = speed;
        engine.pose = body;
    }
    engine.pose = { ...renderedBody(engine, widthFactor), siren: engine.siren, speed: engine.speed, active: true };
    engine.widthFactor = widthFactor;
    town.simulation.emergency?.setPlayer(engine.pose);
}

export function fireEnginePose(town, alpha = 1) {
    const engine = town.fireEngine;
    if (!engine?.active) return { visible: false };
    const p = engine.pose, previous = engine.previous || p, t = clamp(alpha, 0, 1);
    // Layer ownership stays authoritative during a bridge portal transition.
    return { ...p, x: previous.x + (p.x - previous.x) * t, y: previous.y + (p.y - previous.y) * t,
        angle: previous.angle + angleDifference(p.angle, previous.angle) * t,
        siren: engine.siren, speed: engine.speed, visible: true };
}
