import { findRoute } from './kings-langley/engine/graph.mjs';
import { SCHOOLS } from './kings-langley/engine/schools.mjs';
import { villageClock } from './village-day.mjs';
import { pavementWaypoint, planPavementRoute, pavementNodePose, pedestrianPose,
    updateLinkedWalker, releaseLinkedWalker } from './real-pedestrians.mjs';
import { pathPoint } from './street-geometry.mjs';

const CAPACITY = 8;
const HOLD = 86400;
const COLOURS = ['#c67554', '#548b96', '#9872a4', '#c59d3e', '#62815c'];
const clamp = value => Math.max(0, Math.min(1, value));
const roadAvailable = (sim, edge) => !sim.closures.ways.has(edge.way) &&
    !['no', 'private'].includes(edge.tags.access) && !['no', 'private'].includes(edge.tags.motor_vehicle) &&
    !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(edge.tags.highway);

function walkForBay(town, zone, position, kind) {
    const section = town.walking.sections.find(item => item.edges.some(edge => edge.id === position.edge.id));
    const parkedSide = zone.parkingSides?.get(position.edge.id) ?? zone.parkingSide;
    const side = parkedSide * (position.edge.from === section?.edge.from ? 1 : -1);
    const school = SCHOOLS.find(item => item.id === zone.id);
    if (school && section) {
        const center = school.outline.reduce((point, p) => [point[0] + p[0] / school.outline.length,
            point[1] + p[1] / school.outline.length], [0, 0]);
        const gate = pathPoint(section.path, section.edge.to === school.node ? section.path.length : 0);
        const gateSide = Math.sign((center[0] - gate.x) * Math.sin(gate.angle) - (center[1] - gate.y) * Math.cos(gate.angle));
        // This map has no connected crossing between some school pavements.
        // Use a bay on the actual gate side rather than inventing a crossing
        // or making children disappear into the opposite row of houses.
        if (side !== gateSide) return null;
    }
    const start = pavementWaypoint(town, position.edge.id, position.d, side);
    if (!start || Math.abs(start.distance - (position.edge.from === section.edge.from ? position.d : section.path.length - position.d)) > 3) return null;
    let endDistance;
    if (school) {
        // The real entrance is at this road's access junction. The pavement
        // stops before the junction trim, with children entering school here.
        const towardEnd = position.edge.to === school.node;
        endDistance = towardEnd ? position.edge.length : 0;
    } else {
        const available = section.sides.get(side), startD = start.distance;
        endDistance = startD < section.path.length / 2 ? available.at(-1).distance : available[0].distance;
        if (position.edge.from !== section.edge.from) endDistance = section.path.length - endDistance;
    }
    const end = pavementWaypoint(town, position.edge.id, endDistance, side);
    const route = planPavementRoute(town, start, end);
    if (!route || route.reduce((sum, link) => sum + link.length, 0) < (kind === 'shops' ? 12 : 8)) return null;
    return { start, end, route, side, section, zone, school };
}

