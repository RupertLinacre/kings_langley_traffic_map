import { measure, pathPoint } from './street-geometry.mjs';
import { rounded, line } from './miniature-art.mjs';

const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.15;

// Keep the mapped track direction and bridge layer, including short bridge
// pieces. Never join a gap in the survey with an invented straight railway.
export function createRailway(map) {
    const trains = [];
    for (const [track, colour, speed] of [['Up Slow', '#477e73', 18], ['Down Fast', '#9b5c62', 27]]) {
        const remaining = new Set(map.context.filter(item => item.tags.railway === 'rail' && item.tags['railway:track_ref'] === track));
        const chains = [];
        while (remaining.size) {
            const first = [...remaining].find(item => ![...remaining].some(other => other !== item && same(other.points.at(-1), item.points[0]))) || [...remaining][0];
            const segments = []; let item = first, length = 0;
            while (item) {
                remaining.delete(item);
                const path = measure(item.points.map(([x, y]) => ({ x, y })));
                segments.push({ item, path, start: length, end: length + path.length });
                length += path.length;
                item = [...remaining].find(next => same(segments.at(-1).item.points.at(-1), next.points[0]));
            }
            chains.push({ segments, length });
        }
        const route = chains.sort((a, b) => b.length - a.length)[0];
        if (!route || route.length < 400) continue;
        const station = map.landmarks.find(place => place.id === 'station').p;
        let stop = 0, nearest = Infinity;
        for (let q = 0; q < route.length; q += 2) {
            const p = trackPoint(route, q), d = Math.hypot(p.x - station[0], p.y - station[1]);
            if (d < nearest) { nearest = d; stop = q; }
        }
        const local = track === 'Up Slow';
        trains.push({ id: track, route, colour, speed, local, stop, carriages: 4,
            // A local train starts just outside the station; an express starts
            // further north. Schedules are illustrative, not live train data.
            offset: local ? Math.max(0, stop / speed - 7) : route.length / speed * 0.4 });
    }
    return trains;
}

export function trackPoint(route, distance) {
    const segment = route.segments.find(part => distance <= part.end) || route.segments.at(-1);
    const p = pathPoint(segment.path, Math.max(0, distance - segment.start));
    return { ...p, layer: segment.item.layer, segment };
}

/** Timing constants shared by rendered train motion and station transfers. */
export function trainTiming(train) {
    const dwell = train.local ? 18 : 0, tail = train.carriages * 20;
    const brakingTime = 6;
    const cycle = (train.route.length + tail) / train.speed + dwell + (train.local ? brakingTime : 0) + 12;
    const arrival = train.stop / train.speed + brakingTime / 2;
    return { dwell, tail, brakingTime, cycle, arrival };
}

// Shared illustrative timetable: passenger journeys use these exact events,
// rather than a second clock that can drift away from the rendered train.
export function trainStationSchedule(train, time) {
    if (!train.local) return null;
    const timing = trainTiming(train);
    const index = Math.floor((time + train.offset - timing.arrival) / timing.cycle);
    const arrivalTime = timing.arrival - train.offset + index * timing.cycle;
    return { ...timing, index, arrivalTime, departureTime: arrivalTime + timing.dwell,
        nextArrival: arrivalTime + timing.cycle, stopped: time >= arrivalTime && time < arrivalTime + timing.dwell };
}

export function trainPose(train, time) {
    const { dwell, brakingTime, cycle, arrival } = trainTiming(train);
    const t = ((time + train.offset) % cycle + cycle) % cycle;
    const stopped = train.local && t >= arrival && t < arrival + dwell;
    let q = t * train.speed, speed = train.speed;
    if (train.local && t >= arrival - brakingTime) {
        if (t < arrival) {
            const remaining = arrival - t;
            q = train.stop - train.speed * remaining ** 2 / (2 * brakingTime);
            speed = train.speed * remaining / brakingTime;
        } else if (stopped) { q = train.stop; speed = 0; }
        else {
            const moving = t - arrival - dwell;
            q = train.stop + train.speed * (moving < brakingTime ? moving ** 2 / (2 * brakingTime) : moving - brakingTime / 2);
            speed = train.speed * Math.min(1, moving / brakingTime);
        }
    }
    return { ...trackPoint(train.route, Math.min(q, train.route.length)), q, stopped, speed };
}

export function drawTrains(g, trains, time, layer, visible) {
    for (const train of trains) {
        const head = trainPose(train, time);
        for (let i = 0; i < train.carriages; i++) {
            const q = head.q - i * 20;
            if (q < 0 || q > train.route.length) continue;
            const p = trackPoint(train.route, q);
            if (p.layer !== layer || !visible(p)) continue;
            g.save(); g.translate(p.x, p.y); g.rotate(p.angle);
            rounded(g, -9 + 0.7, -2.1 + 0.8, 18, 4.2, 1.5, '#33493635');
            rounded(g, -9, -2.1, 18, 4.2, 1.5, train.colour);
            rounded(g, -6.5, -1.6, 12.5, 3.2, 0.7, '#f3eee0');
            for (let x = -6; x < 7; x += 3) {
                line(g, x, -1.8, x + 1.4, -1.8, '#385c67', 0.65);
                line(g, x, 1.8, x + 1.4, 1.8, '#385c67', 0.65);
            }
            if (!i) {
                rounded(g, 6.5, -1.65, 1.3, 3.3, 0.5, '#345760');
                line(g, 8.5, -1.6, 8.5, 1.6, '#e9cf65', 0.7);
            }
            line(g, -9, 0, -11, 0, '#47534c', 0.8);
            g.restore();
        }
    }
}
