import { findRoute, position } from './kings-langley/engine/graph.mjs';
import { laneOffset } from './kings-langley/engine/traffic-model.mjs';
import { trackPoint, trainTiming, trainStationSchedule } from './railway.mjs';
import { measure, pathPoint } from './street-geometry.mjs';
import { pedestrianMotionBlocked } from './real-pedestrians.mjs';
import { orientedBodiesOverlap } from './body-geometry.mjs';

const HOLD = 86400;
const TURN_SECONDS = 3;
const MAX_TRIPS = 12;
const LEAD_SECONDS = 120;
const WALK_SPEED = 1.45;
const COLOURS = ['#d68a62', '#527e92', '#8c779b', '#c99d47', '#638678'];
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const roadAvailable = (simulation, edge) => !simulation.closures.ways.has(edge.way) &&
    !['no', 'private'].includes(edge.tags.access) && !['no', 'private'].includes(edge.tags.motor_vehicle) &&
    !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(edge.tags.highway);

/** Real forecourt road edges plus a small illustrative bay/access layout. */
export function prepareStationArea(map, trains) {
    const train = trains.find(item => item.local);
    const inbound = map.data.edges.find(edge => edge.way === 233961901 && edge.points[0][1] > edge.points.at(-1)[1]);
    if (!train || !inbound) return null;
    const outbound = map.data.edges.find(edge => edge.way === inbound.way && edge.from === inbound.to && edge.to === inbound.from);
    if (!outbound) return null;
    const stop = trackPoint(train.route, train.stop);
    const portal = { x: 504, y: 575, angle: 0, layer: 0 };
    const platform = { x: stop.x + 6, y: stop.y, angle: stop.angle, layer: stop.layer };
    const bays = [[499, 565], [496.7, 553], [494.4, 541], [492.1, 529]].map(([x, y], i) =>
        ({ id: i, x, y, angle: -1.76, layer: 0 }));
    const entrance = position(inbound, 18);
    const footPath = [...bays].reverse().map(bay => ({ x: bay.x + 4.5, y: bay.y }));
    footPath.push(portal);
    return { inbound, outbound, stopDistance: 18, entrance: { ...entrance, angle: Math.atan2(entrance.dy, entrance.dx), layer: 0 },
        entrancePoint: portal, waitingPoint: portal, portal, platform, bays,
        footPath, walkPath: footPath };
}

function routesFor(town) {
    const state = town.stationVisits, sim = town.simulation, area = state.area;
    if (!area) return [];
    const station = town.map.landmarks.find(place => place.id === 'station').p;
    const candidates = [...new Set(sim.data.edges.filter(edge => roadAvailable(sim, edge) &&
        ['tertiary', 'secondary', 'unclassified', 'residential'].includes(edge.tags.highway) && edge.tags.name)
        .flatMap(edge => [edge.from, edge.to]))].filter(id => {
        const p = sim.data.nodes[id].p, d = Math.hypot(p[0] - station[0], p[1] - station[1]);
        return d > 160 && d < 640;
    });
    const cost = edge => roadAvailable(sim, edge) ? edge.length / Math.min(edge.speed, 12) +
        (edge.tags.highway === 'service' ? 4 : 0) : Infinity;
    const result = [];
    for (const id of candidates) {
        const incoming = findRoute(sim.graph, id, area.inbound.to, null, cost, area.inbound.id);
        // A manoeuvre in the off-road bay turns the car around. Each street leg
        // remains a legal graph path, with no U-turn through a road junction.
        const tail = findRoute(sim.graph, area.outbound.to, id, area.outbound, cost);
        if (!incoming?.length || !tail?.length) continue;
        const outgoing = [area.outbound.id, ...tail];
        if ([...incoming, ...outgoing].some(edgeId => !roadAvailable(sim, sim.data.edges[edgeId]))) continue;
        const length = incoming.reduce((sum, edgeId) => sum + sim.data.edges[edgeId].length, 0);
        if (length < 180 || length > 1200) continue;
        result.push({ incoming, outgoing, length, origin: sim.data.nodes[id].p });
    }
    return result.sort((a, b) => a.length - b.length).filter((route, i, all) =>
        i === 0 || Math.hypot(route.origin[0] - all[i - 1].origin[0], route.origin[1] - all[i - 1].origin[1]) > 35).slice(0, 16);
}

