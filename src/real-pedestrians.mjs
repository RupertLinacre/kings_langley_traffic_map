import { measure, pathPoint } from './street-geometry.mjs';
import { rounded, circle, line } from './miniature-art.mjs';
import { orientedBodiesOverlap } from './body-geometry.mjs';
import { groupPose } from './purposeful-journeys.mjs';

const COLOURS = ['#c66a52', '#478994', '#d5a23f', '#775e87', '#577553', '#436387'];
const ALLOWED = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const TAU = Math.PI * 2;
const HALF_CROSSING = 3.5;
const GAP_MARGIN = 1.4;
const WAIT_BEFORE_CENTRE = 2;
const GAP_ROADS = new Set(['tertiary', 'residential', 'unclassified', 'living_street']);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pavement = (road, width) => road.baseWidth * Math.min(width * road.size, road.widthCap || Infinity) / 2 + 1.5;
const randomSource = seed => () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
function permitted(road) {
    const t = road.tags;
    return ALLOWED.has(t.highway) && t.foot !== 'no' && t.access !== 'private' && t.access !== 'no' &&
        t.sidewalk !== 'no' && t.sidewalk !== 'separate' && t.junction !== 'roundabout';
}
function measured(points) {
    return measure(points.map(([x, y], i) => {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        return { x, y, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }));
}
function curbPoint(section, side, distance, width) {
    const p = pathPoint(section.path, distance);
    let outward = pavement(section.road, width);
    const parked = section.kerbParking;
    if (parked?.side === side && parked.zone.baseline + parked.zone.parked.size > 0) {
        // Follow the outside of the pavement-parked row, easing out before its
        // first bumper, without changing the surveyed route or crossing rules.
        const ramp = clamp(Math.min(distance - parked.start + 10, parked.end - distance + 10) / 10, 0, 1);
        const ease = ramp * ramp * (3 - 2 * ramp);
        const factor = Math.min(width * section.road.size, section.road.widthCap || Infinity);
        const outsideCars = (parked.zone.parkingOffset + 0.9) * factor + 1.7;
        outward += Math.max(0, outsideCars - outward) * ease;
    }
    const offset = outward * side;
    return { x: p.x + Math.sin(p.angle) * offset, y: p.y - Math.cos(p.angle) * offset, angle: p.angle,
        road: section.road, layer: section.road.layer };
}
function nodePoint(node, width) { return curbPoint(node.section, node.side, node.distance, width); }
function closestDistance(point, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = clamp(((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(point.x - a[0] - t * dx, point.y - a[1] - t * dy);
}
function connector(link, width, t) {
    const a = nodePoint(link.from, width), b = nodePoint(link.to, width);
    if (link.straight) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x), road: a.road, layer: a.layer };
    const u = { x: Math.cos(a.angle), y: Math.sin(a.angle) }, v = { x: Math.cos(b.angle), y: Math.sin(b.angle) };
    const determinant = u.x * v.y - u.y * v.x;
    let control = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (Math.abs(determinant) > 0.01) {
        const k = ((b.x - a.x) * v.y - (b.y - a.y) * v.x) / determinant;
        const candidate = { x: a.x + k * u.x, y: a.y + k * u.y };
        if (Math.hypot(candidate.x - control.x, candidate.y - control.y) < 65) control = candidate;
    }
    const q = 1 - t, dx = 2 * (q * (control.x - a.x) + t * (b.x - control.x));
    const dy = 2 * (q * (control.y - a.y) + t * (b.y - control.y));
    return { x: q * q * a.x + 2 * q * t * control.x + t * t * b.x,
        y: q * q * a.y + 2 * q * t * control.y + t * t * b.y, angle: Math.atan2(dy, dx), road: a.road, layer: a.layer };
}
function linkPoint(link, progress, width) {
    const t = clamp(progress, 0, 1);
    if (link.type === 'walk') {
        const p = curbPoint(link.from.section, link.from.side, link.from.distance + (link.to.distance - link.from.distance) * t, width);
        if (link.to.distance < link.from.distance) p.angle += Math.PI;
        return p;
    }
    if (link.type === 'corner') return connector(link, width, t);
    const a = nodePoint(link.from, width), b = nodePoint(link.to, width);
    return { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** Only actors that have actually left their ordinary traffic lane (or own a
 * recovery sweep) protect future pavement steps. Normal road traffic continues
 * to use zebra/gap-crossing decisions rather than blocking the whole pavement. */
export function pedestrianTrafficBodies(town) {
    const sim = town.simulation, bodies = [];
    if (town.fireEngine?.active && town.fireEngine.pose) bodies.push(town.fireEngine.pose);
    for (const controller of [sim?.cooperative, sim?.emergency]) {
        if (!controller) continue;
        if (controller.blockingBodies) { bodies.push(...controller.blockingBodies()); continue; }
        for (const [id, state] of controller.states || []) {
            if (controller === sim.emergency && Math.abs(state.offset || 0) <= 0.02 && !state.reverse) continue;
            const car = controller.owners?.get(id) || state.car || sim.cars?.find(car => car.id === id);
            if (!car || !sim.cars?.includes(car)) continue;
            const body = sim.emergency?.body?.(car);
            if (body) bodies.push(body);
        }
        bodies.push(...(controller.reservedBodies?.() || []));
    }
    return bodies;
}
export function hasPedestrianTrafficBodies(town) {
    return Boolean(town.fireEngine?.active || town.simulation?.cooperative?.states?.size || town.simulation?.emergency?.states?.size);
}

/** Test a short pedestrian sweep against the current player and displaced
 * traffic/recovery pockets. Dimensions match the visible adult/child artwork;
 * every traffic body already includes its illustrated width and bridge layer. */
export function pedestrianMotionBlocked(town, from, to, { length = 2.6, width = 2.1, blockers = pedestrianTrafficBodies(town) } = {}) {
    if (!blockers.length || to?.visible === false || !to || ![to.x, to.y].every(Number.isFinite)) return false;
    const start = from?.visible === false || !from ? to : from;
    const relevant = blockers.filter(body => (body.layer ?? body.road?.layer ?? 0) === (to.layer ?? 0) &&
        [body.x, body.y, body.length, body.width].every(Number.isFinite));
    if (!relevant.length) return false;
    const distance = Math.hypot(to.x - start.x, to.y - start.y);
    const count = Math.max(1, Math.ceil(distance / 0.4));
    const turn = Math.atan2(Math.sin((to.angle || 0) - (start.angle || 0)), Math.cos((to.angle || 0) - (start.angle || 0)));
    for (let i = 0; i <= count; i++) {
        const t = i / count;
        const candidate = { x: start.x + (to.x - start.x) * t,
            y: start.y + (to.y - start.y) * t, angle: (start.angle || 0) + turn * t,
            length, width, layer: to.layer ?? 0 };
        if (relevant.some(body => orientedBodiesOverlap(body, candidate, 0.25))) return true;
    }
    return false;
}

function walkingBodies(town, person, progress) {
    const sample = { ...person, progress }, width = town.walking.widthFactor;
    const group = town.purposefulJourneys?.groups.find(item => item.walker === person);
    if (!group) return [{ ...pedestrianPose(town, sample, width), length: 2.6, width: 2.1 }];
    // The family artwork follows a wider pavement route around parked cars.
    // Use that real visible formation rather than the unshifted controller.
    const pose = groupPose(town, { ...group, walker: sample }, width, 1);
    if (!pose.visible) return [];
    const link = sample.route?.[sample.index];
    const distance = link?.type === 'walk' ? link.from.distance + (link.to.distance - link.from.distance) * progress : sample.node.distance;
    const angle = pathPoint(group.walk.section.path, distance).angle, side = group.walk.side;
    return group.members.map((member, index) => ({ ...pose,
        x: pose.x + Math.sin(angle) * side * index * 2.15,
        y: pose.y - Math.cos(angle) * side * index * 2.15,
        length: member.role === 'child' ? 2 : 2.6, width: member.role === 'child' ? 1.6 : 2.1 }));
}

function blockedProgress(town, person, link, target) {
    if (!hasPedestrianTrafficBodies(town)) return false;
    const blockers = pedestrianTrafficBodies(town);
    if (!blockers.length) return false;
    // Sample curved corners as well as long caller timesteps. Each following
    // short swept segment is checked with the shared oriented-body test.
    const count = Math.max(1, Math.ceil(Math.abs(target - person.progress) * link.length / 0.4));
    let previous = walkingBodies(town, person, person.progress);
    for (let i = 1; i <= count; i++) {
        const progress = person.progress + (target - person.progress) * i / count;
        const next = walkingBodies(town, person, progress);
        if (next.some((body, index) => pedestrianMotionBlocked(town, previous[index] || body, body, { ...body, blockers }))) {
            person.trafficWaiting = true;
            person.fireEngineWaiting = Boolean(town.fireEngine?.active);
            return true;
        }
        previous = next;
    }
    return false;
}
function prepareWalking(map, parking) {
    const sections = [], byPhysical = new Map(), armsByNode = new Map(), nodes = [], links = [], crossings = [];
    for (const edge of map.data.edges) {
        const key = `${edge.way}:${Math.min(edge.from, edge.to)}:${Math.max(edge.from, edge.to)}`;
        let section = byPhysical.get(key);
        if (section) { section.edges.push(edge); continue; }
        const road = map.roadById.get(edge.way);
        section = { id: sections.length, road, edge, edges: [edge], path: measured(edge.points), allowed: permitted(road), ends: [] };
        const parked = parking?.byEdge.get(edge.id);
        if (parked?.zone?.localObservation) {
            const display = parked.zone.displays.find(part => part.edge.id === edge.id ||
                part.edge.from === edge.to && part.edge.to === edge.from);
            if (display) section.kerbParking = { ...parked,
                side: parked.zone.parkingSide * (display.edge.from === edge.from ? 1 : -1) };
        }
        sections.push(section); byPhysical.set(key, section);
        for (const [nodeId, end] of [[edge.from, 0], [edge.to, 1]]) {
            const p = pathPoint(section.path, end ? section.path.length : 0);
            const arm = { section, nodeId, end, angle: (p.angle + (end ? Math.PI : 0) + TAU) % TAU };
            if (!armsByNode.has(nodeId)) armsByNode.set(nodeId, []);
            armsByNode.get(nodeId).push(arm); section.ends.push(arm);
        }
    }
    function addNode(section, side, distance) {
        const node = { id: nodes.length, section, side, distance, links: [] };
        nodes.push(node); return node;
    }
    function join(from, to, type, extra = {}) {
        const link = { from, to, type, ...extra };
        const back = { ...link, from: to, to: from };
        const a = nodePoint(from, 2.5), b = nodePoint(to, 2.5);
        link.length = type === 'walk' ? Math.abs(to.distance - from.distance) : Math.hypot(b.x - a.x, b.y - a.y);
        link.length = Math.max(0.01, link.length); back.length = link.length;
        from.links.push(link); to.links.push(back); links.push(link);
        return link;
    }
    // Short shape/crossing edges remain usable. At actual junctions we stop the
    // pavement before the widened carriageways meet, then join outer corners.
    for (const section of sections) {
        if (!section.allowed) continue;
        let viable = true;
        for (const arm of section.ends) {
            const arms = armsByNode.get(arm.nodeId), other = arms.find(a => a !== arm);
            const bend = arms.length === 2 ? Math.abs(Math.atan2(Math.sin(other.angle - arm.angle - Math.PI), Math.cos(other.angle - arm.angle - Math.PI))) : Math.PI;
            arm.straight = arms.length === 2 && bend < 0.22 && arms.every(a => a.section.allowed && a.section.road.layer === section.road.layer);
            arm.trim = arm.straight ? 0 : Math.max(...arms.map(a => pavement(a.section.road, 4))) + 4;
            if (arm.trim > section.path.length * 0.45) viable = false;
        }
        if (!viable) continue;
        const start = section.ends[0].trim, finish = section.path.length - section.ends[1].trim;
        section.sides = new Map();
        for (const side of [-1, 1]) {
            const waySide = section.edge.forward ? side : -side;
            const name = waySide === 1 ? 'left' : 'right';
            if (section.road.tags[`sidewalk:${name}`] === 'no' || section.road.tags.sidewalk === (name === 'left' ? 'right' : 'left')) continue;
            section.sides.set(side, [addNode(section, side, start), addNode(section, side, (start + finish) / 2), addNode(section, side, finish)]);
        }
        // Marked crossings retain their yielding rules. Elsewhere, occasional
        // walkers use gaps on slow two-way roads, without creating a zebra.
        const zebra = finish - start > 125 && (section.id % 7 === 0 || section.road.tags.name === 'High Street');
        const gap = finish - start > 80 && section.id % 2 === 0 && GAP_ROADS.has(section.road.tags.highway) &&
            section.edges.some(e => e.from !== section.edge.from) && Number(section.road.tags.lanes || 2) <= 2 &&
            !['yes', '1', 'true', '-1'].includes(section.road.tags.oneway);
        if (section.sides.size === 2 && section.edge.speed <= 14 && !section.road.layer && !section.road.tags.bridge &&
            !section.road.tags.tunnel && (zebra || gap)) {
            const distance = (start + finish) / 2, p = pathPoint(section.path, distance);
            const nearContext = map.context.some(item => item.layer === section.road.layer && item.points.some((b, i) => i && closestDistance(p, item.points[i - 1], b) < 25));
            const nearJunction = [...armsByNode].some(([id, arms]) => arms.length > 2 && Math.hypot(map.data.nodes[id].p[0] - p.x, map.data.nodes[id].p[1] - p.y) < 40);
            const nearParking = section.edges.some(edge => {
                const segment = parking?.byEdge.get(edge.id), d = edge.from === section.edge.from ? distance : section.path.length - distance;
                return segment && d > segment.start - 8 && d < segment.end + 8;
            });
            if (!nearContext && !nearJunction && !nearParking) {
                const crossing = { id: crossings.length, kind: zebra ? 'zebra' : 'gap', section, distance, point: p,
                    users: new Set(), exempt: new Set(), occupiedEdges: new Set(), edgeDistances: new Map() };
                for (const edge of section.edges) crossing.edgeDistances.set(edge.id, edge.from === section.edge.from ? distance : section.path.length - distance);
                join(section.sides.get(-1)[1], section.sides.get(1)[1], 'crossing', { crossing });
                crossings.push(crossing);
            }
        }
        for (const points of section.sides.values()) for (let i = 1; i < points.length; i++) join(points[i - 1], points[i], 'walk');
    }
    for (const [nodeId, unsorted] of armsByNode) {
        const arms = [...unsorted].sort((a, b) => a.angle - b.angle);
        if (arms.length < 2) continue;
        for (let i = 0; i < arms.length; i++) {
            const a = arms[i], b = arms[(i + 1) % arms.length];
            if (!a.section.sides || !b.section.sides || a.section.road.layer !== b.section.road.layer) continue;
            const sideA = a.end ? 1 : -1, sideB = b.end ? -1 : 1;
            const from = a.section.sides.get(sideA)?.[a.end ? 2 : 0], to = b.section.sides.get(sideB)?.[b.end ? 2 : 0];
            if (!from || !to) continue;
            const candidate = { type: 'corner', from, to, straight: a.straight && b.straight };
            // An adjacent pair shares the outside pavement. Check the complete
            // curve against every street arm at both supported width extremes.
            let safe = true;
            if (!candidate.straight) for (const width of [1.5, 4]) for (let j = 0; j <= 12; j++) {
                const p = connector(candidate, width, j / 12);
                if (arms.some(arm => {
                    const e = arm.section.edge, start = map.data.nodes[nodeId].p;
                    const end = arm.end ? e.points.at(-2) : e.points[1];
                    return closestDistance(p, start, end) < pavement(arm.section.road, width) - 1.6;
                })) safe = false;
                if (map.context.some(item => item.layer === a.section.road.layer && item.points.some((end, k) => k && closestDistance(p, item.points[k - 1], end) < (item.tags.waterway ? 6 : 2.5)))) safe = false;
            }
            if (safe) join(from, to, 'corner', { straight: candidate.straight });
        }
    }
    const components = [];
    for (const node of nodes) {
        if (node.component !== undefined) continue;
        const component = [], pending = [node], index = components.length;
        node.component = index;
        while (pending.length) {
            const current = pending.pop(); component.push(current);
            for (const link of current.links) if (link.to.component === undefined) { link.to.component = index; pending.push(link.to); }
        }
        components.push(component);
    }
    const crossingsByEdge = new Map();
    for (const crossing of crossings) for (const edgeId of crossing.edgeDistances.keys()) {
        if (!crossingsByEdge.has(edgeId)) crossingsByEdge.set(edgeId, []);
        crossingsByEdge.get(edgeId).push(crossing);
    }
    return { sections, nodes, links, crossings, crossingsByEdge, components, destinations: nodes.filter(n => n.distance > n.section.ends[0].trim + 0.01 && n.distance < n.section.path.length - n.section.ends[1].trim - 0.01) };
}

export function createPedestrians(town, seed = town.seed) {
    town.people = [];
    town.walking = { ...prepareWalking(town.map, town.simulation.parking), random: randomSource((seed || 42) ^ 0x70656f70), nextId: 0, time: 0, widthFactor: 2.5, linked: new Set() };
    return town.walking;
}
function planJourney(town, person) {
    const walking = town.walking, start = person.node, candidates = walking.components[start.component].filter(n => n !== start && n.distance > n.section.ends[0].trim && n.distance < n.section.path.length - n.section.ends[1].trim);
    const destination = candidates[Math.floor(walking.random() * candidates.length)] || start.links[0]?.to;
    if (!destination) return false;
    const queue = [start], previous = new Map([[start, null]]);
    for (let i = 0; i < queue.length && !previous.has(destination); i++) {
        const node = queue[i];
        for (const link of node.links) if (!previous.has(link.to)) { previous.set(link.to, link); queue.push(link.to); }
    }
    const route = []; let at = destination;
    while (at !== start) { const link = previous.get(at); if (!link) return false; route.unshift(link); at = link.from; }
    person.route = route; person.index = 0; person.progress = 0; person.destination = destination;
    return !!route.length;
}
export function setPedestrianCount(town, count) {
    if (!town.walking) createPedestrians(town);
    count = clamp(Math.round(Number(count) || 0), 0, 400);
    const w = town.walking;
    town.people = town.people.slice(0, count);
    const alive = new Set([...town.people, ...w.linked]);
    for (const crossing of w.crossings) {
        for (const person of crossing.users) if (!alive.has(person)) crossing.users.delete(person);
        crossing.occupiedEdges = new Set([...crossing.users].flatMap(p => [...(p.crossingLanes || [])]));
        if (!crossing.users.size) crossing.exempt.clear();
    }
    if (!w.destinations.length) return;
    while (town.people.length < count) {
        const id = w.nextId++, node = w.destinations[Math.floor(w.random() * w.destinations.length)];
        const person = { id, node, colour: COLOURS[id % COLOURS.length], speed: 1.15 + w.random() * 0.65, pause: 0,
            state: 'walking', activity: 'Walking along the pavement', trips: 0 };
        planJourney(town, person);
        // Spread arrivals along the first pavement leg instead of stacking them
        // all at the same waypoint when a count control is increased.
        if (person.route[0]?.type === 'walk') person.progress = w.random() * 0.9;
        town.people.push(person);
    }
}
function distanceToCrossing(car, crossing, edgeId) {
    let best = Infinity;
    for (let i = Math.max(0, car.index - 4); i < Math.min(car.route.length, car.index + 12); i++) {
        if (edgeId !== undefined && car.route[i] !== edgeId) continue;
        const distance = crossing.edgeDistances.get(car.route[i]);
        if (distance === undefined) continue;
        const delta = car.offsets[i] + distance - car.q;
        if (delta >= -car.length - HALF_CROSSING - 3) best = Math.min(best, delta);
    }
    return best;
}
function requestCrossing(town, person, crossing) {
    if (crossing.kind === 'gap') {
        crossing.users.add(person); person.crossing = crossing; person.crossingLane = null;
        person.crossingLanes = new Set(); person.gapStage = 'near';
        person.state = 'gap_wait'; person.activity = 'Looking both ways for a gap';
        return;
    }
    if (!crossing.users.size) {
        crossing.exempt.clear();
        for (const car of town.simulation.cars) {
            if (car.parked) continue;
            const d = distanceToCrossing(car, crossing) - HALF_CROSSING - 2;
            if (d < car.v * car.v / 6 + car.v * 0.3 + 2) crossing.exempt.add(car.id);
        }
    }
    crossing.users.add(person); person.crossing = crossing; person.state = 'crossing_wait'; person.activity = 'Waiting at a zebra crossing';
}

function laneEdges(link) {
    const section = link.crossing.section;
    const same = section.edges.find(e => e.from === section.edge.from).id;
    const opposite = section.edges.find(e => e.from !== section.edge.from)?.id;
    // Positive pavement offset is the driver's left. UK vehicles pass on the
    // same side as walkers beginning on the left of this surveyed direction.
    return link.from.side === 1 ? [same, opposite] : [opposite, same];
}

function gapGeometry(link, width) {
    const road = link.from.section.road, curb = pavement(road, width);
    const factor = Math.min(width * road.size, road.widthCap || Infinity);
    return {
        curb, length: curb * 2, waitProgress: (curb - WAIT_BEFORE_CENTRE) / (curb * 2),
        // The largest normal body is a 2.5m bus. Include the walking sprite's
        // trailing feet (2.675m) and a little clearance before releasing cars.
        nearClearProgress: (curb + Math.max(0, 3.1 - (1.55 - 2.5 / 2) * factor)) / (curb * 2),
    };
}
function gapInLane(town, crossing, edgeId, person, distanceToWalk) {
    if (edgeId === undefined) return { clear: false, queued: false };
    const crossingTime = (distanceToWalk ?? pavement(crossing.section.road, town.walking.widthFactor)) / person.speed;
    let queued = false;
    for (const car of town.simulation.cars) {
        if (car.parked) continue;
        const distance = distanceToCrossing(car, crossing, edgeId);
        if (!Number.isFinite(distance)) continue;
        // q marks the front bumper: a stopped bonnet just beyond a crossing
        // still leaves the body across it. Only a real space between cars fits.
        if (distance > -car.length - GAP_MARGIN && distance < GAP_MARGIN) return { clear: false, queued };
        if (car.turnaround && Math.abs(distance) < 30) return { clear: false, queued };
        if (distance < 0) continue;
        if (car.v < 0.35) { queued ||= distance < 45; continue; }
        // The person must clear this entire half before an approaching driver
        // arrives, including a small margin and possible acceleration.
        const time = crossingTime + 1.2, acceleration = Math.min(1, Math.max(0, car.a || 0));
        if (distance < GAP_MARGIN + car.v * time + 0.5 * acceleration * time * time) return { clear: false, queued };
    }
    return { clear: true, queued };
}

function occupyLane(person, edgeId) {
    person.crossingLane = edgeId;
    person.crossingLanes.add(edgeId);
    person.crossing.occupiedEdges.add(edgeId);
}
function releaseLane(person, onlyEdge) {
    const crossing = person.crossing;
    for (const edgeId of [...(person.crossingLanes || [])]) {
        if (onlyEdge !== undefined && onlyEdge !== edgeId) continue;
        person.crossingLanes.delete(edgeId);
        if (![...crossing.users].some(p => p !== person && p.crossingLanes?.has(edgeId))) crossing.occupiedEdges.delete(edgeId);
    }
    if (onlyEdge === undefined || person.crossingLane === onlyEdge) person.crossingLane = null;
}

function advanceGapCrossing(town, person, link, remaining) {
    const [near, far] = laneEdges(link), crossing = link.crossing;
    const geometry = gapGeometry(link, town.walking.widthFactor);
    if (person.state === 'gap_wait') {
        const first = gapInLane(town, crossing, near, person, geometry.curb - WAIT_BEFORE_CENTRE);
        const second = gapInLane(town, crossing, far, person, geometry.length);
        person.gapChecks = { nearClear: first.clear, farClear: second.clear, queued: first.queued };
        if (!first.clear) return { remaining: 0, complete: false };
        occupyLane(person, near); person.state = 'gap_crossing';
        person.activity = first.queued ? 'Walking through a gap in the queue' : 'Crossing in a gap between vehicles';
    }
    if (person.state === 'gap_middle_wait') {
        // Remain inside the held near lane, clear of a passing bus's swept body.
        // Recompute the stop point if the user changes the illustrated width.
        person.progress = geometry.waitProgress;
        if (!gapInLane(town, crossing, far, person, geometry.curb + WAIT_BEFORE_CENTRE).clear) return { remaining: 0, complete: false };
        occupyLane(person, far); person.gapStage = 'far'; person.state = 'gap_crossing'; person.activity = 'The other lane is clear — crossing';
    }
    const target = person.gapStage === 'near' ? geometry.waitProgress : 1;
    const required = Math.max(0, target - person.progress) * geometry.length / person.speed;
    const nextProgress = Math.min(target, person.progress + remaining * person.speed / geometry.length);
    if (blockedProgress(town, person, link, nextProgress)) return { remaining: 0, complete: false };
    if (remaining < required) {
        person.progress += remaining * person.speed / geometry.length;
        if (person.gapStage === 'far' && person.progress >= geometry.nearClearProgress) releaseLane(person, near);
        return { remaining: 0, complete: false };
    }
    person.progress = target; remaining -= required;
    if (person.gapStage === 'near') {
        person.state = 'gap_middle_wait'; person.activity = 'Waiting for the other lane to clear';
        return { remaining, complete: false };
    }
    releaseLane(person);
    return { remaining, complete: true };
}
function canEnter(town, crossing) {
    for (const car of town.simulation.cars) {
        if (car.parked) continue;
        const distance = distanceToCrossing(car, crossing);
        if (distance === Infinity) continue;
        if (crossing.exempt.has(car.id) || distance < HALF_CROSSING + 1 || distance < 100 && car.v > 0.4) return false;
    }
    return true;
}
export function pedestrianTrafficLimit(town, car, edge) {
    let limit = Infinity;
    for (const crossing of town.walking?.crossingsByEdge?.get(edge.id) || []) {
        const d = crossing.edgeDistances.get(edge.id);
        if (!crossing.users.size || d === undefined || crossing.exempt.has(car.id)) continue;
        if (crossing.kind === 'gap' && !crossing.occupiedEdges.has(edge.id)) continue;
        const current = car.route[car.index] === edge.id;
        if (current && car.d - car.length > d + (crossing.kind === 'gap' ? GAP_MARGIN : HALF_CROSSING + 2)) continue;
        // The engine's q and this limit both refer to the front bumper.
        limit = Math.min(limit, d - (crossing.kind === 'gap' ? GAP_MARGIN + 1 : HALF_CROSSING + 2));
    }
    return limit;
}
// Count changes and replenishment must not materialise a new vehicle inside a
// crossing that pedestrians have already reserved. Existing traffic can brake
// or be exempted; a new vehicle has neither of those guarantees.
export function pedestrianSpawnAllowed(town, car) {
    for (const crossing of town.walking?.crossings || []) {
        if (!crossing.users.size) continue;
        const distance = crossing.kind === 'gap'
            ? Math.min(...[...crossing.occupiedEdges].map(id => distanceToCrossing(car, crossing, id)))
            : distanceToCrossing(car, crossing);
        const speed = car.v || 0;
        if (distance < HALF_CROSSING + 4 + speed * speed / 6 + speed * 0.5) return false;
    }
    return true;
}
export function updatePedestrians(town, dt) {
    if (!(dt > 0) || !town.walking) return;
    const w = town.walking; w.time += dt;
    const ready = new Map(w.crossings.filter(c => c.kind !== 'gap' && c.users.size).map(c => [c, canEnter(town, c)]));
    for (const person of town.people) {
        person.fireEngineWaiting = false;
        person.trafficWaiting = false;
        if (person.pause > 0) { person.pause = Math.max(0, person.pause - dt); continue; }
        let remaining = dt;
        for (let step = 0; step < 24 && remaining > 0; step++) {
            let link = person.route?.[person.index];
            if (!link) {
                if (!planJourney(town, person)) break;
                link = person.route[0];
            }
            if (link.type === 'crossing' && !person.crossing) { requestCrossing(town, person, link.crossing); break; }
            if (link.crossing?.kind === 'gap') {
                const result = advanceGapCrossing(town, person, link, remaining);
                remaining = result.remaining;
                if (!result.complete) {
                    if (remaining > 0) continue;
                    break;
                }
            } else {
                if (person.state === 'crossing_wait') {
                    if (!ready.get(person.crossing)) break;
                    person.state = 'crossing'; person.activity = 'Crossing at the zebra';
                }
                const length = link.type === 'crossing' ? pavement(link.from.section.road, w.widthFactor) * 2 : link.length;
                const required = (1 - person.progress) * length / person.speed;
                if (blockedProgress(town, person, link, Math.min(1, person.progress + remaining * person.speed / length))) break;
                if (remaining < required) { person.progress += remaining * person.speed / length; break; }
                remaining -= required;
            }
            person.node = link.to; person.index++; person.progress = 0;
            if (person.crossing) {
                releaseLane(person);
                person.crossing.users.delete(person);
                if (!person.crossing.users.size) person.crossing.exempt.clear();
                person.crossing = null; person.state = 'walking'; person.activity = 'Walking along the pavement';
            }
            if (person.index >= person.route.length) {
                person.trips++; person.pause = 1 + w.random() * 5; person.state = 'walking'; break;
            }
        }
    }
}
export function pedestrianPose(town, person, widthFactor = 2.5) {
    const link = person.route?.[person.index];
    const progress = person.state === 'gap_middle_wait' && link?.crossing?.kind === 'gap'
        ? gapGeometry(link, widthFactor).waitProgress : person.progress;
    return link ? linkPoint(link, progress, widthFactor) : nodePoint(person.node, widthFactor);
}

/** A waypoint on an existing permitted pavement, clamped before its junction
 * trim. Reversed road edges retain the physical pavement side. */
export function pavementWaypoint(town, edgeId, distance, side = 1) {
    const section = town.walking?.sections.find(item => item.edges.some(edge => edge.id === edgeId));
    if (!section?.sides?.has(side)) return null;
    const edge = town.map.data.edges[edgeId];
    const points = section.sides.get(side);
    const d = edge.from === section.edge.from ? distance : section.path.length - distance;
    return { id: `pavement:${edgeId}:${d}:${side}`, section, side,
        distance: clamp(d, points[0].distance, points.at(-1).distance), component: points[0].component,
        links: points.map(to => ({ type: 'walk', from: null, to, length: Math.abs(to.distance - d) })) };
}

/** Explicit shortest pavement journey. Additional waypoints connect only to
 * their own pavement; all corners and crossings use the existing safe graph. */
export function planPavementRoute(town, from, to) {
    if (!from || !to || from.component !== to.component) return null;
    const walk = (a, b) => ({ type: 'walk', from: a, to: b, length: Math.max(0.01, Math.abs(a.distance - b.distance)) });
    if (from.section === to.section && from.side === to.side) return [walk(from, to)];
    const distances = new Map([[from, 0]]), previous = new Map(), queue = [from];
    while (queue.length) {
        queue.sort((a, b) => distances.get(a) - distances.get(b));
        const node = queue.shift();
        if (node === to) break;
        const links = node === from && typeof node.id === 'string'
            ? node.section.sides.get(node.side).map(next => walk(node, next)) : [...node.links];
        if (node.section === to.section && node.side === to.side) links.push(walk(node, to));
        for (const link of links) {
            const distance = distances.get(node) + link.length;
            if (distance >= (distances.get(link.to) ?? Infinity)) continue;
            distances.set(link.to, distance); previous.set(link.to, link); queue.push(link.to);
        }
    }
    if (!previous.has(to)) return null;
    const route = []; let at = to;
    while (at !== from) { const link = previous.get(at); if (!link) return null; route.unshift(link); at = link.from; }
    return route;
}

export function pavementNodePose(town, node, widthFactor = town.walking.widthFactor) { return nodePoint(node, widthFactor); }

/** Remove a linked walker and every crossing/half-lane claim immediately. */
export function releaseLinkedWalker(town, person) {
    if (person.crossing) {
        releaseLane(person); person.crossing.users.delete(person);
        if (!person.crossing.users.size) person.crossing.exempt.clear();
        person.crossing = null;
    }
    town.walking?.linked.delete(person);
}

/** Advance a fixed journey with the same zebra and two-stage gap decisions as
 * ordinary walkers. It stops at its destination rather than choosing a random
 * next trip. A family uses one shared controller and a compact walking pose. */
export function updateLinkedWalker(town, person, dt) {
    if (!(dt > 0) || person.arrived || !person.route?.length) return;
    town.walking.linked.add(person);
    person.fireEngineWaiting = false;
    person.trafficWaiting = false;
    person.previousIndex = person.index; person.previousProgress = person.progress;
    let remaining = dt;
    for (let step = 0; step < 24 && remaining > 0; step++) {
        const link = person.route[person.index];
        if (!link) break;
        if (link.type === 'crossing' && !person.crossing) { requestCrossing(town, person, link.crossing); break; }
        if (link.crossing?.kind === 'gap') {
            const result = advanceGapCrossing(town, person, link, remaining); remaining = result.remaining;
            if (!result.complete) { if (remaining > 0) continue; break; }
        } else {
            if (person.state === 'crossing_wait') {
                if (!canEnter(town, person.crossing)) break;
                person.state = 'crossing'; person.activity = 'Crossing together at the zebra';
            }
            const length = link.type === 'crossing' ? pavement(link.from.section.road, town.walking.widthFactor) * 2 : link.length;
            const required = (1 - person.progress) * length / person.speed;
            if (blockedProgress(town, person, link, Math.min(1, person.progress + remaining * person.speed / length))) break;
            if (remaining < required) { person.progress += remaining * person.speed / length; break; }
            remaining -= required;
        }
        person.node = link.to; person.index++; person.progress = 0;
        if (person.crossing) releaseLinkedWalker(town, person);
        person.state = 'walking';
        if (person.index >= person.route.length) {
            person.arrived = true; person.state = 'arrived'; releaseLinkedWalker(town, person); break;
        }
    }
}
export function drawPedestrian(g, person, pose, time) {
    const waiting = person.trafficWaiting || person.fireEngineWaiting || ['crossing_wait', 'gap_wait', 'gap_middle_wait'].includes(person.state);
    const stride = !waiting && !person.pause ? Math.sin(time * person.speed * 5 + person.id) * 1.5 : 0;
    g.save(); g.translate(pose.x, pose.y); g.rotate(pose.angle); g.scale(0.5, 0.5);
    circle(g, 1, 2, 3.8, '#304b3c25');
    line(g, -3 + stride, -1.5, 0, -1, '#40504b', 1.7);
    line(g, -3 - stride, 1.5, 0, 1, '#40504b', 1.7);
    rounded(g, -1.5, -3, 4, 6, 2, person.colour);
    if (person.state === 'gap_crossing') line(g, 1, -3, 3.5, -4, '#dfb994', 1.5);
    circle(g, 1, 0, 2.2, '#dfb994'); g.restore();
}
export function drawPedestrianCrossings(g, town, widthFactor, layer = 0) {
    for (const crossing of town.walking?.crossings || []) {
        if (crossing.kind === 'gap') continue;
        const road = crossing.section.road;
        if (road.layer !== layer) continue;
        const p = crossing.point, curb = pavement(road, widthFactor), halfRoad = curb - 1.5;
        g.save(); g.translate(p.x, p.y); g.rotate(p.angle);
        g.fillStyle = '#ede8d6';
        for (let y = -halfRoad + 0.6; y < halfRoad - 0.5; y += 2.2) g.fillRect(-HALF_CROSSING, y, HALF_CROSSING * 2, Math.min(1.15, halfRoad - y));
        for (const side of [-1, 1]) {
            line(g, -6, side * curb, -6, side * (curb + 2.4), '#47594f', 1);
            circle(g, -6, side * (curb + 2.4), 1.5, '#e5af4e');
        }
        g.restore();
    }
}
