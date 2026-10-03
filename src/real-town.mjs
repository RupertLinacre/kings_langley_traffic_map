import { Simulation, findRoute, position, laneCount, laneOffset, isSignal } from './kings-langley/engine/simulation.mjs';
import { isCirculatory } from './kings-langley/engine/junction20.mjs';
import { measure, pathPoint } from './street-geometry.mjs';
import { attachCyclists, setCyclistCount, maintainCyclists } from './real-cyclists.mjs';
import { createPedestrians, setPedestrianCount, updatePedestrians, pedestrianTrafficLimit, pedestrianSpawnAllowed } from './real-pedestrians.mjs';
import { createRailway } from './railway.mjs';
import { createCanalBoats } from './canal-boats.mjs';
import { turnaroundPose, turnaroundFits, preferredRoadCost } from './kings-langley/engine/adaptive-traffic.mjs';
import { updateVillageVisits } from './village-visits.mjs';
import { attachBusServices, setBusTraffic, updateBusServices } from './real-buses.mjs';
import { attachStationVisits, resetStationTraffic, updateStationVisits, stationVehiclePose } from './station-visits.mjs';
import { attachVillageDay, updateVillageDay } from './village-day.mjs';
import { attachPurposefulJourneys, updatePurposefulJourneys, resetPurposefulJourneys } from './purposeful-journeys.mjs';
import { fireEngineObstacles } from './fire-engine.mjs';
export { position, laneCount, laneOffset, isSignal, isCirculatory, pathPoint };
export { setCyclistCount, setPedestrianCount };
export const BUS_STYLES = [
    { number: '322', colour: '#258b8a' }, { number: '501', colour: '#cf5249' },
    { number: 'H19', colour: '#cf5249' }, { number: 'R9', colour: '#cf5249' }, { number: 'KL80', colour: '#cf5249' },
];
const CAR_COLOURS = ['#efe9d9', '#537d9b', '#d68563', '#e4b94f', '#718978', '#a7b9bc', '#49556a'];
export function randomSource(seed) {
    return () => { seed = Math.imul(1664525, seed) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
}
export function roadStyle(tags) {
    if (/motorway|trunk/.test(tags.highway)) return { type: 'arterial', colour: '#5d6c72', mapColour: '#d0a34e', size: 1 };
    if (tags.highway === 'primary') return { type: 'arterial', colour: '#637477', mapColour: '#d0a34e', size: 1.08 };
    if (/tertiary|secondary/.test(tags.highway)) return { type: 'collector', colour: '#71817f', mapColour: '#8eb4ad', size: 1 };
    return { type: 'residential', colour: '#82908c', mapColour: '#d7decb', size: tags.highway === 'service' ? 0.85 : 0.96 };
}
export function measured(points) {
    return measure(points.map(([x, y], i) => {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        return { x, y, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }));
}
export function bounds(points) {
    return { left: Math.min(...points.map(p => p[0])), top: Math.min(...points.map(p => p[1])),
        right: Math.max(...points.map(p => p[0])), bottom: Math.max(...points.map(p => p[1])) };
}
export function roadWidthFactor(road, size) { return Math.min(size * road.size, road.widthCap || Infinity); }
export function prepareMap(data) {
    const edgesByWay = new Map();
    for (const edge of data.edges) {
        if (!edgesByWay.has(edge.way)) edgesByWay.set(edge.way, []);
        edgesByWay.get(edge.way).push(edge);
    }
    const roads = data.ways.filter(way => edgesByWay.has(way.id)).map(way => {
        const edges = edgesByWay.get(way.id);
        const directions = new Set(edges.map(e => e.forward));
        const forward = Math.max(0, ...edges.filter(e => e.forward).map(laneCount));
        const backward = Math.max(0, ...edges.filter(e => !e.forward).map(laneCount));
        return { ...way, ...roadStyle(way.tags), path: measured(way.points), edges,
            baseWidth: (forward + backward) * 3.3, lanes: forward + backward, twoWay: directions.size > 1,
            layer: Number(way.tags.layer) || (way.tags.bridge && way.tags.bridge !== 'no' ? 1 : 0), bounds: bounds(way.points) };
    });
    // Separate mapped carriageways already have a real median between them.
    // Limit lateral exaggeration there so opposite directions remain legible.
    const divided = roads.filter(r => r.oneway && ['motorway', 'trunk'].includes(r.tags.highway) && !isCirculatory(r.tags));
    for (const road of divided) {
        let cap = Infinity;
        for (const fraction of [0.2, 0.5, 0.8]) {
            const p = pathPoint(road.path, road.path.length * fraction);
            for (const other of divided) {
                if (other === road || other.tags.ref !== road.tags.ref) continue;
                for (let i = 1; i < other.points.length; i++) {
                    const a = other.points[i - 1], b = other.points[i], dx = b[0] - a[0], dy = b[1] - a[1];
                    if (Math.cos(p.angle - Math.atan2(dy, dx)) > -0.94) continue;
                    const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
                    const distance = Math.hypot(p.x - a[0] - dx * t, p.y - a[1] - dy * t);
                    if (distance < 45) cap = Math.min(cap, distance * 0.95 / ((road.baseWidth + other.baseWidth) / 2));
                }
            }
        }
        road.widthCap = Math.max(1, cap);
    }
    // The station forecourt sits beside the railway. Keep this short approach
    // narrow enough for its off-road pickup bays and the platform access.
    const stationForecourt = roads.find(road => road.id === 233961901);
    if (stationForecourt) stationForecourt.widthCap = 1.25;
    const roadById = new Map(roads.map(road => [road.id, road]));
    const mapBounds = bounds(roads.flatMap(r => r.points));
    const station = data.places.find(p => p.station && p.name === 'Kings Langley');
    const landmarks = [
        { id: 'village', name: 'High Street', p: [-294, -111], zoom: 100 },
        { id: 'station', name: 'Kings Langley station', p: station.p, zoom: 90 },
        { id: 'common', name: 'Common Lane · primary school', p: [-787, -592], zoom: 100 },
        { id: 'love', name: 'Love Lane · secondary school', p: [-1046, -487], zoom: 100 },
        { id: 'j20', name: 'M25 junction 20', p: [140, 1210], zoom: 95 },
        { id: 'coniston', name: 'Coniston Road · parked cars', p: [-539, -879], zoom: 115 },
        { id: 'vicarage', name: 'Vicarage Lane · taking turns', p: [-652, -266], zoom: 115 },
    ];
    // The motorway passes underneath the centre of J20. The route-planner
    // destination belongs to the circulatory road, not to that crossing line.
    const ring = data.edges.filter(e => e.tags.name === 'Kings Langley Interchange' && isCirculatory(e.tags));
    const junction = landmarks.find(l => l.id === 'j20');
    junction.nodeId = ring.reduce((best, edge) => Math.hypot(...data.nodes[edge.from].p.map((v, i) => v - junction.p[i])) <
        Math.hypot(...data.nodes[best.from].p.map((v, i) => v - junction.p[i])) ? edge : best).from;
    return { data, roads, roadById, bounds: mapBounds, landmarks,
        context: data.context.map(item => ({ ...item, path: measured(item.points), bounds: bounds(item.points), layer: Number(item.tags.layer) || 0 })) };
}

// Longer miniature bodies preserve the proportions of the original artwork.
// Their enlarged lengths are used by the physics as well as by the renderer.
export class MiniatureSimulation extends Simulation {
    createVehicle(path, type = 'car', distance = 0, lane = 0, profile = null) {
        // The restored Toms Lane underpass has a 10 ft 9 in clearance.
        // Demand's global bus share must not turn its car journeys into buses.
        const lowBus = type === 'bus' && profile?.height > 0 && profile.height <= 3.2766;
        if (['bus', 'lorry'].includes(type) && !lowBus && path.some(id => this.data.edges[id].restoredUnderpass)) type = 'car';
        const car = super.createVehicle(path, type, distance, lane);
        if (profile && car.type === 'bus') {
            car.height = profile.height;
            car.length = profile.length || car.length;
            car.width = profile.width || car.width;
        }
        car.length *= car.type === 'bicycle' ? 1 : car.type === 'car' ? 2.1 : car.type === 'bus' ? 1.45 : car.type === 'van' ? 1.6 : 1.2;
        car.minGap *= 1.35;
        car.paint = CAR_COLOURS[car.id % CAR_COLOURS.length];
        car.busStyle = BUS_STYLES[car.route[0] % BUS_STYLES.length];
        return car;
    }
}
export function createRealTown(map, demand, seed, { cyclists = 24, pedestrians = 140, period = 'everyday', initialMinutes } = {}) {
    const simulation = new MiniatureSimulation(map.data, seed, demand);
    simulation.maxVehicles = 2000;
    simulation.busShare = 0;
    simulation.setPopularity(3);
    const town = { map, simulation, seed, trafficLevel: 1, baseTraffic: 250, metrics: null, metricClock: -1 };
    attachVillageDay(town, { period, initialMinutes });
    town.trains = createRailway(map);
    town.boats = createCanalBoats(map, seed);
    attachBusServices(town);
    attachCyclists(town, cyclists);
    createPedestrians(town, seed);
    setPedestrianCount(town, pedestrians);
    attachStationVisits(town);
    simulation.emergency.setPoseProvider(car => {
        const p = realVehiclePose(town, car, town.walking.widthFactor);
        const factor = roadWidthFactor(p.road, town.walking.widthFactor);
        return { ...p, length: car.length, width: car.width * factor,
            roadHalfWidth: p.road.baseWidth * factor / 2, layer: p.road.layer, widthFactor: factor };
    });
    simulation.emergency.setObstacleProvider(() => fireEngineObstacles(town, town.walking.widthFactor));
    simulation.crossingStop = (car, edge) => pedestrianTrafficLimit(town, car, edge);
    simulation.crossingSpawnAllowed = car => pedestrianSpawnAllowed(town, car) && simulation.adaptive.spawnAllowed(car) &&
        simulation.busOvertaking.spawnAllowed(car) && simulation.parking.spawnAllowed(car) && simulation.emergency.spawnAllowed(car);
    simulation.turnaroundAllowed = (car, edge, d, radius) =>
        !car.emergencyYield?.active && Math.abs(car.emergencyYield?.offset || 0) < 0.05 &&
        turnaroundFits(car, roadWidthFactor(map.roadById.get(edge.way), town.walking.widthFactor)) &&
        !town.walking.crossings.some(crossing => crossing.edgeDistances.has(edge.id) && Math.abs(crossing.edgeDistances.get(edge.id) - d) < radius + 8) &&
        simulation.emergency.corridorAllowed(edge, d - radius, d + radius, car.width * roadWidthFactor(map.roadById.get(edge.way), town.walking.widthFactor));
    simulation.busPassAllowed = (car, edge, from, to) =>
        !car.emergencyYield?.active && Math.abs(car.emergencyYield?.offset || 0) < 0.05 &&
        !town.walking.crossings.some(crossing => crossing.edgeDistances.has(edge.id) &&
            crossing.edgeDistances.get(edge.id) > from - 12 && crossing.edgeDistances.get(edge.id) < to + 12) &&
        simulation.emergency.corridorAllowed(edge, from - 12, to + 12, 4 * roadWidthFactor(map.roadById.get(edge.way), town.walking.widthFactor));
    simulation.parkingManoeuvreAllowed = (car, edge, d, radius) =>
        !car.emergencyYield?.active && Math.abs(car.emergencyYield?.offset || 0) < 0.05 &&
        !town.walking.crossings.some(crossing => crossing.edgeDistances.has(edge.id) &&
            Math.abs(crossing.edgeDistances.get(edge.id) - d) < radius + 3.5) &&
        simulation.emergency.corridorAllowed(edge, d - radius, d + radius, 4 * roadWidthFactor(map.roadById.get(edge.way), town.walking.widthFactor));
    simulation.parkingCorridorAllowed = (_car, edge, start, end) => {
        const road = map.roadById.get(edge.way);
        return simulation.emergency.corridorAllowed(edge, start, end,
            road.baseWidth * roadWidthFactor(road, town.walking.widthFactor) / 2 + 3);
    };
    simulation.parking.enableActivities?.(true);
    attachPurposefulJourneys(town);
    setRealTraffic(town, 1);
    updateRealMetrics(town);
    return town;
}
export function setRealTraffic(town, level) {
    if (!Number.isFinite(level)) return;
    town.trafficLevel = Math.max(0, Math.min(6, level));
    resetStationTraffic(town);
    if (town.trafficLevel === 0) resetPurposefulJourneys(town);
    if (town.trafficLevel === 0 && town.villageVisits) town.villageVisits.pending = [];
    const s = town.simulation, bicycles = s.cars.filter(c => c.type === 'bicycle');
    const motors = s.cars.filter(c => c.type !== 'bicycle');
    const target = Math.min(s.maxVehicles - bicycles.length, Math.round(town.baseTraffic * town.trafficLevel));
    if (target < motors.length) {
        const retain = new Set(motors.slice(0, target));
        s.cars = s.cars.filter(c => c.type === 'bicycle' || retain.has(c));
        const keep = new Set(s.cars.map(c => c.id));
        for (const [node, claims] of s.reservations) {
            const remaining = claims.filter(claim => keep.has(claim.car.id));
            if (remaining.length) s.reservations.set(node, remaining); else s.reservations.delete(node);
        }
        for (const zone of s.parking.zones) {
            for (const group of [zone.parked, zone.claims, zone.waiting]) for (const id of group.keys()) if (!keep.has(id)) group.delete(id);
            if (!zone.claims.size) { zone.direction = 0; zone.batch = 0; }
        }
    }
    // Lowering demand should also clear the old backlog instead of inserting
    // thousands of previously requested cars after the user empties the map.
    s.pending.clear(); s.pendingFleet.clear(); s.pendingTotal = 0;
    s.parking.setActivityDemand?.(town.trafficLevel);
    s.parking.releaseMissing?.();
    s.busOvertaking.releaseMissing();
    setBusTraffic(town, target > 0 ? town.trafficLevel : 0);
    if (target > s.cars.filter(car => car.type !== 'bicycle').length) s.seedCars(target + bicycles.length);
    updateRealMetrics(town);
}
export function updateRealTown(town, dt) {
    if (!(dt > 0)) return;
    const clock = updateVillageDay(town);
    updatePedestrians(town, dt);
    updateVillageVisits(town, dt);
    updateBusServices(town);
    updateStationVisits(town, dt);
    updatePurposefulJourneys(town, dt);
    town.simulation.step(dt, Math.min(4, town.trafficLevel * 0.65 * clock.demandFactor));
    maintainCyclists(town, dt);
    if (town.simulation.time - town.metricClock >= 0.5) updateRealMetrics(town);
}
export function updateRealMetrics(town) {
    const s = town.simulation, metrics = s.metrics();
    const motors = s.cars.filter(c => c.type !== 'bicycle' && !c.parked);
    const cyclists = s.cars.filter(c => c.type === 'bicycle').length;
    const waiting = motors.filter(c => c.v < 0.5).length, ratio = waiting / Math.max(1, motors.length);
    town.metrics = { ...metrics, cars: motors.length, waiting,
        meanSpeed: motors.reduce((sum, car) => sum + car.v, 0) / Math.max(1, motors.length) * 2.23694,
        buses: motors.filter(c => c.type === 'bus').length, cyclists, pedestrians: town.people?.length || 0, ratio,
        status: !motors.length ? cyclists ? 'Car-free' : 'Empty streets' : ratio > 0.65 || metrics.longestQueue > 600 ? 'Traffic jam' :
            ratio > 0.4 || metrics.longestQueue > 300 ? 'Congested' : ratio > 0.2 ? 'Busy' : 'Flowing' };
    town.metricClock = s.time;
}
export function nearestNode(map, point, simulation) {
    const candidates = Object.values(map.data.nodes).filter(n => simulation.graph.out.has(n.id));
    return candidates.reduce((a, b) => Math.hypot(a.p[0] - point[0], a.p[1] - point[1]) < Math.hypot(b.p[0] - point[0], b.p[1] - point[1]) ? a : b);
}
export function planRealTrip(town, from, to) {
    const s = town.simulation;
    const delay = edge => {
        const stats = s.edgeStats.get(edge.id);
        return (stats?.waiting || 0) * 3 + (stats?.count || 0) * 0.25;
    };
    const cost = edge => preferredRoadCost(edge) + delay(edge);
    const ids = findRoute(s.graph, from.id, to.id, null, cost);
    if (!ids) return null;
    const edges = ids.map(id => town.map.data.edges[id]);
    return { ids, edges, metres: edges.reduce((sum, e) => sum + e.length, 0), seconds: edges.reduce((sum, e) => sum + e.length / e.speed + delay(e), 0) };
}
export function realVehiclePose(town, car, widthFactor, alpha = 1) {
    const station = stationVehiclePose(town, car, widthFactor, alpha);
    if (station) return station;
    const parkingEdge = car.parkingActivity?.target.edge || (car.parked?.zone &&
        town.simulation.parking.parkedPosition(car.parked.zone, car.parked.slot).edge);
    const parking = parkingEdge && town.simulation.parking.pose?.(car,
        roadWidthFactor(town.map.roadById.get(parkingEdge.way), widthFactor), alpha);
    if (parking) return { ...parking, road: town.map.roadById.get(parking.edge.way) };
    if (car.parked) {
        const raw = town.simulation.parking.parkedPosition(car.parked.zone, car.parked.slot);
        const road = town.map.roadById.get(raw.edge.way);
        const p = town.simulation.parking.parkedPosition(car.parked.zone, car.parked.slot, roadWidthFactor(road, widthFactor));
        return { ...p, road, angle: Math.atan2(p.dy, p.dx) + (car.parked.direction === -1 ? Math.PI : 0) };
    }
    if (car.turnaround) {
        const road = town.map.roadById.get(town.map.data.edges[car.route[car.index]].way);
        const turning = turnaroundPose(town.simulation, car, roadWidthFactor(road, widthFactor), alpha);
        if (turning) return { ...turning, road };
    }
    const s = town.simulation, q = Math.max(0, car.q - car.length / 2);
    function at(distance) {
        let index = car.index;
        while (index > 0 && distance < car.offsets[index]) index--;
        while (index < car.route.length - 1 && distance > car.offsets[index + 1]) index++;
        const edge = town.map.data.edges[car.route[index]], d = Math.max(0, distance - car.offsets[index]);
        const p = position(edge, d);
        const road = town.map.roadById.get(edge.way);
        const normal = s.parking.lateral(car, edge, d, laneOffset(edge, car.lanes[index]));
        const factor = roadWidthFactor(road, widthFactor);
        const passing = s.busOvertaking?.lateral(car, edge, d, normal, alpha) ?? normal;
        const lateral = (s.emergency?.lateral(car, edge, passing, factor, alpha) ?? passing) * factor;
        return { x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, edge, road, angle: Math.atan2(p.dy, p.dx) };
    }
    const p = at(q), a = at(Math.max(0, q - car.length * 0.35)), b = at(Math.min(car.offsets.at(-1), q + car.length * 0.35));
    // Looking along the body softens heading changes at surveyed shape nodes.
    p.angle = Math.atan2(b.y - a.y, b.x - a.x);
    p.angle += s.busOvertaking?.steering(car, roadWidthFactor(p.road, widthFactor), alpha) || 0;
    return p;
}
