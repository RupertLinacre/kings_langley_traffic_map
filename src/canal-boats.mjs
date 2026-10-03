import { measure, pathPoint } from './street-geometry.mjs';

const JOIN_TOLERANCE = 0.15;
const SPEED = 1.15;
const COLOURS = ['#427d88', '#9b544e', '#446853', '#61577f', '#b58242', '#39657f'];
const NAMES = ['Kingfisher', 'Bluebell', 'Willow', 'Heron', 'Meadow', 'Slowly Does It'];
const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;
const comparePoint = (a, b) => a[1] - b[1] || a[0] - b[0];
const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < JOIN_TOLERANCE;

function randomSource(seed) {
    let state = Number(seed) | 0;
    return () => { state = Math.imul(1664525, state) + 1013904223 | 0; return (state >>> 0) / 4294967296; };
}

function measuredPoints(points, closed = false) {
    return measure(points.map(([x, y], index) => {
        const before = points[index ? index - 1 : closed ? points.length - 2 : 0];
        const after = points[index < points.length - 1 ? index + 1 : closed ? 1 : index];
        return { x, y, angle: Math.atan2(after[1] - before[1], after[0] - before[0]) };
    }));
}

// Survey pieces can be stored in either direction. Join only their coincident
// endpoints; disconnected pieces and branch junctions remain separate routes.
function canalRoutes(map) {
    const items = (map.context || []).filter(item => item.tags?.waterway === 'canal' && item.points?.length > 1)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const nodes = [], edges = [];
    const endpoint = point => {
        let node = nodes.find(candidate => samePoint(candidate.point, point));
        if (!node) { node = { point, edges: [] }; nodes.push(node); }
        return node;
    };
    for (const item of items) {
        const a = endpoint(item.points[0]), b = endpoint(item.points.at(-1));
        const edge = { item, a, b };
        a.edges.push(edge); b.edges.push(edge); edges.push(edge);
    }
    const remaining = new Set(edges), routes = [];
    function walk(start, first) {
        const pieces = [];
        let node = start, edge = first;
        while (edge && remaining.has(edge)) {
            remaining.delete(edge);
            const reversed = edge.b === node;
            pieces.push({ item: edge.item, reversed });
            node = reversed ? edge.a : edge.b;
            if (node === start || node.edges.length !== 2) break;
            edge = node.edges.find(candidate => remaining.has(candidate));
        }
        const rawStart = pieces[0].item.points[pieces[0].reversed ? pieces[0].item.points.length - 1 : 0];
        const last = pieces.at(-1);
        const rawEnd = last.item.points[last.reversed ? 0 : last.item.points.length - 1];
        const closed = samePoint(rawStart, rawEnd);
        if (!closed && comparePoint(rawStart, rawEnd) > 0) {
            pieces.reverse(); pieces.forEach(piece => { piece.reversed = !piece.reversed; });
        }
        let length = 0;
        const points = [], segments = [];
        for (const piece of pieces) {
            const oriented = (piece.reversed ? [...piece.item.points].reverse() : piece.item.points).map(point => [...point]);
            // Use one shared endpoint for sub-decimetre rounding differences.
            if (points.length) oriented[0] = [...points.at(-1)];
            const path = measuredPoints(oriented);
            if (!path.length) continue;
            segments.push({ ...piece, path, start: length, end: length + path.length });
            length += path.length;
            points.push(...(points.length ? oriented.slice(1) : oriented));
        }
        if (length >= 80) routes.push({ segments, path: measuredPoints(points, closed), length, closed });
    }
    // Starting at the endpoints also prevents a chain from stopping at whichever
    // middle OSM way happened to appear first in the source array.
    for (const node of [...nodes].sort((a, b) => comparePoint(a.point, b.point))) {
        if (node.edges.length === 2) continue;
        for (const edge of node.edges) if (remaining.has(edge)) walk(node, edge);
    }
    while (remaining.size) {
        const edge = [...remaining][0];
        walk(comparePoint(edge.a.point, edge.b.point) <= 0 ? edge.a : edge.b, edge);
    }
    return routes.sort((a, b) => b.length - a.length || comparePoint(a.segments[0].item.points[0], b.segments[0].item.points[0]));
}

export function createCanalBoats(map, seed = 42) {
    const random = randomSource(seed), boats = [];
    for (const [routeIndex, route] of canalRoutes(map).entries()) {
        const count = Math.max(2, Math.min(6, 2 * Math.ceil(route.length / 1200)));
        const entryDistance = 15;
        const cycle = route.closed ? route.length / SPEED : (route.length + entryDistance * 2) / SPEED + 90;
        // A boat begins by the village centre rather than all arriving from the
        // map boundary. Equal phases and equal speeds prevent rear-end overlaps,
        // including after the invisible return interval at each cropped end.
        const phase = (route.length * (0.64 + (random() - 0.5) * 0.025) + entryDistance) / SPEED;
        const colourOffset = Math.floor(random() * COLOURS.length);
        for (let index = 0; index < count; index++) {
            boats.push({ id: `canal-${routeIndex + 1}-${index + 1}`, name: NAMES[(index + routeIndex) % NAMES.length],
                colour: COLOURS[(index + colourOffset) % COLOURS.length], length: 17 + random() * 4, width: 2.1,
                route, direction: index % 2 ? -1 : 1, speed: SPEED, offset: 1.4,
                phase: phase + cycle * index / count, cycle, entryDistance });
        }
    }
    return boats;
}

export function canalBoatPose(boat, time) {
    const elapsed = modulo((Number.isFinite(time) ? time : 0) + boat.phase, boat.cycle);
    const progress = elapsed * boat.speed - (boat.route.closed ? 0 : boat.entryDistance);
    const q = boat.direction > 0 ? progress : boat.route.length - progress;
    const visible = boat.route.closed || q >= 0 && q <= boat.route.length;
    const routeQ = boat.route.closed ? modulo(q, boat.route.length) : Math.max(0, Math.min(boat.route.length, q));
    const p = pathPoint(boat.route.path, routeQ);
    const segment = boat.route.segments.find(part => routeQ <= part.end) || boat.route.segments.at(-1);
    const angle = p.angle + (boat.direction < 0 ? Math.PI : 0);
    const lock = boat.route.segments.filter(part => part.item.tags.lock === 'yes')
        .map(part => ({ name: part.item.tags.lock_name || 'Canal lock', distance: Math.abs((part.start + part.end) / 2 - routeQ) }))
        .sort((a, b) => a.distance - b.distance)[0];
    return { x: p.x - Math.sin(angle) * boat.offset, y: p.y + Math.cos(angle) * boat.offset,
        angle, layer: Number(segment.item.layer ?? segment.item.tags.layer) || 0, q, speed: visible ? boat.speed : 0,
        visible, state: visible ? 'cruising' : 'away', direction: boat.direction, offset: boat.offset,
        lockName: lock?.distance < 70 ? lock.name : null, lockDistance: lock?.distance ?? Infinity };
}