/** Attach state {area,trips,passengers,nextArrival,status,counters}; actors are
 * separate from the random pavement walkers and share the simulation clock. */
export function attachStationVisits(town) {
    const train = town.trains.find(item => item.local);
    town.stationVisits = { train, area: prepareStationArea(town.map, town.trains), trips: [], passengers: [],
        events: new Set(), nextTripId: 1, nextPassengerId: 1, nextAttempt: 0, enabled: false,
        nextArrival: null, status: 'Station quiet', counters: { droppedOff: 0, pickedUp: 0, boarded: 0, arrivals: 0 }, routes: [] };
    town.stationVisits.routes = routesFor(town);
    return town.stationVisits;
}

function releaseCarClaims(simulation, ids) {
    for (const [node, claims] of simulation.reservations) {
        const remaining = claims.filter(claim => !ids.has(claim.car.id));
        if (remaining.length) simulation.reservations.set(node, remaining); else simulation.reservations.delete(node);
    }
    for (const zone of simulation.parking.zones) {
        for (const group of [zone.parked, zone.claims, zone.waiting]) for (const id of ids) group.delete(id);
        if (!zone.claims.size) { zone.direction = 0; zone.batch = 0; }
    }
    simulation.busOvertaking.releaseMissing();
}

/** Cancel scheduled station visits on road traffic changes, without replaying
 * an old queue when cars are enabled again. Ordinary road traffic is untouched. */
export function resetStationTraffic(town) {
    const state = town.stationVisits;
    if (!state) return;
    const sim = town.simulation, ids = new Set(state.trips.map(trip => trip.car?.id).filter(Boolean));
    sim.cars = sim.cars.filter(car => !ids.has(car.id));
    releaseCarClaims(sim, ids);
    state.trips = []; state.passengers = []; state.events.clear();
    state.enabled = town.trafficLevel > 0 && !!state.area && state.routes.length > 0;
    state.nextAttempt = sim.time;
    state.status = state.enabled ? 'Preparing station journeys' : 'Station quiet';
    state.nextArrival = state.train ? trainStationSchedule(state.train, sim.time).nextArrival : null;
}

function eventAt(train, index) {
    const timing = trainTiming(train), arrival = timing.arrival - train.offset + index * timing.cycle;
    return { id: `${train.id}:${index}`, index, arrival, departure: arrival + timing.dwell };
}

function addEvent(town, event) {
    const state = town.stationVisits, sim = town.simulation;
    if (state.events.has(event.id) || state.trips.length > MAX_TRIPS - 4) return;
    state.events.add(event.id);
    // Two families dropping off and two collecting make a legible small pulse;
    // this represents a sample of station demand, rather than every passenger.
    for (const [i, kind] of ['dropoff', 'pickup', 'dropoff', 'pickup'].entries()) {
        const route = state.routes[(event.index * 5 + i + state.routes.length * 20) % state.routes.length];
        const trip = { id: state.nextTripId++, kind, phase: 'requested', event,
            arrival: event.arrival, departure: event.departure, route, car: null, bay: null,
            requestedAt: event.arrival - LEAD_SECONDS + i * 5, expires: event.arrival + 80,
            passengerCount: i === 2 ? 2 : 1, passengerIds: [], elapsed: 0,
            initial: event.arrival - sim.time < 20, transferDone: false };
        state.trips.push(trip);
    }
}

function moveRoute(car, simulation, path, q) {
    // Keep the actor's identity/paint/person links while preparing an ordinary
    // opposite-direction road leg after turning within its off-road bay.
    const prepared = simulation.createVehicle(path, 'car', q, 0);
    for (const field of ['route', 'offsets', 'lanes', 'index', 'q', 'd', 'destination', 'parkingPassages']) car[field] = prepared[field];
    car.v = 0; car.turnaround = null; car.busPass = null; car.roadStop = { q: car.q, duration: HOLD, remaining: HOLD, done: false };
}

