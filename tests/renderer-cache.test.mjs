import test from 'node:test';
import assert from 'node:assert/strict';
import { RealMapRenderer } from '../src/real-map-renderer.mjs';

function canvas() {
    const calls = [];
    const context = new Proxy({ calls }, {
        get(target, key) { return key in target ? target[key] : (...args) => calls.push({ name: key, args }); },
    });
    return { width: 0, height: 0, getContext: () => context };
}

function fixture() {
    globalThis.document = { createElement: canvas };
    globalThis.devicePixelRatio = 2;
    globalThis.innerWidth = 1200;
    globalThis.innerHeight = 800;
    const bridge = { layer: 1, tags: { waterway: 'canal' },
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        path: { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] } };
    const town = { map: { roads: [], context: [bridge], landmarks: [], data: { nodes: {} } },
        walking: { crossings: [] }, people: [],
        simulation: { cars: [], time: 0, parking: { zones: [] }, incoming: new Map() } };
    const scenery = { schools: [], buildings: [], trees: [] };
    const renderer = new RealMapRenderer(canvas()), view = { x: 0, y: 0, scale: 2 };
    return { renderer, town, scenery, view };
}

test('panning reuses padded scenery and bridge surfaces with the same world translation', () => {
    const { renderer, town, scenery, view } = fixture();
    assert.equal(renderer.cache(town, scenery, view, 2.5), true);
    const bridge = renderer.bridges.get(1), background = renderer.scenery;
    const cachedCalls = background.getContext('2d').calls.length;
    view.x = 30; view.y = -20;
    assert.equal(renderer.needsCache(view, 2.5, town), false);
    assert.equal(renderer.cache(town, scenery, view, 2.5), false);
    assert.equal(background.getContext('2d').calls.length, cachedCalls);
    assert.deepEqual(renderer.cacheView, { x: 0, y: 0, scale: 2 });
    renderer.render();
    const blits = renderer.ctx.calls.filter(call => call.name === 'drawImage');
    assert.equal(blits.length, 2);
    assert.equal(blits[0].args[0], background);
    assert.equal(blits[1].args[0], bridge);
    for (const { args } of blits) assert.deepEqual(args.slice(1), [-440, -240]);
    // The cached origin and live world origin agree after translating the image.
    const cachedOrigin = [(1200 / 2 + 160) * 2, (800 / 2 + 160) * 2];
    assert.deepEqual(cachedOrigin.map((value, index) => value + blits[0].args[index + 1]),
        [(1200 / 2 - view.x * view.scale) * 2, (800 / 2 - view.y * view.scale) * 2]);
    view.x = renderer.cachePadding / view.scale + 1;
    assert.equal(renderer.needsCache(view, 2.5, town), true);
    assert.equal(renderer.cache(town, scenery, view, 2.5), true);
    assert.equal(renderer.bridges.get(1), bridge, 'bridge surface allocation is reused when repainting');
    assert.equal(renderer.cacheView.x, view.x);
});

test('zoom, road width, town, viewport size and pixel density invalidate cached geometry', () => {
    const { renderer, town, scenery, view } = fixture();
    renderer.cache(town, scenery, view, 2.5);
    view.scale = 3;
    assert.equal(renderer.needsCache(view, 2.5, town), true);
    renderer.cache(town, scenery, view, 2.5);
    assert.equal(renderer.needsCache(view, 3, town), true);
    renderer.cache(town, scenery, view, 3);
    const replacement = { ...town };
    assert.equal(renderer.needsCache(view, 3, replacement), true);
    renderer.cache(replacement, scenery, view, 3);
    globalThis.innerWidth = 1440;
    assert.equal(renderer.needsCache(view, 3, replacement), true);
    renderer.cache(replacement, scenery, view, 3);
    assert.equal(renderer.canvas.width, 2880);
    assert.equal(renderer.scenery.width, (1440 + 320) * 2);
    assert.equal(renderer.bridges.get(1).width, renderer.scenery.width);
    globalThis.devicePixelRatio = 1;
    assert.equal(renderer.needsCache(view, 3, replacement), true);
    renderer.cache(replacement, scenery, view, 3);
    assert.equal(renderer.canvas.width, 1440);
    assert.equal(renderer.needsCache(view, 3, replacement), false);
});
