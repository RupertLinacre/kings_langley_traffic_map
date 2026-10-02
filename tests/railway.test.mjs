import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareMap } from '../src/real-town.mjs';
import { createRailway, trackPoint, trainPose } from '../src/railway.mjs';

const map = prepareMap(JSON.parse(fs.readFileSync(new URL('../data/kings-langley/network.json', import.meta.url))));

test('trains join only contiguous surveyed track pieces and retain each bridge layer', () => {
    const trains = createRailway(map);
    assert.equal(trains.length, 2);
    for (const train of trains) {
        assert.ok(train.route.length > 1000);
        for (let i = 0; i < train.route.segments.length; i++) {
            const segment = train.route.segments[i];
            assert.equal(trackPoint(train.route, (segment.start + segment.end) / 2).layer, segment.item.layer);
            if (i) {
                const previous = train.route.segments[i - 1].item.points.at(-1), next = segment.item.points[0];
                assert.ok(Math.hypot(previous[0] - next[0], previous[1] - next[1]) < 0.15);
            }
        }
    }
});

test('the local train dwells at the station and resumes; a paused clock holds its pose', () => {
    const local = createRailway(map).find(train => train.local);
    const arrival = local.stop / local.speed + 3 - local.offset;
    const waiting = trainPose(local, arrival + 5);
    assert.equal(waiting.stopped, true);
    assert.equal(waiting.q, local.stop);
    assert.deepEqual(trainPose(local, arrival + 5), waiting);
    assert.ok(trainPose(local, arrival + 20).q > local.stop);
    assert.ok(trainPose(local, arrival - 1).speed < trainPose(local, arrival - 3).speed);
    assert.ok(trainPose(local, arrival + 19).speed < trainPose(local, arrival + 21).speed);
});