function safeRoadInsertion(town, car) {
    const sim = town.simulation;
    if (car.route.some(id => !roadAvailable(sim, sim.data.edges[id]))) return false;
    if (sim.crossingSpawnAllowed?.(car) === false || sim.adaptive.spawnAllowed(car) === false ||
        sim.busOvertaking.spawnAllowed(car) === false || !sim.parking.spawnAllowed(car)) return false;
    const occupied = sim.occupancy();
    if (sim.leader(car, occupied).gap < 12) return false;
    for (let i = car.index; i >= 0; i--) {
        const edge = sim.data.edges[car.route[i]], start = car.q - car.length - car.offsets[i], end = car.q - car.offsets[i];
        if (end <= 0) continue;
        if (start >= edge.length) break;
        for (const fragment of occupied.get(`${edge.id}:${car.lanes[i]}`) || []) {
            if (fragment.car === car) continue;
            const rear = Math.max(14, fragment.car.v * 1.5 + fragment.car.v ** 2 / (2 * Math.max(1, fragment.car.b)));
            if (end + 12 > fragment.start && start - rear < fragment.end) return false;
        }
        if (start >= 0) break;
    }
    return true;
}

function spawnTrip(town, trip) {
    const sim = town.simulation;
    if (sim.cars.length >= sim.maxVehicles) return false;
    const car = sim.createVehicle(trip.route.incoming, 'car', 0, 0);
    const stopQ = car.offsets.at(-2) + town.stationVisits.area.stopDistance;
    car.q = trip.initial ? Math.max(car.length + 14, stopQ - 115) : car.length + 14;
    while (car.index < car.route.length - 1 && car.q >= car.offsets[car.index + 1]) car.index++;
    car.d = car.q - car.offsets[car.index];
    car.roadStop = { q: stopQ, duration: HOLD, remaining: null, done: false, station: true };
    car.stationVisit = trip;
    if (!safeRoadInsertion(town, car)) return false;
    trip.car = car; trip.phase = 'approaching';
    sim.parking.claimSpawn(car); sim.cars.push(car); sim.generated++;
    return true;
}

function personFor(state, trip, n) {
    const person = { id: state.nextPassengerId++, kind: trip.kind, phase: 'waiting-car', tripId: trip.id, trip,
        colour: COLOURS[(trip.id + n) % COLOURS.length], speed: WALK_SPEED, luggage: n === 0,
        elapsed: 0, progress: 0, createdAt: trip.arrival, targetArrival: trip.arrival };
    state.passengers.push(person); trip.passengerIds.push(person.id);
    return person;
}

function beginDropoff(state, trip) {
    if (trip.passengerIds.length) return;
    for (let n = 0; n < trip.passengerCount; n++) {
        const person = personFor(state, trip, n);
        person.phase = 'walking-platform'; person.progress = 0;
    }
    state.counters.droppedOff += trip.passengerCount;
}

function platformWalk(state, trip) {
    const bay = trip.passengerBay ?? trip.bay ?? state.area.bays[0], portal = state.area.portal;
    const points = [{ x: bay.x + 2.8, y: bay.y }, { x: bay.x + 4.5, y: bay.y },
        ...state.area.bays.slice(0, bay.id).reverse().map(item => ({ x: item.x + 4.5, y: item.y })), portal];
    return measure(points);
}

