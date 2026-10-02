import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMotion, sampleVehicleDistance, sampleMotionTime } from '../src/render-motion.mjs';

function fixture() {
    const car = { id: 1, route: [3, 7], offsets: [0, 40, 80], q: 39, parked: null };
    return { car, town: { simulation: { time: 0, cars: [car] } } };
}

test('rendering interpolates route distance across a junction without changing simulation state', () => {
    const { town, car } = fixture();
    captureMotion(town);
    car.q = 41; car.index = 1; town.simulation.time = 0.1;
    const state = structuredClone(car);
    assert.equal(sampleVehicleDistance(town, car, 0), 39);
    assert.equal(sampleVehicleDistance(town, car, 0.5), 40);
    assert.equal(sampleVehicleDistance(town, car, 1), 41);
    assert.equal(sampleMotionTime(town, 0.5), 0.05);
    assert.deepEqual(car, state);
});

test('pausing, recapturing and replacing a town render its authoritative current state', () => {
    const { town, car } = fixture();
    assert.equal(sampleVehicleDistance(town, car, 0), 39);
    captureMotion(town); car.q = 41; town.simulation.time = 0.1;
    assert.equal(sampleVehicleDistance(town, car, 0, true), 41);
    assert.equal(sampleMotionTime(town, 0, true), 0.1);
    captureMotion(town);
    assert.equal(sampleVehicleDistance(town, car, 0), 41);
    assert.equal(sampleMotionTime(town, 0), 0.1);
    assert.equal(sampleVehicleDistance({ simulation: town.simulation }, car, 0), 41);
});

test('new or rerouted vehicles and parking transitions cannot inherit unrelated motion', () => {
    for (const change of [
        car => ({ ...car }),
        car => { car.route = [8, 9]; return car; },
        car => { car.offsets = [0, 20, 80]; return car; },
        car => { car.route.push(9); return car; },
        car => { car.parked = { slot: 0 }; return car; },
    ]) {
        const { town, car } = fixture();
        captureMotion(town); car.q = 41; town.simulation.time = 0.1;
        const changed = change(car);
        assert.equal(sampleVehicleDistance(town, changed, 0), 41);
    }
    const { town, car } = fixture();
    car.parked = { slot: 0 }; captureMotion(town);
    car.parked = null; car.q = 41; town.simulation.time = 0.1;
    assert.equal(sampleVehicleDistance(town, car, 0), 41);
});

test('display fractions stay inside the completed step and distance resets do not run backwards', () => {
    const { town, car } = fixture();
    captureMotion(town); car.q = 41; town.simulation.time = 0.1;
    assert.equal(sampleVehicleDistance(town, car, -1), 39);
    assert.equal(sampleVehicleDistance(town, car, 2), 41);
    assert.equal(sampleVehicleDistance(town, car, NaN), 41);
    car.q = 5;
    assert.equal(sampleVehicleDistance(town, car, 0), 5);
});
