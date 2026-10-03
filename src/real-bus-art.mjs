import { laneOffset, position, roadWidthFactor } from './real-town.mjs';
import { circle, line, rounded } from './miniature-art.mjs';

// Stop coordinates are the surveyed boarding point, beside the front of a bus.
// Markings sit in that direction's left lane; the pole sits beyond its kerb.
export function busStopGeometry(town, stop, roadSize) {
    const edge = town.map.data.edges[stop.edgeId], road = edge && town.map.roadById.get(edge.way);
    if (!road) return null;
    const factor = roadWidthFactor(road, roadSize);
    const front = Math.max(0, Math.min(edge.length, stop.d));
    const chain = [edge], seen = new Set([edge.id]);
    let available = front;
    while (available < 25) {
        const current = chain.at(-1), node = current.from;
        const touching = town.map.data.edges.filter(e => e.from === node || e.to === node);
        const neighbours = new Set(touching.map(e => e.from === node ? e.to : e.from));
        if (neighbours.size !== 2) break;
        const candidates = touching.filter(e => e.to === node && e.from !== current.to && !seen.has(e.id) &&
            (e.way === current.way || e.tags.name && e.tags.name === current.tags.name));
        if (candidates.length !== 1) break;
        const previous = candidates[0], previousRoad = town.map.roadById.get(previous.way);
        if (!previousRoad || previousRoad.layer !== road.layer || previousRoad.baseWidth !== road.baseWidth) break;
        chain.push(previous); seen.add(previous.id); available += previous.length;
    }
    const endBack = Math.min(1, available), startBack = Math.min(25, available);
    const width = 3.05 * factor, offset = laneOffset(edge, 0) * factor;
    const at = (back, lateral) => {
        let d = front - back, section = edge;
        for (const previous of chain.slice(1)) {
            if (d >= 0) break;
            section = previous; d += previous.length;
        }
        const p = position(section, Math.max(0, d));
        return { x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, angle: Math.atan2(p.dy, p.dx) };
    };
    const near = [], far = [];
    const samples = Math.max(1, Math.ceil((startBack - endBack) / 3));
    for (let i = 0; i <= samples; i++) {
        const back = startBack + (endBack - startBack) * i / samples;
        near.push(at(back, offset + width / 2)); far.push(at(back, offset - width / 2));
    }
    return { road, factor, width, length: startBack - endBack, near, far,
        centre: at((startBack + endBack) / 2, offset),
        pole: at(0, road.baseWidth * factor / 2 + 1.7),
    };
}

function path(g, points) {
    g.beginPath(); g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
}

export function drawBusStops(g, town, roadSize, layer, visible = () => true, scale = 1) {
    for (const stop of town.buses?.stops || []) {
        const shape = busStopGeometry(town, stop, roadSize);
        if (!shape || shape.road.layer !== layer || !visible(shape.pole, 35)) continue;
        const { pole, centre, near, far, factor } = shape;
        g.save(); g.lineCap = 'butt'; g.lineJoin = 'round';
        g.strokeStyle = '#e7bd5c'; g.lineWidth = 0.42 * Math.sqrt(factor);
        if (shape.length > 5) {
            g.setLineDash([2.3, 1.7]);
            path(g, [near[0], ...far, near.at(-1)]); g.stroke();
            g.setLineDash([]); path(g, near); g.lineWidth = 0.6 * Math.sqrt(factor); g.stroke();
            if (shape.length > 16 && scale >= 0.85) {
                g.save(); g.translate(centre.x, centre.y); g.rotate(centre.angle);
                g.fillStyle = '#e7bd5cbf'; g.font = `600 ${Math.min(4.2, 2.6 * factor)}px system-ui, sans-serif`;
                g.textAlign = 'center'; g.textBaseline = 'middle';
                g.fillText('BUS STOP', 0, 0, shape.length - 4); g.restore();
            }
        }
        // Small red-and-cream flag, like a real stop sign, with a shadow on the
        // pavement. Unlike a map pin it stays modest when viewing the village.
        circle(g, pole.x + 0.7, pole.y + 0.8, 1.65, '#53665338');
        circle(g, pole.x, pole.y, 1.55, '#f4edd6');
        circle(g, pole.x, pole.y, 1.2, '#cc6755');
        g.save(); g.translate(pole.x, pole.y); g.rotate(pole.angle);
        line(g, -0.75, 0.5, 0.75, -0.5, '#fff0d2', 0.55); g.restore();
        if (scale >= 2.8) {
            const name = stop.name.replace(/^Kings Langley,?\s*/i, '');
            g.save(); g.translate(pole.x, pole.y); g.scale(1 / scale, 1 / scale);
            g.font = '600 9px system-ui, sans-serif';
            const width = g.measureText(name).width + 12;
            rounded(g, 7, -7, width, 16, 4, '#f8f1dfeb');
            g.fillStyle = '#586b5c'; g.textAlign = 'left'; g.textBaseline = 'middle';
            g.fillText(name, 13, 1); g.restore();
        }
        g.restore();
    }
}