function advancePassengers(town, dt, schedule) {
    const state = town.stationVisits, time = town.simulation.time;
    for (const person of state.passengers) {
        const trip = person.trip;
        person.previousElapsed = person.elapsed; person.previousProgress = person.progress; person.previousPhase = person.phase;
        const walk = platformWalk(state, trip);
        person.fireEngineWaiting = false;
        if (town.fireEngine?.active) {
            const candidate = { ...person, elapsed: person.elapsed + dt, previousPhase: null };
            if (['walking-platform', 'walking-car'].includes(person.phase))
                candidate.progress = clamp(person.progress + person.speed * dt / Math.max(1, walk.length));
            if (person.phase === 'access-car' && candidate.elapsed >= 6) { candidate.phase = 'walking-car'; candidate.progress = 0; }
            if (person.phase === 'access-platform' && candidate.elapsed >= 6) candidate.phase = 'waiting-train';
            if (person.phase === 'walking-car' && !trip.bay) candidate.phase = 'waiting-car';
            if (person.phase === 'waiting-car' && trip.bay && ['waiting', 'loading'].includes(trip.phase)) {
                candidate.phase = 'walking-car'; candidate.progress = 0;
            }
            if (pedestrianMotionBlocked(town, stationPassengerPose(town, person, 1, 1), stationPassengerPose(town, candidate, 1, 1))) {
                person.fireEngineWaiting = true;
                continue;
            }
        }
        person.elapsed += dt;
        if (person.phase === 'walking-platform') {
            person.progress += person.speed * dt / Math.max(1, walk.length);
            if (person.progress >= 1) { person.phase = 'access-platform'; person.elapsed = 0; person.progress = 0; }
        } else if (person.phase === 'access-platform' && person.elapsed >= 6) {
            person.phase = 'waiting-train'; person.elapsed = 0;
        } else if (person.phase === 'waiting-train' && schedule.stopped && time + 2 < schedule.departureTime) {
            person.phase = 'boarding'; person.elapsed = 0; person.boardedEvent = eventAt(state.train, schedule.index).id;
        } else if (person.phase === 'boarding' && person.elapsed >= 2) {
            person.phase = 'boarded'; person.elapsed = 0; state.counters.boarded++;
        } else if (person.phase === 'alighting' && person.elapsed >= 2) {
            person.phase = 'access-car'; person.elapsed = 0;
        } else if (person.phase === 'access-car' && person.elapsed >= 6) {
            person.phase = 'walking-car'; person.elapsed = 0; person.progress = 0;
        } else if (person.phase === 'walking-car') {
            // Uncollected people walk to the entrance, rather than to an empty
            // bay assigned later. Once the car parks they walk the last metres.
            if (!trip.bay) { person.phase = 'waiting-car'; person.elapsed = 0; continue; }
            person.progress += person.speed * dt / Math.max(1, walk.length);
            if (person.progress >= 1) { person.phase = 'boarding-car'; person.elapsed = 0; }
        } else if (person.phase === 'waiting-car' && trip.bay && ['waiting', 'loading'].includes(trip.phase)) {
            person.phase = 'walking-car'; person.elapsed = 0; person.progress = 0;
        } else if (person.phase === 'boarding-car' && person.elapsed >= 3) {
            person.phase = 'in-car'; person.elapsed = 0; state.counters.pickedUp++;
        }
    }
}

function arriveEvent(town, trip, time) {
    if (trip.kind !== 'pickup' || trip.passengerIds.length || time < trip.arrival) return;
    for (let n = 0; n < trip.passengerCount; n++) {
        const person = personFor(town.stationVisits, trip, n);
        person.phase = 'alighting'; person.elapsed = 0;
    }
}

function tryMerge(town, trip) {
    const sim = town.simulation, car = trip.car;
    if (!trip.outboundPrepared) {
        // Let anybody using the little forecourt walkway clear the turning
        // envelope before changing the car's orientation inside its bay.
        const radius = car.length / 2 + 2;
        if (town.stationVisits.passengers.some(person => {
            const p = stationPassengerPose(town, person);
            return p.visible && Math.hypot(p.x - trip.bay.x, p.y - trip.bay.y) < radius;
        })) return false;
        if (stationMovementBlocked(town, trip, 0, TURN_SECONDS, { phase: 'turning-in-bay', outboundPrepared: true })) return false;
        // Preserve the road-centre body position: reversing the off-road car
        // puts its new front one full body length beyond the old rear.
        const q = town.stationVisits.area.outbound.length - town.stationVisits.area.stopDistance + car.length;
        moveRoute(car, sim, trip.route.outgoing, q);
        trip.outboundPrepared = true;
        trip.phase = 'turning-in-bay'; trip.elapsed = 0;
        return false;
    }
    car.roadStop.remaining = HOLD;
    if (!safeRoadInsertion(town, car)) return false;
    if (stationMovementBlocked(town, trip, 0, TURN_SECONDS, { phase: 'pulling-out' })) return false;
    car.parked = null;
    trip.phase = 'pulling-out'; trip.elapsed = 0;
    sim.parking.claimSpawn(car);
    return true;
}