function buildPlans(town, zoneId, kind) {
    const sim = town.simulation, zone = sim.parking.zones.find(item => item.id === zoneId);
    if (!zone) return [];
    const bays = Array.from({ length: zone.capacity }, (_, slot) => ({ slot,
        position: sim.parking.parkedPosition(zone, slot) })).filter(bay => walkForBay(town, zone, bay.position, kind));
    if (!bays.length) return [];
    const center = bays[0].position;
    const homeNodes = [...new Set(sim.data.edges.filter(edge => ['residential', 'living_street'].includes(edge.tags.highway) &&
        roadAvailable(sim, edge) && edge.tags.name).map(edge => edge.from))].filter(id => {
        const p = sim.data.nodes[id].p, distance = Math.hypot(p[0] - center.x, p[1] - center.y);
        return distance > 180 && distance < 800;
    }).sort((a, b) => a - b);
    const workNodes = [...new Set(sim.data.edges.filter(edge => roadAvailable(sim, edge) &&
        ['secondary', 'tertiary', 'primary'].includes(edge.tags.highway) && edge.length > 100).map(edge => edge.to))]
        .filter(id => { const distance = Math.hypot(sim.data.nodes[id].p[0] - center.x, sim.data.nodes[id].p[1] - center.y);
            return distance > 350 && distance < 1200; })
        .sort((a, b) => Math.hypot(sim.data.nodes[a].p[0] - center.x, sim.data.nodes[a].p[1] - center.y) -
            Math.hypot(sim.data.nodes[b].p[0] - center.x, sim.data.nodes[b].p[1] - center.y));
    const cost = edge => roadAvailable(sim, edge) ? edge.length / Math.min(12, edge.speed) + (edge.tags.highway === 'service' ? 3 : 0) : Infinity;
    const plans = [];
    const arrivalEdges = [...new Set(bays.map(bay => {
        const edge = bay.position.edge;
        // Arrive on the British left kerb that contains the chosen bay row.
        return (zone.parkingSides?.get(edge.id) ?? zone.parkingSide) >= 0 ? edge : sim.data.edges.find(other => other.way === edge.way && other.from === edge.to && other.to === edge.from);
    }).filter(Boolean))];
    for (const parkingEdge of arrivalEdges) {
        for (const home of homeNodes) {
            const incoming = findRoute(sim.graph, home, parkingEdge.to, null, cost, parkingEdge.id);
            if (!incoming?.length || sim.data.edges[incoming[0]].length < 40) continue;
            const metres = incoming.reduce((sum, id) => sum + sim.data.edges[id].length, 0);
            if (metres < 160 || metres > 1300) continue;
            let work = home, tail = null, pickupIn = null;
            if (kind !== 'shops') for (const node of workNodes) {
                const path = findRoute(sim.graph, parkingEdge.to, node, parkingEdge, cost);
                const returning = findRoute(sim.graph, node, parkingEdge.to, null, cost, parkingEdge.id);
                if (path?.length && returning?.length && sim.data.edges[returning[0]].length >= 40 &&
                    returning.reduce((sum, id) => sum + sim.data.edges[id].length, 0) < 1300 &&
                    path.reduce((sum, id) => sum + sim.data.edges[id].length, 0) > 160) {
                    work = node; tail = path; pickupIn = returning; break;
                }
            }
            if (kind === 'shops') tail = findRoute(sim.graph, parkingEdge.to, home, parkingEdge, cost);
            if (!tail?.length) continue;
            const pickupOut = kind !== 'shops' ? findRoute(sim.graph, parkingEdge.to, home, parkingEdge, cost) : null;
            plans.push({ zoneId, school: SCHOOLS.find(item => item.id === zoneId), home, work,
                route: [...incoming, ...tail], arrivalEdge: parkingEdge.id,
                pickupRoute: pickupIn?.length && pickupOut?.length && sim.data.edges[pickupIn[0]].length >= 40 ? [...pickupIn, ...pickupOut] : null });
            if (plans.length >= 10) return plans;
        }
    }
    return plans;
}

/** State {trips,groups,plans,status,counters}. Added actors are a bounded sample
 * of purposeful village journeys, separate from the population controls. */
export function attachPurposefulJourneys(town) {
    const primary = buildPlans(town, 'primary', 'school-run'), secondary = buildPlans(town, 'secondary', 'school-run');
    town.purposefulJourneys = { trips: [], groups: [], plans: { schools: [...primary, ...secondary], shops: buildPlans(town, 'high-street', 'shops') },
        nextId: 1, nextGroupId: 1, generation: -1, periodKey: null, nextShopAt: town.simulation.time + 7,
        scheduled: [], enabled: town.trafficLevel > 0, status: 'Village errands',
        counters: { schoolDropoffs: 0, schoolPickups: 0, shoppingReturns: 0, completed: 0 }, stationJourneys: [] };
    return town.purposefulJourneys;
}

