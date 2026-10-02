import { findRoute } from './kings-langley/engine/graph.mjs';
import { laneCount } from './kings-langley/engine/traffic-model.mjs';

// This is deliberately a labelled demonstration, not a claim that an event was
// observed in live Kings Langley traffic. The two cars still obey every ordinary
// occupancy, crossing, parking and turn-space constraint in the miniature.
function canPlace(simulation, car) {
  if (simulation.crossingSpawnAllowed?.(car) === false || !simulation.adaptive.spawnAllowed(car) || !simulation.parking.spawnAllowed(car)) return false;
  if (car.parkingPassages.some(p => car.q > p.entry - 20 && car.q - car.length < p.exit + 20)) return false;
  const occupied = simulation.occupancy();
  for (let i = 0; i <= car.index; i++) {
    const edge = simulation.data.edges[car.route[i]], start = car.q - car.length - car.offsets[i], end = car.q - car.offsets[i];
    if (end <= 0 || start >= edge.length) continue;
    for (const fragment of occupied.get(`${edge.id}:${car.lanes[i]}`) || []) {
      const stoppingDistance = fragment.car.v * 1.5 + fragment.car.v * fragment.car.v / 4;
      if (end + 10 > fragment.start && start - Math.max(10, stoppingDistance) < fragment.end) return false;
    }
  }
  return true;
}

export function stageTurnDemonstration(town) {
  const sim = town.simulation, adaptive = sim.adaptive;
  if (sim.cars.length + 2 > sim.maxVehicles || adaptive.turns.size) return null;
  const graph = adaptive.graph('car');
  const roads = sim.data.edges.filter(edge =>
    ['residential', 'unclassified', 'living_street'].includes(edge.tags.highway) &&
    edge.length >= 100 && edge.speed <= 14 && laneCount(edge) === 1 &&
    !edge.tags.bridge && !edge.tags.tunnel && !edge.tags.junction &&
    !edge.restoredUnderpass && !sim.closures.ways.has(edge.way) &&
    !sim.parking.byEdge.has(edge.id));
  // Water Lane has a useful real alternative via the surrounding street graph.
  roads.sort((a, b) => Number(b.tags.name === 'Water Lane') - Number(a.tags.name === 'Water Lane') || a.id - b.id);
  const destinations = town.map.landmarks.filter(place => place.nodeId).map(place => place.nodeId);
  let attempts = 0;
  for (const edge of roads) for (const destination of destinations) {
    if (attempts++ >= 80) return null;
    const rest = findRoute(graph, edge.to, destination, edge, candidate => adaptive.cost(candidate));
    if (!rest?.length) continue;
    const path = [edge.id, ...rest], car = sim.createVehicle(path, 'car', edge.length * 0.45);
    car.length = 8; // A compact car, within the miniature's normal 7.98–10.92 m range.
    const centre = car.d - car.length / 2, radius = Math.max(18, car.length + 5);
    if (!canPlace(sim, car) || !adaptive.turnSpace(car, edge, centre, radius)) continue;
    const blocker = sim.createVehicle(path, 'car', Math.min(edge.length - 12, car.d + 55));
    blocker.length = 8;
    if (blocker.q - blocker.length < centre + radius + 5 || !canPlace(sim, blocker)) continue;
    blocker.roadStop = { q: blocker.q, duration: 32, remaining: 32, done: false };
    blocker.stopped = 12;
    blocker.nextRouteReview = sim.time + 45;
    blocker.behaviour = { kind: 'demonstration-stop', description: 'A short stop for our turning demonstration', until: sim.time + 32 };
    const oldDelay = adaptive.delay.get(edge.id);
    // The known, finite stop ahead is a real wait in this little staged scene.
    adaptive.delay.set(edge.id, Math.max(oldDelay || 0, blocker.roadStop.remaining));
    sim.cars.push(car, blocker);
    if (adaptive.tryTurnaround(car, destination)) {
      car.demonstration = 'three-point-turn';
      car.behaviour.description = 'A little demonstration: turning around the stopped car';
      sim.generated += 2;
      return car;
    }
    sim.cars = sim.cars.filter(candidate => candidate !== car && candidate !== blocker);
    if (oldDelay === undefined) adaptive.delay.delete(edge.id); else adaptive.delay.set(edge.id, oldDelay);
  }
  return null;
}
