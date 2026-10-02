import { canTurn } from './kings-langley/engine/graph.mjs';

const LOCAL = new Set(['residential', 'unclassified', 'living_street']);
const CAPACITY = 4;

function stateFor(town) {
  if (!town.villageVisits) town.villageVisits = { pending: [], active: new Set(), clock: 0 };
  const state = town.villageVisits, alive = new Set(town.simulation.cars.map(c => c.id));
  for (const id of state.active) if (!alive.has(id)) state.active.delete(id);
  return state;
}

function visitRoutes(simulation, zone) {
  const edges = simulation.data.edges;
  const available = edge => LOCAL.has(edge.tags.highway) &&
    !['no', 'private'].includes(edge.tags.access) && !['no', 'private'].includes(edge.tags.motor_vehicle) &&
    !simulation.closures.ways.has(edge.way);
  const clearApproach = edge => available(edge) && edge.length >= 45 && !simulation.parking.byEdge.has(edge.id);
  const forwards = zone.displays.map(part => part.edge);
  const backwards = [...forwards].reverse().map(edge => edges.find(reverse => reverse.from === edge.to && reverse.to === edge.from && reverse.way === edge.way));
  if (backwards.some(edge => !edge)) return null;
  const routes = [];
  for (const passage of [forwards, backwards]) {
    if (passage.some(edge => !available(edge))) return null;
    const first = passage[0], last = passage.at(-1);
    const incoming = edges.filter(edge => clearApproach(edge) && canTurn(simulation.graph, edge, first))
      .sort((a, b) => a.length - b.length)[0];
    const outgoing = (simulation.graph.out.get(last.to) || [])
      .filter(edge => clearApproach(edge) && canTurn(simulation.graph, last, edge))
      .sort((a, b) => a.length - b.length)[0];
    if (!incoming || !outgoing) return null;
    routes.push([incoming.id, ...passage.map(edge => edge.id), outgoing.id]);
  }
  return routes;
}

// A small opt-in pair of neighbours makes giving way discoverable. These are
// ordinary journeys from adjoining streets, not cars placed in the bottleneck.
export function stageParkingVisit(town, roadName) {
  const state = stateFor(town), simulation = town.simulation;
  if (town.trafficLevel === 0) { state.pending = []; return 0; }
  if (state.pending.length + state.active.size > CAPACITY - 2) return 0;
  const zones = simulation.parking.zones.filter(zone => zone.localObservation && zone.name === roadName)
    .sort((a, b) => a.capacity - b.capacity);
  for (const zone of zones) {
    const routes = visitRoutes(simulation, zone);
    if (!routes) continue;
    for (const path of routes) state.pending.push({ path, roadName, queuedAt: simulation.time, car: null });
    state.clock = 0.5;
    return 2;
  }
  return 0;
}

export function updateVillageVisits(town, dt) {
  if (!town.villageVisits || !(dt > 0)) return;
  const state = stateFor(town), simulation = town.simulation;
  if (town.trafficLevel === 0) { state.pending = []; state.clock = 0; return; }
  state.clock += dt;
  if (state.clock < 0.5) return;
  state.clock %= 0.5;
  let occupied = simulation.occupancy();
  const remaining = [];
  for (const request of state.pending) {
    // A closed entrance can be tried again later; an old click never leaves an
    // invisible, unbounded stream of traffic waiting to appear after a reset.
    if (simulation.time - request.queuedAt > 120) continue;
    if (simulation.cars.length >= simulation.maxVehicles || request.path.some(id => simulation.closures.ways.has(simulation.data.edges[id].way))) {
      remaining.push(request); continue;
    }
    if (!request.car) {
      const car = simulation.createVehicle(request.path, 'car', 0, 0);
      car.q = car.d = car.length + 14;
      car.v = 0;
      car.destination = simulation.data.edges[request.path.at(-1)].to;
      car.villageVisit = request.roadName;
      request.car = car;
    }
    const car = request.car, edge = simulation.data.edges[car.route[0]];
    if (simulation.crossingSpawnAllowed?.(car) === false || simulation.adaptive.spawnAllowed(car) === false || !simulation.parking.spawnAllowed(car)) {
      remaining.push(request); continue;
    }
    const conflict = (occupied.get(`${edge.id}:0`) || []).some(fragment => {
      // Inserting ahead of a moving neighbour needs its stopping distance,
      // rather than merely an empty car-sized rectangle at this instant.
      const rearClearance = Math.max(14, fragment.car.v * 1.5 + fragment.car.v ** 2 / (2 * Math.max(1, fragment.car.b)));
      return fragment.end > car.d - car.length - rearClearance && fragment.start < car.d + 14;
    });
    if (conflict) { remaining.push(request); continue; }
    car.born = simulation.time;
    simulation.parking.claimSpawn(car);
    simulation.cars.push(car);
    simulation.generated++;
    state.active.add(car.id);
    occupied = simulation.occupancy();
  }
  state.pending = remaining;
}
