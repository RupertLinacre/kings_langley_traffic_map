import { randomSource, pathPoint } from './real-town.mjs';
import { insidePolygon } from './street-geometry.mjs';
import { SCHOOLS } from './kings-langley/engine/schools.mjs';
export { SCHOOLS };

class SpatialIndex {
    constructor(size = 70) { this.size = size; this.cells = new Map(); }
    keys(left, top, right, bottom) {
        const keys = [];
        for (let x = Math.floor(left / this.size); x <= Math.floor(right / this.size); x++)
            for (let y = Math.floor(top / this.size); y <= Math.floor(bottom / this.size); y++) keys.push(`${x}:${y}`);
        return keys;
    }
    add(item, left, top, right, bottom) {
        for (const key of this.keys(left, top, right, bottom)) {
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key).push(item);
        }
    }
    near(x, y, radius) { return new Set(this.keys(x - radius, y - radius, x + radius, y + radius).flatMap(k => this.cells.get(k) || [])); }
}
const segmentDistance = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
};

// Only the scenery is procedural. The surveyed road points and junction graph
// are never changed, even when a new decorative seed is selected.
export function createScenery(map, seed = 42) {
    const random = randomSource(seed ^ 0x79fe34), infrastructure = new SpatialIndex(), plots = new SpatialIndex();
    const buildings = [], trees = [];
    const schools = SCHOOLS.map(s => ({ ...s, polygon: s.outline.map(([x, y]) => ({ x, y })) }));
    for (const item of [...map.roads, ...map.context]) {
        const clearance = item.baseWidth ? item.baseWidth * item.size * 4 / 2 + 4 : item.tags.waterway ? 10 : 4;
        for (let i = 1; i < item.points.length; i++) {
            const a = item.points[i - 1], b = item.points[i];
            infrastructure.add({ a, b, clearance }, Math.min(a[0], b[0]) - clearance, Math.min(a[1], b[1]) - clearance,
                Math.max(a[0], b[0]) + clearance, Math.max(a[1], b[1]) + clearance);
        }
    }
    function clear(x, y, radius) {
        if (schools.some(s => insidePolygon({ x, y }, s.polygon))) return false;
        for (const item of infrastructure.near(x, y, radius + 5)) if (segmentDistance(x, y, item.a, item.b) < radius + item.clearance) return false;
        for (const item of plots.near(x, y, radius + 25)) if (Math.hypot(item.x - x, item.y - y) < item.radius + radius + 3) return false;
        return true;
    }
    for (const road of map.roads) {
        if (/motorway|trunk|service/.test(road.tags.highway) || road.layer > 0 || road.tags.junction) continue;
        for (let d = 15 + random() * 20; d < road.path.length - 10; d += 28 + random() * 9) {
            const p = pathPoint(road.path, d);
            for (const side of [-1, 1]) {
                const w = 16 + random() * 7, h = 12 + random() * 5, radius = Math.hypot(w, h) / 2 + 2;
                const setback = road.baseWidth * road.size * 4 / 2 + 25 + random() * 5;
                const x = p.x + Math.sin(p.angle) * side * setback, y = p.y - Math.cos(p.angle) * side * setback;
                if (!clear(x, y, radius)) continue;
                const plot = { x, y, w, h, radius, angle: p.angle + (side < 0 ? Math.PI : 0), seed: random() * 4294967296,
                    shop: /High Street|Hempstead Road|Station Road/.test(road.tags.name || '') && random() < 0.75,
                    curb: { x: p.x, y: p.y }, road, side };
                buildings.push(plot);
                plots.add(plot, x - radius, y - radius, x + radius, y + radius);
            }
        }
    }
    function plant(x, y, radius) {
        if (!clear(x, y, radius + 1)) return;
        const tree = { x, y, radius, seed: random() * 4294967296 };
        trees.push(tree);
        plots.add(tree, x - radius, y - radius, x + radius, y + radius);
    }
    for (const house of buildings) {
        if (random() > 0.6) continue;
        const distance = 19 + random() * 12;
        plant(house.x + Math.sin(house.angle) * distance, house.y - Math.cos(house.angle) * distance, 3 + random() * 2);
    }
    const { left, top, right, bottom } = map.bounds;
    for (let cluster = 0; cluster < 400; cluster++) {
        const cx = left + random() * (right - left), cy = top + random() * (bottom - top);
        for (let i = 0; i < 12; i++) {
            const angle = random() * Math.PI * 2, r = Math.sqrt(random()) * 75;
            plant(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 3 + random() * 4);
        }
    }
    return { buildings, trees, schools };
}