function clearClaims(town, ids) {
    const sim = town.simulation;
    for (const [node, claims] of sim.reservations) {
        const remaining = claims.filter(claim => !ids.has(claim.car.id));
        if (remaining.length) sim.reservations.set(node, remaining); else sim.reservations.delete(node);
    }
    for (const trip of town.purposefulJourneys.trips) if (trip.car) sim.parking.cancel?.(trip.car);
    for (const zone of sim.parking.zones) for (const map of [zone.parked, zone.claims, zone.waiting])
        for (const id of ids) map.delete(id);
    sim.busOvertaking.releaseMissing();
}

/** Used when traffic is disabled. Cancel only this model's actors and claims;
 * selecting a different time period instead lets active journeys finish. */
export function resetPurposefulJourneys(town) {
    const state = town.purposefulJourneys;
    if (!state) return;
    const ids = new Set(state.trips.map(trip => trip.car?.id).filter(id => id !== undefined));
    town.simulation.cars = town.simulation.cars.filter(car => !ids.has(car.id));
    for (const group of state.groups) releaseLinkedWalker(town, group.walker);
    clearClaims(town, ids);
    state.trips = []; state.groups = []; state.scheduled = []; state.periodKey = null;
    state.generation = -1; state.enabled = town.trafficLevel > 0; state.nextShopAt = town.simulation.time + 7;
    state.status = 'Village journeys quiet';
}

function requestJourney(town, kind, index) {
    const state = town.purposefulJourneys;
    if (state.trips.length >= CAPACITY) return;
    const plans = kind === 'shops' ? state.plans.shops : state.plans.schools.filter(plan => kind !== 'school-pickup' || plan.pickupRoute);
    if (!plans.length) return;
    const plan = plans[(index * 3 + (town.seed || 0)) % plans.length];
    state.trips.push({ id: state.nextId++, kind, label: kind === 'shops' ? 'A trip to the shops' :
        kind === 'school-pickup' ? 'Collecting from school' : 'Home → school → work',
        phase: 'requested', plan, home: plan.home, householdId: plan.home, school: plan.school, car: null, group: null,
        requestedAt: town.simulation.time, expires: town.simulation.time + 180, elapsed: 0 });
}

function safeInsertion(town, car) {
    const sim = town.simulation;
    if (car.route.some(id => !roadAvailable(sim, sim.data.edges[id])) || sim.cars.length >= sim.maxVehicles) return false;
    if (sim.crossingSpawnAllowed?.(car) === false || !sim.adaptive.spawnAllowed(car) ||
        !sim.busOvertaking.spawnAllowed(car) || !sim.parking.spawnAllowed(car)) return false;
    const occupied = sim.occupancy();
    if (sim.leader(car, occupied).gap < 14) return false;
    for (let i = car.index; i >= 0; i--) {
        const start = car.q - car.length - car.offsets[i], end = car.q - car.offsets[i], edge = sim.data.edges[car.route[i]];
        if (end <= 0) continue;
        if (start >= edge.length) break;
        if ((occupied.get(`${edge.id}:${car.lanes[i]}`) || []).some(fragment => {
            const rear = Math.max(14, fragment.car.v * 1.5 + fragment.car.v ** 2 / (2 * Math.max(1, fragment.car.b)));
            return fragment.car !== car && end + 14 > fragment.start && start - rear < fragment.end;
        })) return false;
        if (start >= 0) break;
    }
    return true;
}

