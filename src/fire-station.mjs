import { rounded, line, circle } from './miniature-art.mjs';

/** Verified facility location. The council's linked map pin is the building
 * reference; OSM's amenity node is near its south-facing garage frontage.
 * There is no station building polygon in the local or current OSM extract.
 * Roof/yard dimensions below are an illustrative reconstruction, not a survey.
 */
export const FIRE_STATION = Object.freeze({
    id: 'fire-station', name: 'Kings Langley Fire Station', street: 'Common Lane', postcode: 'WD4 8BP',
    lon: -0.45159, lat: 51.715034, osmNode: 5448678271,
    osmFrontage: Object.freeze({ lon: -0.4515757, lat: 51.7149542 }),
    roadWay: 24041599,
    source: 'https://www.hertfordshire.gov.uk/services/fire-and-rescue/fire-station-locations/kings-langley-fire-station.aspx',
    assetSource: 'https://www.hertfordshire.gov.uk/media-library/documents/about-the-council/data-and-information/hcc-documents/hcc-land-and-buildings-january-2020-pdf.pdf',
    photoSource: 'https://www.geograph.org.uk/photo/584206',
    osmSource: 'https://www.openstreetmap.org/node/5448678271',
    // HCC asset register: OSGB507068/202944, building area164m²/site377m².
    // The photograph faces north and shows red garage doors and a west annex.
    geometryNote: 'Verified location and road frontage; illustrative garage, annex and paved apron dimensions.',
});

// Identical local equirectangular projection to the bundled OSM graph.
const LON_ORIGIN = -0.4455, LAT_ORIGIN = 51.7115;
const X_SCALE = 68976.2658919808, Y_SCALE = 111320;
export function projectFireStation({ lon, lat } = FIRE_STATION) {
    return { x: (lon - LON_ORIGIN) * X_SCALE, y: (LAT_ORIGIN - lat) * Y_SCALE };
}

function rectangle(x, y, w, h) {
    return [{ x: x - w / 2, y: y - h / 2 }, { x: x + w / 2, y: y - h / 2 },
        { x: x + w / 2, y: y + h / 2 }, { x: x - w / 2, y: y + h / 2 }];
}
function roadPoint(road, p) {
    let nearest = null, best = Infinity;
    for (let i = 1; i < road.points.length; i++) {
        const [ax, ay] = road.points[i - 1], [bx, by] = road.points[i];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const q = { x: ax + dx * t, y: ay + dy * t, angle: Math.atan2(dy, dx) };
        const distance = Math.hypot(q.x - p.x, q.y - p.y);
        if (distance < best) { best = distance; nearest = q; }
    }
    return nearest;
}

/** Shape shared by scenery, terrain guards and spawning. Yard/driveway are
 * polygons of {x,y}, buildings use {x,y,w,h,angle,layer}; candidates are full
 * road-associated poses facing south out of the garage. Physical dimensions
 * stay fixed when display roads widen. Returns null on unrelated/toy maps.
 */
export function fireStationGeometry(map, { widthFactor = 3 } = {}) {
    const road = map?.roadById?.get(FIRE_STATION.roadWay) || map?.roads?.find(r => r.id === FIRE_STATION.roadWay);
    if (!road?.points?.length) return null;
    const point = projectFireStation(), frontage = projectFireStation(FIRE_STATION.osmFrontage);
    const entrance = roadPoint(road, frontage);
    if (!entrance || Math.hypot(entrance.x - frontage.x, entrance.y - frontage.y) > 35) return null;
    const building = { ...point, w: 10, h: 14, length: 10, width: 14, angle: 0, layer: 0, kind: 'fire station' };
    const annex = { x: point.x - 7, y: point.y + 2.5, w: 4, h: 6,
        length: 4, width: 6, angle: 0, layer: 0, kind: 'fire station annex' };
    const north = point.y + building.h / 2 + 0.2;
    const left = point.x - 8, right = point.x + 8;
    const westMouth = roadPoint(road, { x: left, y: entrance.y });
    const eastMouth = roadPoint(road, { x: right, y: entrance.y });
    const yard = [{ x: left, y: north }, { x: right, y: north },
        { x: right, y: eastMouth.y + 0.6 }, { x: left, y: westMouth.y + 0.6 }];
    // Overlap both the apron and the surveyed Common Lane centreline; there
    // is no grass slit at narrow road settings and no disconnected paved lot.
    const driveway = [{ x: left, y: north + 3 }, { x: right, y: north + 3 },
        { x: right + 1, y: eastMouth.y + 3 }, { x: left - 1, y: westMouth.y + 3 }];
    const spawnY = north + 6.7;
    const spawnCandidates = [0, -1.35, 1.35].map(offset => ({ x: point.x + offset, y: spawnY,
        angle: Math.PI / 2, road, layer: 0 }));
    const points = [...yard, ...driveway, ...rectangle(building.x, building.y, building.w, building.h),
        ...rectangle(annex.x, annex.y, annex.w, annex.h)];
    return { id: FIRE_STATION.id, name: FIRE_STATION.name, point, frontage, entrance,
        road, layer: 0, widthFactor, building, buildings: [building, annex], yard, driveway,
        polygons: [yard, driveway], spawnCandidates, bounds: {
            left: Math.min(...points.map(p => p.x)) - 4, right: Math.max(...points.map(p => p.x)) + 4,
            top: Math.min(...points.map(p => p.y)) - 4, bottom: Math.max(...points.map(p => p.y)) + 4,
        } };
}

