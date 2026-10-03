import { rounded, line, circle, trace, strokePath, tree, building, drawVehicle } from './miniature-art.mjs';
import { randomSource, pathPoint, position, laneOffset, isSignal, realVehiclePose, roadWidthFactor } from './real-town.mjs';
import { drawCyclist } from './real-cyclists.mjs';
import { pedestrianPose, drawPedestrian, drawPedestrianCrossings } from './real-pedestrians.mjs';
import { captureMotion, sampleVehicleDistance, sampleMotionTime } from './render-motion.mjs';
import { drawTrains } from './railway.mjs';
import { drawCanalBoats, drawCanalLocks } from './canal-boat-art.mjs';
import { drawBusStops } from './real-bus-art.mjs';
import { drawStationArea, drawStationPassengers } from './station-art.mjs';
import { drawJourneyGroups } from './journey-art.mjs';

export class RealMapRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.scenery = document.createElement('canvas');
        this.bridges = new Map();
        this.lastVehiclePoses = new Map();
        this.cachePadding = 160;
        this.cacheView = null;
        this.caching = false;
    }
    captureMotion(town) { captureMotion(town); }
    hitTest(point, radiusWorld) {
        const x = point.x ?? point[0], y = point.y ?? point[1];
        let nearest = null, distance = radiusWorld;
        for (const { car, p } of this.lastVehiclePoses.values()) {
            if (!this.visible(p)) continue;
            const d = Math.hypot(p.x - x, p.y - y);
            if (d <= distance) { nearest = car; distance = d; }
        }
        return nearest;
    }
    resize() {
        const dpr = Math.min(devicePixelRatio || 1, 2);
        if (this.dpr === dpr && this.viewportWidth === innerWidth && this.viewportHeight === innerHeight) return;
        this.dpr = dpr; this.viewportWidth = innerWidth; this.viewportHeight = innerHeight;
        this.canvas.width = Math.round(innerWidth * dpr);
        this.canvas.height = Math.round(innerHeight * dpr);
        this.scenery.width = Math.ceil((innerWidth + this.cachePadding * 2) * dpr);
        this.scenery.height = Math.ceil((innerHeight + this.cachePadding * 2) * dpr);
        this.cacheView = null;
    }
    needsCache(view, roadSize, town = this.town) {
        this.view = view;
        const cached = this.cacheView;
        return !cached || town !== this.town || roadSize !== this.roadSize || cached.scale !== view.scale ||
            this.viewportWidth !== innerWidth || this.viewportHeight !== innerHeight ||
            this.dpr !== Math.min(devicePixelRatio || 1, 2) ||
            Math.abs(view.x - cached.x) * view.scale >= this.cachePadding ||
            Math.abs(view.y - cached.y) * view.scale >= this.cachePadding;
    }
    transform(g) {
        const { x, y, scale } = this.caching ? this.cacheView : this.view;
        const padding = this.caching ? this.cachePadding : 0;
        g.setTransform(this.dpr * scale, 0, 0, this.dpr * scale,
            this.dpr * (innerWidth / 2 + padding - x * scale), this.dpr * (innerHeight / 2 + padding - y * scale));
    }
    visible(p, margin = 30) {
        if (this.caching) margin += this.cachePadding / this.view.scale;
        return Math.abs(p.x - this.view.x) < innerWidth / this.view.scale / 2 + margin &&
            Math.abs(p.y - this.view.y) < innerHeight / this.view.scale / 2 + margin;
    }
    inView(b, margin = 40) {
        if (this.caching) margin += this.cachePadding / this.view.scale;
        return b.right + margin > this.view.x - innerWidth / this.view.scale / 2 &&
            b.left - margin < this.view.x + innerWidth / this.view.scale / 2 &&
            b.bottom + margin > this.view.y - innerHeight / this.view.scale / 2 &&
            b.top - margin < this.view.y + innerHeight / this.view.scale / 2;
    }
    factor(road) { return roadWidthFactor(road, this.roadSize); }
    width(road) { return road.baseWidth * this.factor(road); }
    roadPath(g, road, colour, width) {
        const points = road.path.points;
        g.beginPath(); g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) {
            const a = points[i - 1], p = points[i], b = points[i + 1];
            const before = Math.hypot(p.x - a.x, p.y - a.y), after = Math.hypot(b.x - p.x, b.y - p.y);
            // Tiny fillets soften surveyed polyline corners inside the widened
            // road surface; topology and all simulation coordinates stay exact.
            const radius = Math.min(4, before * 0.25, after * 0.25);
            g.lineTo(p.x + (a.x - p.x) * radius / (before || 1), p.y + (a.y - p.y) * radius / (before || 1));
            g.quadraticCurveTo(p.x, p.y, p.x + (b.x - p.x) * radius / (after || 1), p.y + (b.y - p.y) * radius / (after || 1));
        }
        g.lineTo(points.at(-1).x, points.at(-1).y); g.strokeStyle = colour; g.lineWidth = width; g.stroke();
    }
    drawContext(g, layer) {
        for (const item of this.map.context) {
            if (item.layer !== layer || !this.inView(item.bounds)) continue;
            if (item.tags.waterway) {
                const width = item.tags.waterway === 'stream' ? 4 : 9;
                strokePath(g, item.path, '#9abc9c', width + 6);
                strokePath(g, item.path, '#8abcbc', width);
                strokePath(g, item.path, '#bdd9cc', 0.7);
                if (item.tags.waterway === 'canal') {
                    const side = item.tags.towpath === 'left' ? 1 : -1;
                    const towpath = { points: item.path.points.map(p => ({ x: p.x + Math.sin(p.angle) * 8 * side, y: p.y - Math.cos(p.angle) * 8 * side })) };
                    strokePath(g, towpath, '#e2dfbe', 2.4);
                    for (let distance = 12; distance < item.path.length; distance += 32) {
                        const p = pathPoint(item.path, distance);
                        g.save(); g.translate(p.x, p.y); g.rotate(p.angle);
                        line(g, -2, -1.8, 3, -1.8, '#c1dcd04d', 0.55);
                        line(g, 1, 1.3, 5, 1.3, '#d5e7d666', 0.55); g.restore();
                    }
                    if (item.tags.lock === 'yes') {
                        strokePath(g, item.path, '#6e7161', 10.5);
                        strokePath(g, item.path, '#7ba7a8', 8);
                    }
                }
            } else {
                strokePath(g, item.path, '#b9b7a3', 4);
                g.setLineDash([1.3, 3.5]);
                strokePath(g, item.path, '#7c8179', 4);
                g.setLineDash([]);
                strokePath(g, item.path, '#e9e2d1', 1.5);
                strokePath(g, item.path, '#6c7772', 0.7);
            }
        }
    }
    drawRoads(g, layer) {
        const roads = this.map.roads.filter(r => r.layer === layer && this.inView(r.bounds)).sort((a, b) => a.baseWidth - b.baseWidth);
        g.lineCap = layer > 0 ? 'butt' : 'round'; g.lineJoin = 'round';
        for (const extra of [7.5, 6, 0]) for (const road of roads) {
            this.roadPath(g, road, extra === 7.5 ? layer > 0 ? '#526a5c' : '#a8b89c' : extra === 6 ? '#e9e3d4' : road.colour, this.width(road) + extra);
        }
        for (const road of roads) {
            if (road.type === 'residential') continue;
            const count = road.lanes;
            for (let lane = 1; lane < count; lane++) {
                const offset = (lane - count / 2) * 3.3 * this.factor(road);
                const points = road.path.points.map(p => ({ x: p.x + Math.sin(p.angle) * offset, y: p.y - Math.cos(p.angle) * offset }));
                g.setLineDash([4.5, 6]);
                g.beginPath(); trace(g, points); g.strokeStyle = '#dfe2d0'; g.lineWidth = 0.7; g.stroke();
                g.setLineDash([]);
            }
        }
        for (const node of Object.values(this.map.data.nodes)) {
            const p = { x: node.p[0], y: node.p[1] };
            if (!this.visible(p)) continue;
            const incoming = this.town.simulation.incoming.get(node.id) || [];
            const approach = incoming.find(e => this.map.roadById.get(e.way).layer === layer);
            if (!approach) continue;
            if (node.tags.highway === 'mini_roundabout') {
                circle(g, p.x, p.y, 2.6 * this.roadSize, '#f0ead5');
                circle(g, p.x, p.y, 2.1 * this.roadSize, '#e5e3ce');
            }
            for (const edge of incoming) {
                const road = this.map.roadById.get(edge.way);
                if (road.layer !== layer) continue;
                const signal = this.town.simulation.signal(edge) !== 'none';
                const giveway = node.tags.highway === 'give_way' || node.tags.highway === 'mini_roundabout';
                if (!signal && !giveway) continue;
                const end = position(edge, edge.length), offset = laneOffset(edge, 0) * this.factor(road);
                g.save(); g.translate(end.x + end.dy * offset, end.y - end.dx * offset); g.rotate(Math.atan2(end.dy, end.dx));
                if (signal) {
                    line(g, -1, -3, -1, 3, '#f1edda', 0.9);
                    if (node.tags.highway === 'crossing') for (let stripe = -3; stripe < 4; stripe += 1.5) {
                        g.fillStyle = '#ece9d8'; g.fillRect(2, stripe, 3, 0.7);
                    }
                } else {
                    g.setLineDash([1.5, 1.5]);
                    for (const x of [-1, -3]) line(g, x, -3, x, 3, '#efe9d5', 0.7);
                    g.setLineDash([]);
                }
                g.restore();
            }
        }
    }
    cache(town, scenery, view, roadSize) {
        // Panning and vehicle following reuse a generously padded drawing. The
        // captured camera must be a copy: MapCamera mutates its live view.
        if (!this.needsCache(view, roadSize, town) && scenery === this.decoration) return false;
        this.resize();
        Object.assign(this, { town, map: town.map, decoration: scenery, view, roadSize });
        this.cacheView = { ...view };
        town.walking.widthFactor = roadSize;
        const oldBridges = this.bridges;
        this.bridges = new Map();
        const g = this.scenery.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#cbdab8'; g.fillRect(0, 0, this.scenery.width, this.scenery.height);
        this.caching = true;
        try { this.paintScenery(g, oldBridges); }
        finally { this.caching = false; }
        return true;
    }
    paintScenery(g, oldBridges) {
        const { town, decoration: scenery, roadSize } = this;
        this.transform(g); g.lineCap = 'round'; g.lineJoin = 'round'; g.setLineDash([]);
        for (const school of scenery.schools) {
            g.beginPath(); trace(g, school.polygon); g.closePath(); g.fillStyle = '#bcd0a4'; g.fill();
            g.strokeStyle = '#91ad82'; g.lineWidth = 1.5; g.stroke();
            const cx = school.outline.reduce((sum, p) => sum + p[0], 0) / school.outline.length;
            const cy = school.outline.reduce((sum, p) => sum + p[1], 0) / school.outline.length;
            g.save(); g.translate(cx, cy); g.rotate(-0.2);
            rounded(g, -25, -40, 50, 80, 1, null, '#e6e9ca');
            line(g, -25, 0, 25, 0, '#e6e9ca', 1);
            g.restore();
        }
        for (const house of scenery.buildings) {
            if (!this.visible(house, 40)) continue;
            const random = randomSource(house.seed);
            const curb = this.width(house.road) / 2 + 2;
            const dx = house.x - house.curb.x, dy = house.y - house.curb.y, length = Math.hypot(dx, dy);
            line(g, house.curb.x + dx / length * curb, house.curb.y + dy / length * curb, house.x, house.y, '#e8e2cc', 2.5);
            g.save(); g.translate(house.x, house.y); g.rotate(house.angle);
            rounded(g, -house.w / 2 - 5, -house.h / 2 - 4, house.w + 10, house.h + 8, 3, '#d3dfbe');
            line(g, -house.w / 2 - 3, -house.h / 2 - 3, house.w / 2 + 3, -house.h / 2 - 3, '#9eaf8299', 1.2);
            for (let i = 0; i < 3; i++) {
                const x = -house.w / 2 - 2 + i * 2.1, y = house.h / 2 + 2;
                circle(g, x, y, 1.1, '#8fa66d');
                circle(g, x - 0.2, y - 0.25, 0.5, house.shop ? '#dfad72' : '#e4c598');
            }
            g.scale(0.5, 0.5);
            building(g, -house.w, -house.h, house.w * 2, house.h * 2, random, house.shop);
            g.restore();
        }
        for (const t of scenery.trees) {
            if (!this.visible(t, 10)) continue;
            g.save(); g.translate(t.x, t.y); g.scale(0.5, 0.5); tree(g, 0, 0, t.radius * 2, randomSource(t.seed)); g.restore();
        }
        this.layers = [...new Set([...this.map.roads, ...this.map.context].map(r => r.layer))].sort((a, b) => a - b);
        for (const layer of this.layers) {
            this.drawContext(g, layer); this.drawRoads(g, layer);
            drawPedestrianCrossings(g, town, roadSize, layer);
            drawBusStops(g, town, roadSize, layer, (p, margin) => this.visible(p, margin), this.view.scale);
            drawStationArea(g, town, roadSize, layer, (p, margin) => this.visible(p, margin), this.view.scale);
            if (layer > 0) {
                const overlay = oldBridges.get(layer) || document.createElement('canvas');
                if (overlay.width !== this.scenery.width) overlay.width = this.scenery.width;
                if (overlay.height !== this.scenery.height) overlay.height = this.scenery.height;
                const paint = overlay.getContext('2d');
                paint.setTransform(1, 0, 0, 1, 0, 0); paint.clearRect(0, 0, overlay.width, overlay.height);
                this.transform(paint); paint.lineCap = 'round'; paint.lineJoin = 'round';
                this.drawContext(paint, layer); this.drawRoads(paint, layer);
                drawPedestrianCrossings(paint, town, roadSize, layer);
                drawBusStops(paint, town, roadSize, layer, (p, margin) => this.visible(p, margin), this.view.scale);
                drawStationArea(paint, town, roadSize, layer, (p, margin) => this.visible(p, margin), this.view.scale);
                this.bridges.set(layer, overlay);
            }
        }
    }
    drawCached(g, canvas) {
        const scale = this.view.scale;
        const x = ((this.cacheView.x - this.view.x) * scale - this.cachePadding) * this.dpr;
        const y = ((this.cacheView.y - this.view.y) * scale - this.cachePadding) * this.dpr;
        g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(canvas, x, y);
    }
    drawLabels(g) {
        if (this.view.scale < 0.4) {
            // At village scale, a handful of horizontal anchors stay readable
            // without turning the miniature into a dense labelled street map.
            const names = { village: 'KINGS LANGLEY', station: 'Kings Langley station', j20: 'M25 · Junction 20' };
            const boxes = [];
            for (const landmark of this.map.landmarks) {
                const name = names[landmark.id];
                if (!name) continue;
                const p = { x: landmark.p[0], y: landmark.p[1] };
                if (!this.visible(p, -50 / this.view.scale)) continue;
                if (boxes.some(other => Math.abs(p.x - other.x) * this.view.scale < 130 && Math.abs(p.y - other.y) * this.view.scale < 35)) continue;
                boxes.push(p);
                g.save(); g.translate(p.x, p.y); g.scale(1 / this.view.scale, 1 / this.view.scale);
                circle(g, 0, 0, 3.4, '#fff7e7'); circle(g, 0, 0, 1.7, '#52725d');
                g.textAlign = 'center'; g.textBaseline = 'bottom';
                g.font = `${landmark.id === 'village' ? 750 : 600} ${landmark.id === 'village' ? 11 : 10}px system-ui, sans-serif`;
                g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = '#e5ebd4'; g.strokeText(name, 0, -9);
                g.fillStyle = '#3f604b'; g.fillText(name, 0, -9); g.restore();
            }
            return;
        }
        const boxes = [], drawn = new Set();
        for (const road of this.map.roads.filter(r => r.tags.name && this.inView(r.bounds)).sort((a, b) => b.baseWidth - a.baseWidth)) {
            const name = road.tags.name;
            if (drawn.has(name) || road.tags.highway === 'service') continue;
            const p = pathPoint(road.path, road.path.length / 2);
            if (!this.visible(p, -65 / this.view.scale)) continue;
            if (boxes.some(b => Math.abs(b.x - p.x) * this.view.scale < 105 && Math.abs(b.y - p.y) * this.view.scale < 22)) continue;
            if (this.view.scale < 0.7 && road.type === 'residential') continue;
            boxes.push(p); drawn.add(name);
            g.save(); g.translate(p.x, p.y);
            let angle = p.angle; if (Math.cos(angle) < 0) angle += Math.PI;
            g.rotate(angle);
            g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `600 ${9 / this.view.scale}px system-ui, sans-serif`;
            g.lineWidth = 3 / this.view.scale; g.strokeStyle = road.colour; g.strokeText(name, 0, 0);
            g.fillStyle = '#eeeedd'; g.fillText(name, 0, 0); g.restore();
        }
        for (const landmark of this.map.landmarks.filter(l => ['station', 'common', 'love'].includes(l.id))) {
            const p = { x: landmark.p[0], y: landmark.p[1] };
            if (!this.visible(p, -40)) continue;
            const name = landmark.id === 'station' ? 'KINGS LANGLEY STATION' : landmark.id === 'common' ? 'PRIMARY SCHOOL' : 'KINGS LANGLEY SCHOOL';
            g.font = `600 ${9 / this.view.scale}px system-ui`; g.textAlign = 'center';
            g.lineWidth = 4 / this.view.scale; g.strokeStyle = '#e4e9cf'; g.strokeText(name, p.x, p.y - 14 / this.view.scale);
            g.fillStyle = '#567461'; g.fillText(name, p.x, p.y - 14 / this.view.scale);
        }
    }
    drawTrip(g, trip, layer) {
        const scale = this.view.scale;
        let routeDistance = 0;
        const spacing = 76 / scale;
        g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
        for (const edge of trip.edges) {
            if (this.map.roadById.get(edge.way).layer !== layer) { routeDistance += edge.length; continue; }
            const path = { points: edge.points.map(([x, y]) => ({ x, y })) };
            strokePath(g, path, '#fff8e9', 6 / scale);
            strokePath(g, path, '#3287a0', 3.5 / scale);
            // Small static arrows give a route direction, including on a paused
            // map, while leaving the actual moving vehicles easy to follow.
            const first = Math.ceil((routeDistance + spacing / 2) / spacing) * spacing - spacing / 2;
            for (let at = first; at < routeDistance + edge.length; at += spacing) {
                const p = position(edge, at - routeDistance);
                g.save(); g.translate(p.x, p.y); g.rotate(Math.atan2(p.dy, p.dx)); g.scale(1 / scale, 1 / scale);
                g.beginPath(); g.moveTo(-2, -2); g.lineTo(0, 0); g.lineTo(-2, 2);
                g.strokeStyle = '#fff8e9'; g.lineWidth = 1.1; g.stroke(); g.restore();
            }
            routeDistance += edge.length;
        }
        g.restore();
    }
    drawSelection(g, vehicle) {
        const { car, p } = vehicle, scale = this.view.scale;
        const rx = Math.max(11 / scale, car.length * 0.7 + 4 / scale);
        const ry = Math.max(11 / scale, car.width * this.factor(p.road) * 0.7 + 4 / scale);
        g.save(); g.translate(p.x, p.y); g.rotate(p.angle);
        g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        g.strokeStyle = '#fff9e9'; g.lineWidth = 4 / scale; g.stroke();
        g.strokeStyle = '#337a74'; g.lineWidth = 1.7 / scale; g.stroke(); g.restore();
    }
    render({ planning = false, origin = null, destination = null, trip = null, alpha = 1, paused = false, selectedVehicleId = null } = {}) {
        const g = this.ctx, s = this.town.simulation;
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.canvas.width, this.canvas.height); this.drawCached(g, this.scenery);
        const time = sampleMotionTime(this.town, alpha, paused);
        this.lastVehiclePoses.clear();
        for (const car of s.cars) {
            const q = sampleVehicleDistance(this.town, car, alpha, paused);
            const rendered = q === car.q ? car : { ...car, q };
            this.lastVehiclePoses.set(car.id, { car, rendered, p: realVehiclePose(this.town, rendered, this.roadSize, paused ? 1 : alpha) });
        }
        const cars = [...this.lastVehiclePoses.values()].filter(({ p }) => this.visible(p));
        const people = this.town.people.map(person => ({ person, pose: pedestrianPose(this.town, person, this.roadSize) })).filter(({ pose }) => pose && this.visible(pose));
        for (const layer of this.layers) {
            if (this.bridges.has(layer)) this.drawCached(g, this.bridges.get(layer));
            this.transform(g);
            drawCanalLocks(g, this.town.boats || [], time, layer, p => this.visible(p, 50));
            drawCanalBoats(g, this.town.boats || [], time, layer, p => this.visible(p, 50));
            drawTrains(g, this.town.trains || [], time, layer, p => this.visible(p, 50));
            if (planning) for (const road of this.map.roads) {
                if (road.layer !== layer || !this.inView(road.bounds)) continue;
                strokePath(g, road.path, road.mapColour, road.type === 'arterial' ? 1.4 : 0.65);
            }
            if (trip) this.drawTrip(g, trip, layer);
            g.save(); g.scale(0.5, 0.5);
            for (const { car, p } of cars) {
                if (p.road.layer !== layer || car.type === 'bicycle') continue;
                if (car.parked && !car.stationVisit && !s.parking.managesMotion?.(car)) continue;
                const bus = car.type === 'bus';
                const current = this.map.data.edges[car.route[car.index]], next = this.map.data.edges[car.route[car.index + 1]];
                let indicator = s.parking.indicator?.(car) || (car.turnaround ? 1 : car.busPass?.phase === 'out' ? 1 : car.busPass?.phase === 'return' ? -1 : 0);
                if (!indicator && next && current.length - car.d < 35) {
                    const a = position(current, current.length), b = position(next, 0);
                    const angle = Math.atan2(a.dx * b.dy - a.dy * b.dx, a.dx * b.dx + a.dy * b.dy);
                    if (Math.abs(angle) > 0.35) indicator = Math.sign(angle);
                }
                drawVehicle(g, { bus, type: car.type, length: car.length * 2, width: car.width * (p.station ? 1 : this.factor(p.road)) * 2,
                    colour: bus ? car.busStyle.colour : car.paint, route: car.busStyle, braking: car.v < 1, dwell: car.roadStop?.remaining || 0,
                    indicator, reversing: car.turnaround?.reversing || car.parkingActivity?.reversing },
                    { x: p.x * 2, y: p.y * 2, angle: p.angle }, time);
            }
            g.restore();
            for (const { car, rendered, p } of cars) {
                if (car.type === 'bicycle' && p.road.layer === layer) drawCyclist(g, rendered, p, time, this.factor(p.road));
            }
            for (const { person, pose } of people) {
                if ((pose.layer || 0) === layer) drawPedestrian(g, person, pose, time);
            }
            drawStationPassengers(g, this.town, time, this.roadSize, layer, p => this.visible(p, 10), paused ? 1 : alpha);
            drawJourneyGroups(g, this.town, time, this.roadSize, layer, p => this.visible(p, 10), paused ? 1 : alpha);
        }
        this.transform(g);
        for (const zone of s.parking.zones) {
            const slots = s.parking.visibleSlots?.(zone) || [...Array.from({ length: zone.baseline }, (_, slot) => ({ slot })),
                ...[...zone.parked.values()].map(car => ({ slot: car.parked.slot, car }))];
            for (const item of slots) {
                const slot = item.slot;
                if (item.car && s.parking.managesMotion?.(item.car)) continue;
                const raw = s.parking.parkedPosition(zone, slot);
                const road = this.map.roadById.get(raw.edge.way);
                const p = s.parking.parkedPosition(zone, slot, this.factor(road));
                if (!this.visible(p)) continue;
                g.save(); g.translate(p.x, p.y); g.scale(0.5, 0.5);
                const colours = ['#8b9290', '#eee5d4', '#426e82', '#b96851', '#c6a357', '#55766a'];
                drawVehicle(g, { length: (item.car?.length || item.length || p.length) * 2, width: (item.car?.width || item.width || 1.8) * this.factor(road) * 2,
                    colour: item.car?.paint || item.colour || colours[(slot + zone.id.length) % colours.length], bus: false, braking: false },
                    { x: 0, y: 0, angle: item.angle ?? Math.atan2(p.dy, p.dx) + (item.direction === -1 ? Math.PI : 0) }, time); g.restore();
            }
        }
        for (const node of Object.values(this.map.data.nodes)) {
            if (!isSignal(node.tags) || !this.visible({ x: node.p[0], y: node.p[1] })) continue;
            const edge = (s.incoming.get(node.id) || []).find(e => s.signal(e) !== 'none');
            if (!edge) continue;
            const state = s.signal(edge), p = position(edge, edge.length), road = this.map.roadById.get(edge.way);
            const offset = this.width(road) / 2 + 3;
            g.save(); g.translate(p.x + p.dy * offset, p.y - p.dx * offset); g.scale(0.5, 0.5);
            rounded(g, -5, -11, 10, 23, 3, '#35484a', '#8c9a87');
            for (const [i, colour] of ['red', 'amber', 'green'].entries()) circle(g, 0, -6 + i * 7, 2.5,
                state === colour ? { red: '#f47b65', amber: '#f6ca5b', green: '#9ad896' }[colour] : '#53605a');
            g.restore();
        }
        this.drawLabels(g);
        const selected = this.lastVehiclePoses.get(selectedVehicleId);
        if (selected && this.visible(selected.p)) this.drawSelection(g, selected);
        if (this.otherSelection && this.visible(this.otherSelection)) {
            const p = this.otherSelection, radius = 11 / this.view.scale;
            g.beginPath(); g.arc(p.x, p.y, radius, 0, Math.PI * 2);
            g.strokeStyle = '#fff9e9'; g.lineWidth = 4 / this.view.scale; g.stroke();
            g.strokeStyle = '#337a74'; g.lineWidth = 1.5 / this.view.scale; g.stroke();
        }
        if (planning) for (const [node, label] of [[origin, 'A'], [destination, 'B']]) {
            if (!node) continue;
            const radius = 11 / this.view.scale;
            circle(g, node.p[0], node.p[1], radius + 2 / this.view.scale, '#fff8e9'); circle(g, node.p[0], node.p[1], radius, '#2879a1');
            g.font = `bold ${11 / this.view.scale}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff8e9'; g.fillText(label, node.p[0], node.p[1]);
        }
    }
}