function trySpawn(town, trip) {
    const sim = town.simulation;
    if (!sim.parking.request) return false;
    // Another family may leave home while the first walks to school. Keep one
    // approach at a time to these tightly spaced illustrated school bays so
    // two cars do not both stop inside each other's reversing pockets.
    if (trip.kind !== 'shops' && town.purposefulJourneys.trips.some(other => other !== trip &&
        other.plan.zoneId === trip.plan.zoneId && other.car && sim.cars.includes(other.car) && !other.car.parked &&
        (!['continuing', 'done'].includes(other.phase) ||
            other.car.q - (other.car.roadStop?.q ?? -Infinity) < other.car.length + 24))) return false;
    if (!trip.car) {
        const route = trip.kind === 'school-pickup' ? trip.plan.pickupRoute : trip.plan.route;
        trip.car = sim.createVehicle(route, 'car', 0, 0);
        trip.car.q = trip.car.d = trip.car.length + 14;
        trip.car.purposefulJourney = trip;
    }
    const car = trip.car;
    if (!safeInsertion(town, car)) return false;
    const requested = sim.parking.request(car, { zoneId: trip.plan.zoneId, duration: HOLD, purpose: trip.kind, holdDeparture: true,
        slotFilter: ({ zone, position }) => !!walkForBay(town, zone, position, trip.kind) });
    if (!requested) return false;
    car.born = sim.time; car.v = 0;
    sim.parking.claimSpawn(car); sim.cars.push(car); sim.generated++;
    trip.phase = 'driving';
    return true;
}

function reverseWalk(route) { return [...route].reverse().map(link => ({ ...link, from: link.to, to: link.from })); }
function missedParking(town, trip) {
    const sim = town.simulation, car = trip.car, edge = sim.data.edges[car.route[car.index]];
    const tail = findRoute(sim.graph, edge.to, trip.home, edge,
        next => roadAvailable(sim, next) ? next.length / Math.min(12, next.speed) : Infinity);
    if (tail?.length) {
        // Keep the already occupied prefix and body distances unchanged. The
        // same car takes legal junctions home instead of carrying a child on
        // to work after an unsuccessful school parking attempt.
        car.route = [...car.route.slice(0, car.index + 1), ...tail];
        car.lanes = [...car.lanes.slice(0, car.index + 1), ...tail.map(() => 0)];
        car.offsets = [0];
        for (const id of car.route) car.offsets.push(car.offsets.at(-1) + sim.data.edges[id].length);
        car.destination = trip.home; sim.parking.prepare(car);
    }
    car.parkingHold = false; car.parkingSearched = true; car.roadStop = null;
    trip.phase = 'returning-home'; trip.label = 'No parking gap — heading home';
}
function setWalk(group, route) {
    group.walker = { id: 100000 + group.id, route, index: 0, progress: 0, node: route[0].from,
        destination: route.at(-1).to, speed: 1.25, state: 'walking', activity: group.activity, arrived: false, pause: 0 };
}

function beginGroup(town, trip) {
    const state = town.purposefulJourneys, car = trip.car, zone = car.parked.zone;
    const position = town.simulation.parking.parkedPosition(zone, car.parked.slot);
    const walk = walkForBay(town, zone, position, trip.kind);
    if (!walk) { car.parkingHold = false; car.roadStop.remaining = 0; trip.phase = 'departing'; return; }
    const colourIndex = Math.abs(trip.householdId) % COLOURS.length;
    const group = { id: state.nextGroupId++, trip, walk, householdId: trip.householdId,
        label: trip.kind === 'shops' ? 'Shopping neighbours' : 'A school family',
        activity: trip.kind === 'shops' ? 'Walking to the village shops' : trip.kind === 'school-pickup' ? 'Walking to collect a child' : 'Walking together to the school gate',
        state: 'exiting', elapsed: 0, members: [{ role: 'parent', colour: COLOURS[colourIndex] },
            ...(trip.kind === 'school-pickup' ? [] : [{ role: trip.kind === 'shops' ? 'adult' : 'child', colour: COLOURS[(colourIndex + 2) % COLOURS.length] }])], bag: false };
    setWalk(group, walk.route); trip.group = group; trip.phase = 'walking'; state.groups.push(group);
}

