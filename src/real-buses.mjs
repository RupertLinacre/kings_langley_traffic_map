import { BUS_SERVICE_DATA } from './bus-service-data.mjs';
import { position } from './kings-langley/engine/graph.mjs';

// Geographic routes and boarding points are real. Departures are compressed
// for the miniature, rather than pretending to be a live passenger timetable.
export const BUS_TIME_COMPRESSION = 6;
const MAX_BUSES = 24;

export function prepareBusServices(map) {
    const stops = BUS_SERVICE_DATA.stops.map(stop => ({ ...stop,
        position: position(map.data.edges[stop.edgeId], stop.d),
    }));
    const byId = new Map(stops.map(stop => [stop.id, stop]));
    const services = BUS_SERVICE_DATA.services.map(service => {
        const offsets = [0];
        for (const id of service.path) offsets.push(offsets.at(-1) + map.data.edges[id].length);
        let previousQ = -Infinity;
        const calls = service.stopIds.map(id => {
            const stop = byId.get(id);
            const index = service.path.findIndex((edgeId, i) => edgeId === stop.edgeId && offsets[i] + stop.d > previousQ + 0.5);
            if (index < 0) throw new Error(`Bus ${service.number} cannot reach stop ${id} in order.`);
            const q = offsets[index] + stop.d;
            previousQ = q;
            return { busStopId: id, name: stop.name, q };
        });
        return { ...service, calls, length: offsets.at(-1) };
    });
    return { stops, byId, services };
}

export function attachBusServices(town) {
    town.buses = { ...prepareBusServices(town.map), enabled: false,
        departures: new Map(), nextAttempt: 0, seeded: false };
    return town.buses;
}

function available(town, bus) {
    const sim = town.simulation;
    if (bus.type !== 'bus' || bus.q < bus.length + 1 || bus.q >= bus.offsets.at(-1) - bus.length) return false;
    if (bus.route.some(id => sim.closures.ways.has(sim.data.edges[id].way))) return false;
    if (bus.parkingPassages.some(p => p.zone.narrow && bus.q > p.entry - 20 && bus.q - bus.length < p.exit + 20)) return false;
    if (sim.crossingSpawnAllowed?.(bus) === false || !sim.adaptive.spawnAllowed(bus) || !sim.parking.spawnAllowed(bus) ||
        sim.busOvertaking?.spawnAllowed(bus) === false) return false;
    const occupied = sim.occupancy();
    if (sim.leader(bus, occupied).gap < 10) return false;
    // A bus body can straddle several surveyed shape edges. Check the rear as
    // well as the front, allowing an approaching driver time to brake.
    for (let i = bus.index; i >= 0; i--) {
        const edge = sim.data.edges[bus.route[i]];
        const start = bus.q - bus.length - bus.offsets[i], end = bus.q - bus.offsets[i];
        if (end <= 0) continue;
        if (start >= edge.length) break;
        for (const fragment of occupied.get(`${edge.id}:${bus.lanes[i]}`) || []) {
            const braking = fragment.car.v * fragment.car.v / (2 * fragment.car.b) + fragment.car.v * 1.5;
            if (end + 3 > fragment.start && start - Math.max(6, braking) < fragment.end) return false;
        }
        if (start >= 0) break;
    }
    return true;
}

export function spawnServiceBus(town, service, q = null) {
    const sim = town.simulation;
    if (sim.cars.length >= sim.maxVehicles) return null;
    const bus = sim.createVehicle(service.path, 'bus', q ?? 20, 0, service.vehicleProfile);
    if (q === null && bus.q < bus.length + 2) {
        bus.q = bus.length + 2;
        while (bus.index < bus.route.length - 1 && bus.q >= bus.offsets[bus.index + 1]) bus.index++;
        bus.d = bus.q - bus.offsets[bus.index];
    }
    bus.busService = { number: service.number, destination: service.destination,
        operator: service.operator, availability: service.availability, operatingDays: service.operatingDays, id: service.id,
        departureStopId: service.departureStopId, endStopId: service.endStopId };
    bus.busStyle = { number: service.number, colour: service.colour };
    bus.busStops = service.calls.filter(call => call.q >= bus.q + 0.25).map(call => ({ ...call,
        duration: 12 + sim.random() * 18,
    }));
    bus.busStopIndex = 0;
    bus.roadStop = bus.busStops.length ? { ...bus.busStops[0], remaining: null, done: false } : null;
    bus.v = 0;
    if (!available(town, bus)) return null;
    sim.parking.claimSpawn(bus);
    sim.cars.push(bus);
    sim.generated++;
    return bus;
}

export function setBusTraffic(town, level) {
    const state = town.buses;
    if (!state) return;
    const sim = town.simulation, enabled = level > 0;
    if (!enabled) {
        state.enabled = false; state.seeded = false; state.departures.clear();
        return;
    }
    if (state.enabled) return;
    state.enabled = true;
    for (const [i, service] of state.services.entries()) {
        const interval = service.headwayMinutes * 60 / BUS_TIME_COMPRESSION;
        state.departures.set(service.id, sim.time + interval * (0.25 + i % 4 * 0.18));
    }
    // Establish a few buses already on their real routes, so Follow a bus works
    // immediately. The remaining departures enter at the clipped map boundary.
    if (!state.seeded) {
        const seededNumbers = new Set();
        for (const service of state.services) {
            if (seededNumbers.has(service.number) || seededNumbers.size >= Math.min(4, Math.round(town.baseTraffic * level))) continue;
            const calls = [...service.calls].sort((a, b) =>
                Number(/Vicarage|Langley Hill/.test(b.name)) - Number(/Vicarage|Langley Hill/.test(a.name)));
            for (const call of calls) {
                const q = Math.max(20, call.q - 35);
                if (spawnServiceBus(town, service, q)) { seededNumbers.add(service.number); break; }
            }
        }
        state.seeded = true;
    }
}

export function updateBusServices(town) {
    const state = town.buses, sim = town.simulation;
    if (!state?.enabled) return;
    const finished = new Set();
    for (const bus of sim.cars) {
        if (!bus.busService || !bus.roadStop?.done) continue;
        // A school arrival ends at its boarding point. Do not continue to the
        // far end of the OSM shape edge beyond the unmapped school grounds.
        if (bus.busService.endStopId === bus.roadStop.busStopId) {
            finished.add(bus.id);
            sim.completed++;
            sim.completedDelay += bus.delay;
            sim.travelTime += sim.time - bus.born;
            continue;
        }
        bus.busStopIndex++;
        const next = bus.busStops[bus.busStopIndex];
        bus.roadStop = next ? { ...next, remaining: null, done: false } : null;
    }
    if (finished.size) sim.cars = sim.cars.filter(car => !finished.has(car.id));
    // Keep at most one overdue departure per pattern: an obstructed entry must
    // not accumulate an enormous fleet that bursts in when the queue clears.
    if (sim.time < state.nextAttempt) return;
    state.nextAttempt = sim.time + 1;
    let count = sim.cars.filter(car => car.busService).length;
    for (const service of state.services) {
        if (count >= MAX_BUSES) break;
        if (sim.time < state.departures.get(service.id)) continue;
        if (spawnServiceBus(town, service)) {
            state.departures.set(service.id, sim.time + service.headwayMinutes * 60 / BUS_TIME_COMPRESSION);
            count++;
        }
    }
}
