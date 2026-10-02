// Keep the fixed-step simulation authoritative. Rendering follows the previous
// completed step along each vehicle's route, without changing any traffic state.
const frames = new WeakMap();

export function captureMotion(town) {
    frames.set(town, {
        time: town.simulation.time,
        cars: new Map(town.simulation.cars.map(car => [car.id, {
            vehicle: car, route: car.route, offsets: car.offsets,
            routeLength: car.route.length, q: car.q, parked: !!car.parked,
        }])),
    });
}

function fraction(alpha) {
    return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

export function sampleVehicleDistance(town, car, alpha = 1, paused = false) {
    const frame = frames.get(town), previous = frame?.cars.get(car.id);
    if (paused || !previous || frame.time >= town.simulation.time || previous.vehicle !== car ||
        previous.route !== car.route || previous.offsets !== car.offsets || previous.routeLength !== car.route.length ||
        previous.parked || car.parked || car.q < previous.q) return car.q;
    return previous.q + (car.q - previous.q) * fraction(alpha);
}

export function sampleMotionTime(town, alpha = 1, paused = false) {
    const frame = frames.get(town), now = town.simulation.time;
    if (paused || !frame || frame.time >= now) return now;
    return frame.time + (now - frame.time) * fraction(alpha);
}