function maintainTrips(town, dt) {
    const state = town.stationVisits, sim = town.simulation, time = sim.time;
    const alive = new Set(sim.cars);
    for (const trip of state.trips) {
        if (!trip.event.counted && time >= trip.arrival && time < trip.departure) {
            trip.event.counted = true; state.counters.arrivals++;
        }
        arriveEvent(town, trip, time);
        trip.previousElapsed = trip.elapsed; trip.previousPhase = trip.phase;
        const car = trip.car;
        trip.fireEngineWaiting = false;
        if (car && ['pulling-in', 'turning-in-bay', 'pulling-out'].includes(trip.phase) &&
            stationMovementBlocked(town, trip, trip.elapsed, trip.elapsed + dt)) trip.fireEngineWaiting = true;
        else trip.elapsed += dt;
        if (car && !alive.has(car)) {
            trip.car = null; trip.phase = 'finished'; trip.bay = null;
            for (const person of state.passengers.filter(item => item.trip === trip))
                if (person.kind === 'pickup') person.phase = 'finished';
            continue;
        }
        if (!car) continue;
        if (car.parked?.station) car.roadStop.remaining = HOLD;
        if (trip.phase === 'approaching' && car.roadStop.remaining !== null) {
            const occupied = new Set(state.trips.filter(other => other !== trip && other.car && other.bay).map(other => other.bay.id));
            const bay = state.area.bays.find(item => !occupied.has(item.id));
            car.roadStop.remaining = HOLD;
            if (!bay) continue;
            if (stationMovementBlocked(town, trip, 0, TURN_SECONDS, { phase: 'pulling-in', bay })) continue;
            trip.bay = bay; trip.passengerBay = bay; trip.phase = 'pulling-in'; trip.elapsed = 0;
        } else if (trip.phase === 'pulling-in' && trip.elapsed >= TURN_SECONDS) {
            car.parked = { station: true, slot: trip.bay.id };
            trip.phase = trip.kind === 'dropoff' ? 'unloading' : 'waiting'; trip.elapsed = 0;
            if (trip.kind === 'dropoff') beginDropoff(state, trip);
        } else if (trip.phase === 'unloading' && trip.elapsed >= 5) {
            trip.phase = 'ready-to-leave'; trip.elapsed = 0; trip.transferDone = true;
        } else if (trip.phase === 'waiting' && trip.passengerIds.length &&
            state.passengers.filter(person => person.trip === trip).every(person => person.phase === 'in-car')) {
            trip.phase = 'ready-to-leave'; trip.elapsed = 0; trip.transferDone = true;
        } else if (trip.phase === 'ready-to-leave') {
            tryMerge(town, trip);
        } else if (trip.phase === 'turning-in-bay' && trip.elapsed >= TURN_SECONDS) {
            trip.phase = 'ready-to-leave'; trip.elapsed = 0;
        } else if (trip.phase === 'pulling-out' && trip.elapsed >= TURN_SECONDS) {
            car.roadStop = null; trip.phase = 'leaving'; trip.elapsed = 0; trip.bay = null;
        }
    }
}

function updateStatus(state, time, schedule) {
    state.nextArrival = schedule.stopped ? schedule.arrivalTime : schedule.nextArrival;
    const waiting = state.passengers.filter(person => person.phase === 'waiting-train').length;
    const collecting = state.trips.filter(trip => trip.kind === 'pickup' && trip.car && trip.phase !== 'leaving').length;
    state.status = schedule.stopped ? 'Local train at the platform' :
        waiting ? `${waiting} passenger${waiting === 1 ? '' : 's'} waiting for the train` :
            collecting ? `${collecting} car${collecting === 1 ? '' : 's'} waiting to collect passengers` :
                state.trips.some(trip => trip.phase === 'approaching') ? 'Cars approaching the station' : 'Next local train on its way';
}

/** Advance before Simulation.step. Spawns and merges use its real safety
 * guards; all transfer animations and train events use simulation time. */
