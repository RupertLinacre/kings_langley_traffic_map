import test from 'node:test';
import assert from 'node:assert/strict';
import { MapCamera } from '../src/camera.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function camera() {
    const result = new MapCamera({ left: -2000, top: -3000, right: 2500, bottom: 2000 });
    result.resize(1440, 900, { left: 360, top: 24, width: 1000, height: 800 });
    result.focus([-294, -111]);
    return result;
}

test('zoom keeps the world point under the cursor fixed, including at zoom limits', () => {
    const c = camera(), point = c.worldAt(900, 240);
    for (const scale of [2, 100, 0.001, 1.6]) {
        c.zoomAt(scale, 900, 240);
        c.worldAt(900, 240).forEach((value, i) => close(value, point[i]));
        assert.ok(c.zoomValue >= 50 - 1e-8 && c.zoomValue <= 160 + 1e-8);
    }
});

test('landmarks centre in the uncovered map and stay there as panels or viewport change', () => {
    const c = camera();
    c.worldAt(...c.centre).forEach((value, i) => close(value, [-294, -111][i]));
    c.resize(390, 844, { left: 16, top: 112, width: 318, height: 550 });
    c.worldAt(...c.centre).forEach((value, i) => close(value, [-294, -111][i]));
    close(c.view.scale, 1.6);
});

test('whole-map fit keeps all bounds inside the uncovered area, also after resize', () => {
    const c = camera();
    c.fit();
    c.resize(390, 844, { left: 16, top: 112, width: 318, height: 550 });
    close(c.zoomValue, 50);
    const a = c.worldAt(c.area.left, c.area.top), b = c.worldAt(c.area.left + c.area.width, c.area.top + c.area.height);
    assert.ok(a[0] <= c.bounds.left && a[1] <= c.bounds.top);
    assert.ok(b[0] >= c.bounds.right && b[1] >= c.bounds.bottom);
});

test('framing a journey leaves its endpoints visible beside the controls', () => {
    const c = camera(), route = { left: -400, top: -220, right: 600, bottom: 750 };
    c.frame(route);
    const a = c.worldAt(c.area.left, c.area.top), b = c.worldAt(c.area.left + c.area.width, c.area.top + c.area.height);
    assert.ok(a[0] < route.left && a[1] < route.top);
    assert.ok(b[0] > route.right && b[1] > route.bottom);
});
