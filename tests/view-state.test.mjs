import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewState, writeViewState, scenarioFor } from '../src/view-state.mjs';

test('view links round-trip a seed, camera and independent population settings', () => {
    const state = { seed: 4294967295, view: { x: -385.23, y: 105.5, scale: 1.625 }, paused: true,
        traffic: 300, cyclists: 45, pedestrians: 220, speed: 4, width: 300 };
    assert.deepEqual(readViewState(writeViewState(state)), state);
});

test('malformed links cannot introduce NaN, invalid speeds or unbounded populations', () => {
    assert.equal(readViewState('#v=1&seed=NaN'), null);
    assert.equal(readViewState('#v=1&seed=-1'), null);
    assert.equal(readViewState('#v=1&seed='), null);
    const state = readViewState('#v=1&seed=42&traffic=99999&cyclists=-3&pedestrians=Infinity&speed=3&x=NaN&y=1&scale=2');
    assert.deepEqual(state, { seed: 42, traffic: 600, cyclists: 0, paused: false });
});

test('custom settings do not misleadingly keep a preset selected', () => {
    assert.equal(scenarioFor(100, 24, 140), 'everyday');
    assert.equal(scenarioFor(100, 25, 140), null);
});