export function updateStationVisits(town, dt) {
    const state = town.stationVisits, sim = town.simulation;
    if (!state || !(dt > 0) || !state.train || !state.area) return;
    if (town.trafficLevel === 0) {
        if (state.enabled || state.trips.length || state.passengers.length) resetStationTraffic(town);
        return;
    }
    if (!state.enabled) resetStationTraffic(town);
    if (!state.routes.length) return;
    const schedule = trainStationSchedule(state.train, sim.time);
    // Prune completed actors and schedule only the next visible train pulse.
    state.passengers = state.passengers.filter(person => !['finished', 'boarded'].includes(person.phase) || person.elapsed < 5);
    state.trips = state.trips.filter(trip => trip.phase !== 'finished' || state.passengers.some(person => person.trip === trip));
    const index = schedule.stopped ? schedule.index : schedule.index + 1;
    const event = eventAt(state.train, index);
    if (event.arrival - sim.time <= LEAD_SECONDS) addEvent(town, event);
    for (const id of state.events) if (Number(id.split(':').at(-1)) < index - 1) state.events.delete(id);
    maintainTrips(town, dt);
    advancePassengers(town, dt, schedule);
    if (sim.time >= state.nextAttempt) {
        state.nextAttempt = sim.time + 0.75;
        for (const trip of state.trips) {
            if (trip.phase !== 'requested' || sim.time < trip.requestedAt) continue;
            if (sim.time > trip.expires) {
                trip.phase = 'finished';
                for (const person of state.passengers.filter(item => item.trip === trip)) person.phase = 'finished';
                continue;
            }
            spawnTrip(town, trip);
        }
    }
    updateStatus(state, sim.time, schedule);
}

function normalRoadPose(town, car, widthFactor) {
    const q = Math.max(0, car.q - car.length / 2);
    function at(distance) {
        let index = car.index;
        while (index > 0 && distance < car.offsets[index]) index--;
        while (index < car.route.length - 1 && distance > car.offsets[index + 1]) index++;
        const edge = town.map.data.edges[car.route[index]], p = position(edge, Math.max(0, distance - car.offsets[index]));
        const road = town.map.roadById.get(edge.way), width = Math.min(widthFactor * road.size, road.widthCap || Infinity);
        const lateral = laneOffset(edge, car.lanes[index]) * width;
        return { x: p.x + p.dy * lateral, y: p.y - p.dx * lateral, angle: Math.atan2(p.dy, p.dx), road, edge, layer: road.layer };
    }
    const p = at(q), a = at(Math.max(0, q - car.length * 0.35)), b = at(Math.min(car.offsets.at(-1), q + car.length * 0.35));
    p.angle = Math.atan2(b.y - a.y, b.x - a.x);
    return p;
}

// Station bay motion runs before Simulation.step, so its elapsed-time path
// needs the same physical player-body veto as ordinary forward road motion.
function stationMovementBlocked(town, trip, from, to, changes = {}) {
    const player = town.fireEngine?.pose;
    if (!town.fireEngine?.active || !player || !trip.car) return false;
    const widthFactor = town.walking?.widthFactor || 2.5;
    // Keep increments under 0.03 s, including a complete pi-radian bay turn.
    // This checks the swept body rather than just the two endpoint positions.
    const start = clamp(from / TURN_SECONDS) * TURN_SECONDS, finish = clamp(to / TURN_SECONDS) * TURN_SECONDS;
    const count = Math.max(1, Math.ceil(Math.abs(finish - start) / 0.03));
    for (let index = 0; index <= count; index++) {
        const elapsed = start + (finish - start) * index / count;
        const sample = { ...trip, ...changes, elapsed, previousElapsed: elapsed, previousPhase: changes.phase || trip.phase };
        const p = stationVehiclePose(town, { ...trip.car, stationVisit: sample }, widthFactor, 1);
        if (!p) continue;
        const factor = Math.min(widthFactor * p.road.size, p.road.widthCap || Infinity);
        if (orientedBodiesOverlap(player, { ...p, length: trip.car.length,
            width: trip.car.width * factor, layer: p.road.layer }, 0.3)) return true;
    }
    return false;
}

/** Override only bay manoeuvres/parked poses; ordinary approach/departure uses
 * realVehiclePose. Holds road occupancy until its complete body clears. */
