import { journeyStory } from './purposeful-journeys.mjs';

export function vehicleStory(town, car) {
    const s = town.simulation;
    const activity = car.parkingActivity;
    if (activity) {
        const phases = { 'reverse-in': 'Reversing carefully into the space. Other drivers wait for the manoeuvre.',
            'merge-out': 'Indicator on. Pulling carefully away from the kerb.' };
        if (phases[activity.phase]) return phases[activity.phase];
    }
    const purpose = journeyStory(town, car);
    if (purpose) return purpose;
    if (car.parked?.zone) return car.roadStop.remaining === 0 ?
        'Ready to leave, waiting for a safe gap in both directions.' :
        'Parked for a little visit. This space will become free when the driver leaves.';
    if (car.parkingSearch && ['searching', 'full'].includes(car.parkingSearch.state)) return car.parkingSearch.state === 'full' ?
        'The parking spaces are full. Looking for a vacancy further along the street.' :
        'Looking along the kerb for a free parking space.';
    if (car.stationVisit) {
        const visit = car.stationVisit;
        if (visit.phase === 'approaching') return visit.kind === 'pickup' ? 'On the way to meet someone arriving on the local train.' : 'Giving someone a lift to catch the local train.';
        if (visit.phase === 'pulling-in') return 'Pulling carefully into a short-stay station bay.';
        if (visit.phase === 'turning-in-bay') return 'Turning around inside the station forecourt, ready for the journey home.';
        if (visit.phase === 'unloading') return 'Dropping off the passengers. They will walk into the station and wait for the train.';
        if (visit.phase === 'waiting') return 'Waiting in the station bay until the train passengers have reached the car.';
        if (visit.phase === 'ready-to-leave') return 'Passengers ready. Looking for a clear space to pull out of the station.';
        return visit.kind === 'pickup' ? 'Passengers aboard! Driving home after meeting the train.' : 'Drop-off complete. The passengers are off to catch their train.';
    }
    if (car.busPass) return 'A clear gap ahead. Carefully passing the stopped bus, then moving back to the left.';
    if (car.type === 'bus' && car.busService) {
        const service = car.busService;
        const availability = service.availability === 'sunday' ? 'Sunday and public holiday service. ' :
            service.availability === 'school' ? 'Schoolday service. ' : service.number === 'H19' ? 'Tuesday and Thursday service. ' :
            service.number === 'R9' ? 'Monday, Wednesday and Friday service. ' : '';
        const stop = car.roadStop;
        if (s.busOvertaking?.busHeld(car)) return `${availability}Service ${service.number} to ${service.destination}. Waiting for the overtaking car to return safely to the left.`;
        if (stop?.busStopId && !stop.done && stop.remaining > 0) {
            const name = stop.name || town.buses.stops.find(s => s.id === stop.busStopId)?.name || 'the bus stop';
            return `${availability}Service ${service.number} to ${service.destination}. Letting passengers on and off at ${name}.`;
        }
        return `${availability}${service.operator} service ${service.number}, heading to ${service.destination} and calling at the village bus stops.`;
    }
    if (car.turnaround) return `${car.turnaround.phase}. ${car.demonstration ? 'Forward, reverse, forward — watch our little demonstration.' : 'A three-point turn to find another way.'}`;
    if (car.demonstration) return 'Turn complete! Now taking another way through the village.';
    const passage = car.parkingPassages?.find(p => p.zone.narrow && car.q <= p.exit && p.entry - car.q < 40);
    if (passage) return passage.zone.claims.has(car.id) ? 'My turn! Squeezing carefully past the parked cars.' : 'Waiting for the other drivers. There is only room for one direction.';
    if (car.behaviour?.until > s.time) return car.behaviour.description + '.';
    const edge = town.map.data.edges[car.route[car.index]];
    const crossing = s.crossingStop?.(car, edge);
    if (car.v < 1 && crossing - car.d < 35) return 'Letting someone finish crossing the road.';
    if (car.v < 1 && edge.length - car.d < 40 && s.signal(edge) === 'red') return 'Red means a little wait. Green means off we go.';
    if (car.driverState?.phase === 'reacting') return 'The queue is starting to move. This driver takes a moment to notice the gap.';
    if (car.driverState?.phase === 'pulling-away') return 'A little pause, then off we go. Watch the queue start moving in a wave.';
    if (car.v < 0.5) return 'Waiting in a queue and watching for a way through.';
    if (car.type === 'bicycle') return 'Pedalling along, sharing the road with the bigger vehicles.';
    if (car.type === 'bus') return 'A colourful village bus, following its own journey.';
    return 'Main roads first. A quieter way round if the queues get long.';
}