function advanceGroup(town, group, dt) {
    const trip = group.trip, state = town.purposefulJourneys;
    group.previousState = group.state; group.previousElapsed = group.elapsed; group.elapsed += dt;
    if (group.state === 'exiting' && group.elapsed >= 2) { group.state = 'outbound'; group.elapsed = 0; }
    else if (['outbound', 'returning'].includes(group.state)) {
        updateLinkedWalker(town, group.walker, dt);
        if (group.walker.arrived) {
            if (group.state === 'returning') { group.state = 'boarding'; group.elapsed = 0; group.activity = 'Getting back into our car'; }
            else { group.state = trip.kind === 'shops' ? 'shopping' : 'gate'; group.elapsed = 0;
                group.activity = trip.kind === 'shops' ? 'Buying a few things inside the shop' : trip.kind === 'school-pickup' ? 'Meeting at the school gate' : 'Saying goodbye at the school gate'; }
        }
    } else if ((group.state === 'shopping' && group.elapsed >= 18) || (group.state === 'gate' && group.elapsed >= 4)) {
        if (trip.kind === 'school-run') { group.members = group.members.filter(member => member.role === 'parent'); state.counters.schoolDropoffs++; }
        else if (trip.kind === 'school-pickup') { group.members.push({ role: 'child', colour: COLOURS[(Math.abs(trip.householdId) + 2) % COLOURS.length] }); state.counters.schoolPickups++; }
        else group.bag = true;
        group.state = 'returning'; group.elapsed = 0;
        group.activity = trip.kind === 'school-run' ? 'Parent returning to the car before work' : trip.kind === 'school-pickup' ? 'Walking back together after school' : 'Carrying the shopping back to our car';
        setWalk(group, reverseWalk(group.walk.route));
    } else if (group.state === 'boarding' && group.elapsed >= 3) {
        group.state = 'in-car'; group.elapsed = 0;
        trip.car.parkingHold = false; trip.car.roadStop.remaining = 0;
        trip.phase = 'departing';
        if (trip.kind === 'shops') state.counters.shoppingReturns++;
    }
}

/** Call before simulation.step. All requests, walks, waits and returns use
 * simulation dt; period jumps replace future bursts while active trips finish. */
export function updatePurposefulJourneys(town, dt) {
    if (!(dt > 0)) return;
    const state = town.purposefulJourneys || attachPurposefulJourneys(town), sim = town.simulation;
    if (!(town.trafficLevel > 0)) { if (state.trips.length || state.groups.length || state.scheduled.length) resetPurposefulJourneys(town); return; }
    const clock = villageClock(town), key = `${clock.generation}:${clock.day}:${clock.period}`;
    if (key !== state.periodKey) {
        const jumped = state.generation !== clock.generation;
        state.periodKey = key; state.generation = clock.generation; state.scheduled = [];
        // Only unspawned requests belong to the old timetable. A child already
        // walking to school or a shopper returning to their car finishes safely.
        const pending = jumped ? state.trips.filter(trip => trip.phase === 'requested') : [];
        for (const trip of pending) if (trip.car) sim.parking.cancel?.(trip.car);
        if (jumped) state.trips = state.trips.filter(trip => trip.phase !== 'requested');
        if (clock.period === 'school-run' || clock.period === 'afternoon')
            state.scheduled = [2, 10, 20, 34, 49, 65].map((after, index) => ({ at: sim.time + after,
                kind: clock.period === 'school-run' ? 'school-run' : 'school-pickup', index }));
        state.nextShopAt = sim.time + 7;
    }
    while (state.scheduled.length && state.scheduled[0].at <= sim.time) {
        const event = state.scheduled.shift(); requestJourney(town, event.kind, event.index);
    }
    if (sim.time >= state.nextShopAt) {
        state.nextShopAt = sim.time + (clock.period === 'everyday' ? 65 : 105);
        if (['everyday', 'afternoon', 'rush', 'evening'].includes(clock.period)) requestJourney(town, 'shops', Math.floor(sim.time / 60));
    }
    for (const trip of state.trips) {
        trip.elapsed += dt;
        if (trip.phase === 'requested') {
            if (sim.time >= trip.expires) { if (trip.car) sim.parking.cancel?.(trip.car); trip.phase = 'cancelled'; }
            else trySpawn(town, trip);
            continue;
        }
        if (!sim.cars.includes(trip.car)) {
            if (trip.group) { releaseLinkedWalker(town, trip.group.walker); trip.group.state = 'done'; }
            trip.phase = 'done'; state.counters.completed++; continue;
        }
        if (trip.phase === 'driving' && trip.car.parkingSearch?.state === 'missed') missedParking(town, trip);
        if (trip.car.parked?.zone && !trip.group && !trip.car.parkingActivity) beginGroup(town, trip);
        if (trip.group && trip.group.state !== 'done') advanceGroup(town, trip.group, dt);
        if (trip.phase === 'departing' && trip.car.roadStop?.done) trip.phase = 'continuing';
    }
    state.trips = state.trips.filter(trip => !['cancelled', 'done'].includes(trip.phase));
    state.groups = state.groups.filter(group => group.state !== 'done' && group.state !== 'in-car');
    state.stationJourneys = (town.stationVisits?.trips || []).filter(trip => trip.kind === 'pickup');
    state.status = clock.period === 'school-run' ? 'Families on the way to school' : clock.period === 'afternoon' ?
        'Parents collecting children' : state.groups.some(group => group.bag) ? 'Shopping, then back home' : 'Village errands and journeys home';
}

