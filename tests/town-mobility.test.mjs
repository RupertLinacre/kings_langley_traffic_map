import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMap, createRealTown, setRealTraffic, setCyclistCount, setPedestrianCount, updateRealTown, updateRealMetrics } from '../src/real-town.mjs';

const data = JSON.parse(readFileSync(new URL('../data/kings-langley/network.json', import.meta.url)));
const demand = JSON.parse(readFileSync(new URL('../data/kings-langley/demand.json', import.meta.url)));
const map = prepareMap(data);
const motors = town => town.simulation.cars.filter(car => car.type !== 'bicycle');
const bicycles = town => town.simulation.cars.filter(car => car.type === 'bicycle');

test('traffic and people controls are independent, including a car-free walking and cycling town', () => {
    const town = createRealTown(map, demand, 73);
    assert.equal(bicycles(town).length, 24);
    assert.equal(town.people.length, 140);
    const originalRiders = bicycles(town).map(car => car.id);
    setRealTraffic(town, 0);
    assert.equal(motors(town).length, 0);
    assert.deepEqual(bicycles(town).map(car => car.id), originalRiders);
    assert.equal(town.people.length, 140);
    for (let i = 0; i < 100; i++) updateRealTown(town, 0.1);
    assert.equal(motors(town).length, 0);
    assert.ok(bicycles(town).some(car => car.v > 0));
    assert.equal(town.metrics.cars, 0);
    assert.equal(town.metrics.status, 'Car-free');
    setRealTraffic(town, 1);
    const before = motors(town).map(car => car.id);
    setCyclistCount(town, 0);
    setPedestrianCount(town, 0);
    updateRealMetrics(town);
    assert.equal(bicycles(town).length, 0);
    assert.equal(town.people.length, 0);
    assert.deepEqual(motors(town).map(car => car.id), before);
    assert.equal(town.metrics.cyclists, 0);
    assert.equal(town.metrics.pedestrians, 0);
});

test('mixed traffic stays separated while both populations use the shortened street network', () => {
    const town = createRealTown(map, demand, 42, { cyclists: 80, pedestrians: 200 });
    for (let i = 0; i < 600; i++) {
        if (i === 300) setRealTraffic(town, 3);
        updateRealTown(town, 0.1);
        if (i % 10) continue;
        for (const [key, occupied] of town.simulation.occupancy()) {
            for (let j = 1; j < occupied.length; j++) {
                assert.ok(occupied[j - 1].end <= occupied[j].start + 0.001, `overlap at ${key} on step ${i}`);
            }
        }
    }
    assert.ok(bicycles(town).length > 0);
    assert.equal(town.people.length, 200);
    assert.ok(Number.isFinite(town.metrics.meanSpeed));
});
