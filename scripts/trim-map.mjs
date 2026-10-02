import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeGraph, findRoute } from '../src/kings-langley/engine/graph.mjs';

// Coordinates are metres in the original snapshot's local projection (east, south).
// The named boundaries deliberately follow the village, rather than cropping the
// whole source to a rectangular camera window.
export const REGION = {
    id: 'kings-langley-village-v1',
    north: { lowerRoadEnd: [-365.40866618935974, -2059.3754719998215], redLionRoundabout: [-308, -1867] },
    west: -3700,
    motorway: { east: 1350, south: 2150 },
    watfordRoadEnd: { node: 1547989223, p: [588.6641460019335, 2068.537108000103] },
    laneChains: {
        'Hyde Lane': [{ way: 7808973, reverse: true }],
        'Harthall Lane': [{ way: 1540102305 }, { way: 7808895 }],
        // The main alignment excludes the two short parallel access loops.
        'Toms Lane': [{ way: 372673502, reverse: true }, { way: 372673501, reverse: true }, { way: 800555326, reverse: true }],
    },
    excludedNames: ['Belswains Lane', 'Bunkers Lane', 'West Valley Road', 'Harrier Close', 'Pipit Walk'],
    // Retain the small junction at the end of the Watford Road tail so both
    // carriageways have a real, legally connected destination at Langleybury Lane.
    terminalJunctionWays: [141427154, 141427155, 198038758, 198038759, 198038760, 238943489],
};

const EPS = 1e-7;
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const length = points => points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
const same = (a, b) => distance(a, b) < EPS;
const lerp = (a, b, t) => t === 0 ? a : t === 1 ? b : a.map((v, i) => v + (b[i] - v) * t);
const rectangle = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];
function onSegment(p, a, b) { return Math.abs(distance(a, p) + distance(p, b) - distance(a, b)) < EPS; }
export function inside(p, polygon) {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j], b = polygon[i];
        if (onSegment(p, a, b)) return true;
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
}
// Intersect a polyline with a polygon, preserving separate exit/re-entry pieces.
export function clip(points, polygon) {
    const result = []; let current = null;
    for (let k = 1; k < points.length; k++) {
        const a = points[k - 1], b = points[k], dx = b[0] - a[0], dy = b[1] - a[1], cuts = [0, 1];
        for (let i = 0; i < polygon.length; i++) {
            const c = polygon[i], d = polygon[(i + 1) % polygon.length], ex = d[0] - c[0], ey = d[1] - c[1];
            const det = dx * ey - dy * ex;
            if (Math.abs(det) < 1e-10) continue;
            const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det;
            const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
            if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) cuts.push(t);
        }
        cuts.sort((a, b) => a - b);
        for (let i = 1; i < cuts.length; i++) {
            const start = lerp(a, b, cuts[i - 1]), end = lerp(a, b, cuts[i]);
            if (distance(start, end) < EPS) continue;
            if (inside(lerp(start, end, .5), polygon)) {
                if (!current || !same(current.at(-1), start)) { current = [start]; result.push(current); }
                current.push(end);
            } else current = null;
        }
    }
    return result.filter(points => length(points) > 0.01);
}
function pointAt(points, target) {
    for (let i = 1; i < points.length; i++) { const span = distance(points[i - 1], points[i]); if (target <= span) return lerp(points[i - 1], points[i], target / span); target -= span; }
    return points.at(-1);
}
function containsPoint(points, p) { return points.slice(1).some((b, i) => onSegment(p, points[i], b)); }
function midpoint(points) { return pointAt(points, length(points) / 2); }