function insidePolygon(points, p) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j], dx = b.x - a.x, dy = b.y - a.y;
        // Boundary points belong to the paved polygon as well.
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t) < 1e-8) return true;
        if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Terrain union for the fixed paved apron/access; building walls are always
 * excluded, including where an exaggerated Common Lane pavement reaches them.
 */
export function fireStationContainsPoint(shape, p) {
    if (!shape || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.layer || 0) !== shape.layer) return false;
    if (shape.buildings.some(b => Math.abs(p.x - b.x) <= b.w / 2 && Math.abs(p.y - b.y) <= b.h / 2)) return false;
    return shape.polygons.some(points => insidePolygon(points, p));
}

function polygon(g, points) {
    g.beginPath(); g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
}

/** Native miniature artwork. Call on ground layer after streets and before
 * traffic; the shared shape reserves scenery and supplies the collision hulls.
 */
export function drawFireStation(g, shape, { zoom = 1, layer = 0, visible = () => true } = {}) {
    if (!shape || layer !== shape.layer || !visible(shape.point, 35)) return;
    const b = shape.building, annex = shape.buildings[1];
    g.save();
    polygon(g, shape.driveway); g.fillStyle = '#a7aaa0'; g.fill();
    polygon(g, shape.yard); g.fillStyle = '#aeb1a6'; g.fill();
    g.strokeStyle = '#dedcc7'; g.lineWidth = 0.45;
    line(g, shape.yard[0].x, shape.yard[0].y, shape.yard[3].x, shape.yard[3].y, '#b8c1ab', 0.6);
    line(g, shape.yard[1].x, shape.yard[1].y, shape.yard[2].x, shape.yard[2].y, '#b8c1ab', 0.6);
    // Red-brick walls, slate pitched roof and a modest western office annex.
    rounded(g, annex.x - annex.w / 2 + 0.6, annex.y - annex.h / 2 + 0.7, annex.w, annex.h, 0.3, '#59695a38');
    rounded(g, annex.x - annex.w / 2, annex.y - annex.h / 2, annex.w, annex.h, 0.2, '#89877b');
    line(g, annex.x - 0.6, annex.y - annex.h / 2, annex.x - 0.6, annex.y + annex.h / 2, '#b5b2a0', 0.25);
    rounded(g, b.x - b.w / 2 + 0.7, b.y - b.h / 2 + 0.9, b.w, b.h, 0.35, '#59695a40');
    rounded(g, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, 0.2, '#bd9271');
    rounded(g, b.x - b.w / 2 + 0.3, b.y - b.h / 2 + 0.25, b.w / 2 - 0.3, b.h - 0.6, 0.15, '#919083');
    rounded(g, b.x, b.y - b.h / 2 + 0.25, b.w / 2 - 0.3, b.h - 0.6, 0.15, '#747d73');
    line(g, b.x, b.y - b.h / 2 + 0.2, b.x, b.y + b.h / 2 - 0.6, '#bbb8a5', 0.35);
    // The bay fronts face Common Lane, matching the station photograph.
    for (const offset of [-2, 2]) {
        rounded(g, b.x + offset - 1.7, b.y + b.h / 2 - 0.7, 3.4, 1, 0.1, '#bf443b');
        line(g, b.x + offset, b.y + b.h / 2 - 0.6, b.x + offset, b.y + b.h / 2 + 0.2, '#86362f', 0.15);
        for (const slot of [-0.85, 0.85]) rounded(g, b.x + offset + slot - 0.4, b.y + b.h / 2 - 0.5, 0.8, 0.34, 0.06, '#3c5557');
    }
    rounded(g, b.x - 4.2, b.y + b.h / 2 - 1.65, 8.4, 0.9, 0.1, '#a94035');
    const sign = { x: shape.yard[3].x + 0.8, y: shape.yard[3].y - 2 };
    line(g, sign.x, sign.y - 0.4, sign.x, sign.y + 1, '#945b48', 0.25);
    rounded(g, sign.x - 0.8, sign.y - 0.65, 1.6, 1.3, 0.12, '#d54b3f');
    circle(g, sign.x, sign.y, 0.34, '#eddd8a');
    if (zoom >= 1.8) {
        g.font = '700 1.15px system-ui,sans-serif'; g.fillStyle = '#fae8d3';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('FIRE STATION', b.x, b.y + b.h / 2 - 1.2, 7.8);
        g.font = '600 1.5px system-ui,sans-serif'; g.fillStyle = '#f2e7c8';
        g.fillText('KEEP CLEAR', shape.point.x, shape.entrance.y - 2.3, 12);
    }
    g.restore();
}