/** A visible family follows its shared fixed pavement controller. At walking
 * bays the formation stays outside parked car bodies rather than walking
 * through their illustrated half-pavement parking. */
export function groupPose(town, group, widthFactor = 2.5, alpha = 1) {
    if (['shopping', 'in-car', 'done'].includes(group.state)) return { visible: false };
    const person = group.walker, sample = { ...person };
    if (person.previousIndex === person.index) sample.progress = (person.previousProgress ?? person.progress) +
        (person.progress - (person.previousProgress ?? person.progress)) * clamp(alpha);
    const p = person.arrived ? pavementNodePose(town, person.node, widthFactor) : pedestrianPose(town, sample, widthFactor);
    const { section, side, zone } = group.walk;
    const link = person.route?.[person.index], node = link?.from || person.node;
    let extra = 0;
    if ((!link || link.type === 'walk') && node.section === section) {
        const factor = Math.min(widthFactor * section.road.size, section.road.widthCap || Infinity);
        const curb = section.road.baseWidth * factor / 2 + 1.5;
        extra = Math.max(0, zone.parkingOffset * factor + 1.35 * factor + 3.6 - curb);
    }
    const distance = link?.type === 'walk' ? link.from.distance + (link.to.distance - link.from.distance) * sample.progress : node.distance;
    const direction = pathPoint(section.path, distance).angle;
    return { ...p, x: p.x + Math.sin(direction) * side * extra, y: p.y - Math.cos(direction) * side * extra,
        visible: true, moving: ['outbound', 'returning'].includes(group.state) &&
            !['crossing_wait', 'gap_wait', 'gap_middle_wait'].includes(person.state), group, layer: p.layer || 0 };
}
export const purposefulJourneyPose = groupPose;

export function journeyStory(town, car) {
    const trip = car.purposefulJourney;
    if (!trip) return null;
    if (trip.phase === 'returning-home') return 'No safe parking space this time. Following the roads back home, with everyone still in the car.';
    if (trip.phase === 'requested' || trip.phase === 'driving') return trip.kind === 'shops' ? 'Driving from home to the village shops, looking for a free parking space.' :
        trip.kind === 'school-pickup' ? 'Leaving work to collect a child from school, then driving home together.' : 'A lift from home to school. After walking to the gate, the parent will continue to work.';
    if (trip.phase === 'walking') return trip.group?.activity + '. The same car is waiting for them.';
    if (trip.phase === 'departing') return 'Everyone is back safely. Waiting for a clear gap to pull out.';
    return trip.kind === 'school-run' ? 'School drop-off finished. The parent is continuing to work.' :
        trip.kind === 'school-pickup' ? 'School pickup finished. Parent and child are driving home together.' : 'Shopping back in the car. Returning to the same neighbourhood we came from.';
}
