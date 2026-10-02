export function vehicleStory(town, car) {
    const s = town.simulation;
    if (car.turnaround) return `${car.turnaround.phase}. ${car.demonstration ? 'Forward, reverse, forward — watch our little demonstration.' : 'A three-point turn to find another way.'}`;
    if (car.demonstration) return 'Turn complete! Now taking another way through the village.';
    const passage = car.parkingPassages?.find(p => p.zone.narrow && car.q <= p.exit && p.entry - car.q < 40);
    if (passage) return passage.zone.claims.has(car.id) ? 'My turn! Squeezing carefully past the parked cars.' : 'Waiting for the other drivers. There is only room for one direction.';
    if (car.behaviour?.until > s.time) return car.behaviour.description + '.';
    const edge = town.map.data.edges[car.route[car.index]];
    const crossing = s.crossingStop?.(car, edge);
    if (car.v < 1 && crossing - car.d < 35) return 'Letting someone finish crossing the road.';
    if (car.v < 1 && edge.length - car.d < 40 && s.signal(edge) === 'red') return 'Red means a little wait. Green means off we go.';
    if (car.v < 0.5) return 'Waiting in a queue and watching for a way through.';
    if (car.type === 'bicycle') return 'Pedalling along, sharing the road with the bigger vehicles.';
    if (car.type === 'bus') return 'A colourful village bus, following its own journey.';
    return 'Main roads first. A quieter way round if the queues get long.';
}