export function stationVehiclePose(town, car, widthFactor = 1, alpha = 1) {
    const trip = car.stationVisit;
    if (!trip?.bay || !['pulling-in', 'unloading', 'waiting', 'loading', 'ready-to-leave', 'turning-in-bay', 'pulling-out'].includes(trip.phase)) return null;
    const base = normalRoadPose(town, car, widthFactor), bay = trip.bay;
    const elapsed = trip.previousPhase === trip.phase ? (trip.previousElapsed ?? trip.elapsed) +
        (trip.elapsed - (trip.previousElapsed ?? trip.elapsed)) * clamp(alpha) : trip.elapsed;
    let t = trip.phase === 'pulling-in' ? smooth(elapsed / TURN_SECONDS) :
        trip.phase === 'pulling-out' ? 1 - smooth(elapsed / TURN_SECONDS) : 1;
    const parkedAngle = trip.outboundPrepared ? bay.angle + Math.PI *
        (trip.phase === 'turning-in-bay' ? smooth(elapsed / TURN_SECONDS) : 1) : bay.angle;
    const delta = Math.atan2(Math.sin(parkedAngle - base.angle), Math.cos(parkedAngle - base.angle));
    return { ...base, x: base.x + (bay.x - base.x) * t, y: base.y + (bay.y - base.y) * t,
        angle: base.angle + delta * t, parked: car.parked?.station || false, station: true };
}

/** Pose for linked passengers; visible=false inside the grade-separated
 * station access, on the train or inside a car. No walking across live rails. */
export function stationPassengerPose(town, person, widthFactor = 1, alpha = 1) {
    const state = town.stationVisits;
    const invisible = ['access-platform', 'access-car', 'in-car', 'boarded', 'finished'].includes(person.phase);
    if (!state?.area || invisible) return { visible: false, phase: person.phase };
    const walk = platformWalk(state, person.trip);
    const index = person.trip.passengerIds.indexOf(person.id), offset = index * 1.6;
    let p = state.area.portal, angle = 0, moving = false;
    const progress = person.previousPhase === person.phase ? (person.previousProgress ?? person.progress) +
        (person.progress - (person.previousProgress ?? person.progress)) * clamp(alpha) : person.progress;
    const elapsed = person.previousPhase === person.phase ? (person.previousElapsed ?? person.elapsed) +
        (person.elapsed - (person.previousElapsed ?? person.elapsed)) * clamp(alpha) : person.elapsed;
    if (['walking-platform', 'walking-car', 'boarding-car'].includes(person.phase)) {
        const t = person.phase === 'boarding-car' ? 1 : clamp(progress);
        const backwards = person.phase !== 'walking-platform';
        p = pathPoint(walk, (backwards ? 1 - t : t) * walk.length);
        angle = p.angle + (backwards ? Math.PI : 0); moving = person.phase !== 'boarding-car';
    } else if (['waiting-train', 'boarding', 'alighting'].includes(person.phase)) {
        const queue = state.passengers.filter(item => ['waiting-train', 'boarding', 'alighting'].includes(item.phase)).sort((a, b) => a.id - b.id);
        const slot = Math.max(0, queue.indexOf(person)), platform = state.area.platform;
        p = { x: platform.x - Math.cos(platform.angle) * slot * 4,
            y: platform.y - Math.sin(platform.angle) * slot * 4 - offset };
        angle = person.phase === 'alighting' ? 0 : Math.PI;
        if (person.phase === 'boarding') p = { x: p.x - clamp(elapsed / 2) * 2, y: p.y };
        if (person.phase === 'alighting') p = { x: p.x - (1 - clamp(elapsed / 2)) * 2, y: p.y };
    } else if (person.phase === 'waiting-car') {
        const queue = state.passengers.filter(item => item.phase === 'waiting-car').sort((a, b) => a.id - b.id);
        const slot = Math.max(0, queue.indexOf(person));
        p = { x: p.x + slot % 2 * 3.2, y: p.y + Math.floor(slot / 2) * 4 - offset };
    }
    moving &&= !person.fireEngineWaiting;
    return { x: p.x, y: p.y + offset, angle, moving, speed: moving ? person.speed : 0,
        phase: person.phase, colour: person.colour, visible: true, layer: 0, age: person.elapsed };
}