export function trimSnapshot(source, demand) {
    const originalCounts = { nodes: Object.keys(source.nodes).length, edges: source.edges.length, ways: source.ways.length, routes: demand.routes.length };
    // The source exporter treated the Toms Lane height restrictors as complete
    // road closures. Restore the surveyed car-accessible underpass; otherwise
    // cropping the long route through Bedmond isolates all of inner Toms Lane.
    // These are existing OSM nodes and way shapes, not a geometric shortcut.
    const bridgeSpans = [
        { way: 372673502, from: 2503338035, to: 14122815923 },
        { way: 372673501, from: 34152963, to: 2503338035 },
        { way: 800555326, from: 6953494915, to: 34152963 },
    ];
    const sourceEdges = [...source.edges];
    for (const span of bridgeSpans) {
        const way = source.ways.find(w => w.id === span.way);
        const first = way.points.findIndex(p => same(p, source.nodes[span.from].p));
        const last = way.points.findIndex(p => same(p, source.nodes[span.to].p));
        if (first < 0 || last <= first) throw new Error('Missing surveyed Toms Lane underpass geometry');
        const points = way.points.slice(first, last + 1);
        for (const forward of [true, false]) sourceEdges.push({ id: sourceEdges.length, way: way.id, tags: { ...way.tags, maxheight: `10'9"` },
            from: forward ? span.from : span.to, to: forward ? span.to : span.from, points: forward ? points : [...points].reverse(),
            forward, length: length(points), speed: 13.4112, speedSource: 'OSM tag', speedTag: '30 mph', restoredUnderpass: true });
    }
    source = { ...source, edges: sourceEdges };
    const laneHalves = Object.fromEntries(Object.entries(REGION.laneChains).map(([name, chain]) => {
        const points = chain.flatMap(({ way, reverse }, i) => {
            const wayPoints = source.ways.find(w => w.id === way)?.points;
            if (!wayPoints) throw new Error(`Missing source way ${way} (${name})`);
            return (reverse ? [...wayPoints].reverse() : wayPoints).slice(i ? 1 : 0);
        });
        return [name, { sourceLength: length(points), retainedLength: length(points) / 2, end: midpoint(points) }];
    }));
    const h = laneHalves['Hyde Lane'].end, a = laneHalves['Harthall Lane'].end, t = laneHalves['Toms Lane'].end;
    // The south-east boundary follows the south carriageway of the M25 to J20.
    const motorwayArc = source.ways.find(w => w.id === 961590392).points.filter(p => p[0] < REGION.motorway.east);
    const motorwayContinue = source.ways.find(w => w.id === 23815000).points;
    const core = [[REGION.west, REGION.north.lowerRoadEnd[1]], [-615, REGION.north.lowerRoadEnd[1]], [-515, -1910], [-295, -1910],
        [-225, -1640], [500, -1570], [h[0], -1570], [h[0], h[1] + 60], [a[0], a[1] - 70], [a[0], a[1] + 70],
        [t[0], t[1] - 100], [t[0], t[1] + 100], [REGION.motorway.east, -550], [REGION.motorway.east, -24],
        ...motorwayArc, ...motorwayContinue.slice(1), [192, 1316], [50, 1350], [REGION.west, 1350]];
    const all = rectangle(-10000, -10000, 10000, 10000);
    const motorway = rectangle(-10000, -10000, REGION.motorway.east, REGION.motorway.south);
    const watford = rectangle(-10000, -10000, 10000, REGION.watfordRoadEnd.p[1]);
    const excluded = new Set(REGION.excludedNames), terminal = new Set(REGION.terminalJunctionWays);
    function polygons(item) {
        const tags = item.tags, name = tags.name;
        if (excluded.has(name)) return [];
        if (tags.ref === 'M25' && /motorway/.test(tags.highway)) return [motorway];
        if (name === 'Kings Langley Interchange' || name === 'Lower Road' || terminal.has(item.way ?? item.id)) return [all];
        if (name === 'Watford Road') return [watford];
        if (name === 'Langleybury Lane') return [rectangle(564.1913668634594, 2000, 620, 2100)];
        return laneHalves[name] ? [core, rectangle(-10000, -10000, laneHalves[name].end[0], 10000)] : [core];
    }
    function trimmed(item) {
        const regions = polygons(item);
        return regions.reduce((pieces, polygon) => pieces.flatMap(points => clip(points, polygon)), regions.length ? [item.points] : []);
    }
    const edges = [], nodes = {}, boundaryNodes = new Map(); let virtualNode = -1, virtualWay = -1;
    const sourceNodes = source.nodes;
    function nodeFor(edge, p) {
        for (const id of [edge.from, edge.to]) if (same(p, sourceNodes[id].p)) { nodes[id] = sourceNodes[id]; return id; }
        // Scope by original topological edge, so bridges never gain accidental junctions.
        const key = `${[edge.from, edge.to].sort((a,b) => a-b).join(':')}:${p.map(v => v.toFixed(6)).join(':')}`;
        if (boundaryNodes.has(key)) return boundaryNodes.get(key);
        const id = virtualNode--, ref = sourceNodes[edge.from], other = sourceNodes[edge.to];
        const scaleX = (other.lon - ref.lon) / (other.p[0] - ref.p[0]), scaleY = (other.lat - ref.lat) / (other.p[1] - ref.p[1]);
        // The projection is affine. Use a fixed surveyed pair for axis-parallel edges.
        const first = sourceNodes[204888], second = sourceNodes[204889];
        const sx = Number.isFinite(scaleX) ? scaleX : (second.lon - first.lon) / (second.p[0] - first.p[0]);
        const sy = Number.isFinite(scaleY) ? scaleY : (second.lat - first.lat) / (second.p[1] - first.p[1]);
        nodes[id] = { id, lon: ref.lon + (p[0] - ref.p[0]) * sx, lat: ref.lat + (p[1] - ref.p[1]) * sy,
            p, tags: {}, cropBoundary: true };
        boundaryNodes.set(key, id); return id;
    }
    const wayPieces = new Map(), ways = [];
    for (const way of source.ways) {
        const pieces = trimmed(way).map((points, i) => ({ ...way, id: i ? virtualWay-- : way.id, ...(i ? { sourceWay: way.id } : {}), points }));
        ways.push(...pieces); wayPieces.set(way.id, pieces);
    }
    const oldToNew = new Map();
    for (const edge of source.edges) for (const points of trimmed(edge)) {
        const way = wayPieces.get(edge.way).find(piece => containsPoint(piece.points, midpoint(points)));
        if (!way) throw new Error(`No rendered way for clipped edge ${edge.id}`);
        const from = nodeFor(edge, points[0]), to = nodeFor(edge, points.at(-1));
        points[0] = nodes[from].p; points[points.length - 1] = nodes[to].p;
        const clippedEdge = { ...edge, id: edges.length, way: way.id, from, to, points, length: length(points), sourceEdge: edge.id };
        edges.push(clippedEdge);
        if (!oldToNew.has(edge.id)) oldToNew.set(edge.id, []);
        oldToNew.get(edge.id).push(clippedEdge);
    }
    // Discard isolated remnants of suburbs cut off by the new boundary.
    const adjacent = new Map();
    for (const e of edges) for (const [a,b] of [[e.from,e.to],[e.to,e.from]]) { if (!adjacent.has(a)) adjacent.set(a, []); adjacent.get(a).push(b); }
    const connected = new Set([260730927]), queue = [...connected];
    for (let i = 0; i < queue.length; i++) for (const to of adjacent.get(queue[i]) || []) if (!connected.has(to)) { connected.add(to); queue.push(to); }
    const kept = edges.filter(e => connected.has(e.from));
    const usedNodes = new Set(kept.flatMap(e => [e.from,e.to])), usedWays = new Set(kept.map(e => e.way));
    for (const id of Object.keys(nodes)) if (!usedNodes.has(Number(id))) delete nodes[id];
    kept.forEach((edge, i) => edge.id = i);
    const routes = [];
    for (const route of demand.routes) {
        let run = [], previous;
        const flush = () => {
            // Very short edge fragments cannot contain the enlarged vehicle body.
            if (run.reduce((sum,e) => sum + e.length, 0) >= 35) routes.push({ ...route, path: run.map(e => e.id),
                fromName: sourceNodes[run[0].from] && run[0].sourceEdge === route.path[0] ? route.fromName : `${run[0].tags.name || run[0].tags.ref || 'Village'} boundary`,
                toName: sourceNodes[run.at(-1).to] && run.at(-1).sourceEdge === route.path.at(-1) ? route.toName : `${run.at(-1).tags.name || run.at(-1).tags.ref || 'Village'} boundary` });
            run = []; previous = undefined;
        };
        for (const oldId of route.path) {
            const fragments = (oldToNew.get(oldId) || []).filter(e => connected.has(e.from));
            if (!fragments.length) { flush(); continue; }
            for (const edge of fragments) { if (previous && previous.to !== edge.from) flush(); run.push(edge); previous = edge; }
        }
        flush();
    }
    const keptWays = ways.filter(w => usedWays.has(w.id));
    // Clip context to the village itself; no long canal/rail tails beyond the M25.
    let contextId = -1;
    const context = source.context.flatMap(item => clip(item.points, core).map((points, i) => ({ ...item, id: i ? contextId-- : item.id, ...(i ? { sourceWay: item.id } : {}), points })));
    const places = source.places.filter(place => inside(place.p, core));
    const restrictions = source.restrictions.filter(r => usedNodes.has(r.via) && keptWays.some(w => (w.sourceWay || w.id) === r.from) && keptWays.some(w => (w.sourceWay || w.id) === r.to));
    const bounds = Object.values(nodes).reduce((b,n) => [Math.min(b[0],n.lat),Math.min(b[1],n.lon),Math.max(b[2],n.lat),Math.max(b[3],n.lon)],[Infinity,Infinity,-Infinity,-Infinity]);
    const region = { ...REGION, core, laneHalves, restoredUnderpass: bridgeSpans, sourceCounts: originalCounts };
    const network = { ...source, meta: { ...source.meta, sourceBbox: source.meta.bbox, bbox: bounds, roadWays: keptWays.length,
        signalNodes: Object.values(nodes).filter(n => n.tags.highway === 'traffic_signals').length, region }, nodes, edges: kept, ways: keptWays, restrictions, context, places };
    const graph = makeGraph(network);
    const tomsBoundary = Object.values(nodes).find(n => same(n.p, laneHalves['Toms Lane'].end));
    for (const [from, to] of [[tomsBoundary.id, 260730927], [260730927, tomsBoundary.id]]) {
        const path = findRoute(graph, from, to);
        if (!path?.length) throw new Error('Restored Toms Lane must connect to High Street in both directions');
        routes.push({ path, rate: 1, group: 'local', fromName: from === tomsBoundary.id ? 'Toms Lane boundary' : 'High Street',
            toName: to === tomsBoundary.id ? 'Toms Lane boundary' : 'High Street', mix: { car: 100, van: 0, bus: 0, lorry: 0 }, source: 'Illustrative village trips through the surveyed Toms Lane underpass' });
    }
    const croppedDemand = { ...demand, meta: { ...demand.meta, region: REGION.id, description: 'Source synthetic journeys clipped to contiguous retained road segments; crop boundaries act as entries and exits. Two illustrative car routes use the restored Toms Lane underpass. Vehicle sizes and demand are illustrative.' }, routes,
        detectors: (demand.detectors || []).filter(d => usedNodes.has(d.node)) };
    return { network, demand: croppedDemand };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [sourceDir, outputDir] = process.argv.slice(2);
    if (!sourceDir || !outputDir) throw new Error('Usage: node scripts/trim-map.mjs <original-snapshot-directory> <output-directory>');
    if (resolve(sourceDir) === resolve(outputDir)) throw new Error('Use separate source and output directories; the original snapshot is required for reproducibility.');
    const [network, demand] = await Promise.all(['network.json','demand.json'].map(name => readFile(resolve(sourceDir, name), 'utf8').then(JSON.parse)));
    if (network.meta.region) throw new Error('Input is already cropped; use the original source snapshot.');
    const result = trimSnapshot(network, demand);
    await mkdir(outputDir, { recursive: true });
    await Promise.all(Object.entries(result).map(([name,data]) => writeFile(resolve(outputDir, `${name}.json`), `${JSON.stringify(data)}\n`)));
    console.log(JSON.stringify({ nodes: Object.keys(result.network.nodes).length, ways: result.network.ways.length, edges: result.network.edges.length, routes: result.demand.routes.length, laneHalves: result.network.meta.region.laneHalves }, null, 2));
}
