import { rounded, circle, line } from './miniature-art.mjs';
import { drawPedestrian } from './real-pedestrians.mjs';
import { stationPassengerPose } from './station-visits.mjs';

const DEFAULT_COLOUR = '#537d9b';

function corner(p, along, across) {
    const angle = p.angle || 0, dx = Math.cos(angle), dy = Math.sin(angle);
    return { x: p.x + dx * along - dy * across,
        y: p.y + dy * along + dx * across };
}

// The forecourt stays at its geographical size when the streets are widened.
// In particular, its eastern edge must not grow into the main-line railway.
export function stationArtGeometry(town) {
    const area = town.stationVisits?.area, bays = area?.bays;
    if (!bays?.length) return null;
    const first = bays[0], last = bays.at(-1);
    const forecourt = [corner(first, -6.5, -9), corner(first, -6.5, 2.5),
        corner(last, 6.5, 2.5), corner(last, 6.5, -9)];
    const portal = area.portal || area.waitingPoint || area.entrance;
    const points = [...forecourt, ...(portal ? [portal] : [])];
    return { area, bays, forecourt, portal, layer: area.layer || 0,
        bounds: { left: Math.min(...points.map(p => p.x)) - 3,
            top: Math.min(...points.map(p => p.y)) - 3,
            right: Math.max(...points.map(p => p.x)) + 3,
            bottom: Math.max(...points.map(p => p.y)) + 3 } };
}

function polygon(g, points) {
    g.beginPath(); g.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) g.lineTo(point.x, point.y);
    g.closePath();
}

export function drawStationArea(g, town, widthFactor, layer, visible = () => true, scale = 1) {
    const shape = stationArtGeometry(town);
    if (!shape || shape.layer !== layer || !shape.bays.some(p => visible(p, 30))) return;
    const { bays, forecourt, portal } = shape;
    g.save();
    polygon(g, forecourt); g.fillStyle = '#83918b'; g.fill();
    g.strokeStyle = '#d9ddc9'; g.lineWidth = 0.6; g.stroke();
    if (portal) {
        const access = corner(bays[0], -6.5, 2);
        line(g, access.x, access.y, portal.x, portal.y, '#d8dcc9', 3);
        line(g, access.x, access.y, portal.x, portal.y, '#e9e3d3', 2.2);
    }
    // A few short-stay spaces, drawn to the same physical width as the cars.
    // This is a miniature forecourt illustration, not surveyed road markings.
    for (const bay of bays) {
        g.save(); g.translate(bay.x, bay.y); g.rotate(bay.angle);
        g.strokeStyle = '#ede9d6'; g.lineWidth = 0.42;
        g.setLineDash([1.7, 1.1]);
        g.strokeRect(-5.4, -1.6, 10.8, 3.2); g.setLineDash([]);
        line(g, -4.8, -1.6, -4.8, 1.6, '#ede9d6', 0.48);
        g.restore();
    }
    if (scale >= 1.2) {
        const first = bays[0], last = bays.at(-1);
        const middle = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, angle: first.angle };
        const label = corner(middle, 0, -5.2);
        g.save(); g.translate(label.x, label.y); g.rotate(first.angle);
        g.font = '600 2.1px system-ui, sans-serif';
        g.fillStyle = '#ede9d6b5'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('DROP OFF · PICK UP', 0, 0, 32); g.restore();
    }
    if (portal && visible(portal, 8)) {
        // Passengers use station access here. They enter the access passage
        // before appearing on the platform, rather than walking over tracks.
        g.save(); g.translate(portal.x, portal.y); g.rotate(bays[0].angle);
        rounded(g, -2.5, -2, 5, 4, 0.7, '#e7e2cd');
        rounded(g, -1.9, -1.4, 3.8, 2.8, 0.4, '#536f71');
        line(g, -1.6, -1.1, 1.5, -1.1, '#e9cf65', 0.55);
        line(g, -1.7, 1.2, 1.7, 1.2, '#b9c6bd', 0.5);
        g.restore();
    }
    g.restore();
}

function actorId(id) {
    if (Number.isFinite(id)) return id;
    let hash = 0;
    for (const character of String(id || 'station')) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    return hash;
}

function drawLuggage(g, pose, person, time) {
    const id = actorId(person.id);
    if (person.luggage === false || person.luggage === undefined && id % 3 === 0) return;
    const stride = pose.moving ? Math.sin(time * 6 + id) * 0.18 : 0;
    g.save(); g.translate(pose.x, pose.y); g.rotate(pose.angle); g.scale(0.5, 0.5);
    line(g, -1.5, 2.3, -4.2, 3.2, '#d2a986', 0.65);
    rounded(g, -7 + stride, 2.1, 3.1, 2.3, 0.6, id % 2 ? '#a98365' : '#547077');
    line(g, -6.1 + stride, 2.6, -4.8 + stride, 2.6, '#e6d4b5', 0.35);
    circle(g, -6.5 + stride, 4.5, 0.3, '#40514d');
    circle(g, -4.3 + stride, 4.5, 0.3, '#40514d'); g.restore();
}

export function drawStationPassengers(g, town, time, widthFactor, layer,
    visible = () => true, alpha = 1) {
    const passengers = town.stationVisits?.passengers;
    if (!passengers) return;
    const values = passengers instanceof Map ? passengers.values() : passengers;
    for (const person of values) {
        const pose = stationPassengerPose(town, person, widthFactor, alpha);
        if (!pose || pose.visible === false || (pose.layer || 0) !== layer || !visible(pose, 7)) continue;
        const moving = !!pose.moving;
        const actor = { ...person, id: actorId(person.id), colour: person.colour || DEFAULT_COLOUR,
            speed: person.speed || 1.3, pause: moving ? 0 : 1,
            state: moving ? 'walking' : 'crossing_wait' };
        g.save();
        if (Number.isFinite(pose.opacity)) g.globalAlpha = pose.opacity;
        drawPedestrian(g, actor, pose, time);
        drawLuggage(g, { ...pose, moving }, person, time);
        g.restore();
    }
}
