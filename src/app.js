import { prepareMap, createRealTown, setRealTraffic, setCyclistCount, setPedestrianCount, updateRealTown, updateRealMetrics, nearestNode, planRealTrip, realVehiclePose, roadWidthFactor, bounds } from './real-town.mjs';
import { createScenery } from './real-scenery.mjs';
import { RealMapRenderer } from './real-map-renderer.mjs';
import { MapCamera } from './camera.mjs';
import { connectMapInput } from './map-input.mjs';
import { sampleVehicleDistance, sampleMotionTime } from './render-motion.mjs';
import { SCENARIOS, scenarioFor, readViewState, writeViewState } from './view-state.mjs';
import { savePostcard } from './postcard.mjs';
import { pedestrianPose } from './real-pedestrians.mjs';
import { trainPose, trackPoint } from './railway.mjs';
import { vehicleStory } from './village-stories.mjs';
import { stageParkingVisit } from './village-visits.mjs';
import { stageTurnDemonstration } from './turn-demonstration.mjs';
import { turnaroundFits } from './kings-langley/engine/adaptive-traffic.mjs';

const $ = id => document.getElementById(id);
const canvas = $('road-canvas');
const speed = $('simulation-speed'), traffic = $('traffic-level'), width = $('road-size'), zoom = $('town-zoom');
const cyclists = $('cyclist-count'), people = $('people-count');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let renderer, camera, map, demand, town, scenery;
let paused = motionPreference.matches, planning = false, origin = null, destination = null, trip = null;
let frame = null, lastTime = 0, accumulator = 0, cacheDirty = true, lastMetrics = -1, loading = false;
let collapsed = matchMedia('(max-width: 720px)').matches;
let currentSeed, selectedVehicleId = null, following = false, lastInspection = -1, toastTimer;
let selectedOther = null, parkingVisit = 0;
let acceptedRoadWidth = Number(width.value) / 100;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

function notify(message) {
    clearTimeout(toastTimer);
    $('app-toast').textContent = message; $('app-toast').hidden = false;
    toastTimer = setTimeout(() => { $('app-toast').hidden = true; }, 4000);
}

function mapArea() {
    const panel = $('controls-panel');
    let left = 24, top = 24, right = innerWidth - 72, bottom = innerHeight - 76;
    if (innerWidth <= 720) {
        left = 16; top = 112; right = innerWidth - 56;
        if (!collapsed) bottom = Math.min(bottom, panel.offsetTop - 12);
        if (!$('selection-panel').hidden) bottom = Math.min(bottom, $('selection-panel').offsetTop - 12);
    } else if (!collapsed) left = panel.offsetLeft + panel.offsetWidth + 24;
    return { left, top, width: Math.max(120, right - left), height: Math.max(140, bottom - top) };
}

function updateLabels() {
    $('pause-label').textContent = paused ? 'Resume' : 'Pause';
    $('pause-town').setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    $('pause-town').setAttribute('aria-pressed', String(paused));
    $('town-state').textContent = paused ? 'Paused' : 'Town is alive';
    document.body.classList.toggle('town-paused', paused);
    if (!town) return;
    const metrics = town.metrics;
    $('bus-count').textContent = `${metrics.buses} buses`;
    $('car-count').textContent = `${Math.max(0, metrics.cars - metrics.buses)} other vehicles`;
    $('traffic-state').textContent = metrics.status;
    $('queue-count').textContent = `${metrics.waiting} waiting`;
    $('traffic-value').textContent = `${traffic.value}%`;
    $('cyclist-value').textContent = `${metrics.cyclists}`;
    $('people-value').textContent = `${metrics.pedestrians}`;
    cyclists.setAttribute('aria-valuetext', `${metrics.cyclists} cyclists on the road; ${cyclists.value} requested`);
    people.setAttribute('aria-valuetext', `${metrics.pedestrians} people walking`);
    $('road-size-value').textContent = `${(Number(width.value) / 100).toFixed(1)}×`;
    zoom.value = camera.zoomValue;
    $('zoom-value').textContent = camera.zoomValue < 50.01 ? 'Whole map' : `${Math.round(camera.view.scale / 1.6 * 100)}%`;
    zoom.setAttribute('aria-valuetext', $('zoom-value').textContent);
    width.setAttribute('aria-valuetext', `${Number(width.value) / 100} times road width`);
    traffic.setAttribute('aria-valuetext', `${traffic.value} percent; ${metrics.cars} vehicles`);
    const scenario = scenarioFor(Number(traffic.value), Number(cyclists.value), Number(people.value));
    for (const button of document.querySelectorAll('[data-scenario]')) button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario));
    if ($('map-scale')) {
        const metres = 100 / camera.view.scale;
        $('map-scale').textContent = `${Math.round(metres)} m`;
    }
}

function calculateTrip() {
    trip = origin && destination && origin.id !== destination.id ? planRealTrip(town, origin, destination) : null;
    const text = !origin ? 'Choose two places, or tap a start and finish on the map.' : !destination ? 'Now choose your destination.' :
        origin.id === destination.id ? 'Choose a different destination.' : !trip ? 'No connected driving route. Try another map point.' :
        `${(trip.metres / 1000).toFixed(1)} km · about ${Math.max(1, Math.round(trip.seconds / 60))} simulated min. Current queues included.`;
    if ($('trip-result').textContent !== text) $('trip-result').textContent = text;
    $('fit-trip').disabled = !trip;
    $('swap-trip').disabled = !origin && !destination;
}

function draw() {
    if (!town) return;
    const alpha = accumulator / 0.1;
    updateSelection(alpha);
    const labelsChanged = cacheDirty || lastMetrics !== town.metricClock;
    const needsCache = renderer.needsCache(camera.view, Number(width.value) / 100, town);
    if (cacheDirty || needsCache) {
        renderer.cache(town, scenery, camera.view, Number(width.value) / 100);
        cacheDirty = false;
    }
    if (lastMetrics !== town.metricClock) {
        lastMetrics = town.metricClock;
        if (planning) calculateTrip();
    }
    if (labelsChanged) updateLabels();
    renderer.render({ planning, origin, destination, trip: planning ? trip : null, alpha, paused, selectedVehicleId });
}

function tick(timestamp) {
    frame = null;
    if (!town || document.hidden) return;
    if (!paused) {
        if (lastTime) accumulator += Math.min((timestamp - lastTime) / 1000, 0.1) * Number(speed.value);
        while (accumulator >= 0.1) {
            renderer.captureMotion(town);
            updateRealTown(town, 0.1); accumulator -= 0.1;
        }
        lastTime = timestamp;
    }
    draw();
    if (!paused && frame === null) frame = requestAnimationFrame(tick);
}

function requestDraw(recache = false) {
    cacheDirty ||= recache;
    if (town && frame === null && !document.hidden) frame = requestAnimationFrame(tick);
}

function syncAnimation() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; lastTime = 0; accumulator = 0;
    if (town) renderer.captureMotion(town);
    updateLabels(); requestDraw();
}

function resizeMap() {
    if (!camera) return;
    renderer.resize();
    camera.resize(innerWidth, innerHeight, mapArea());
    requestDraw(true);
}

function setCollapsed(value) {
    if (!value && innerWidth <= 720 && (selectedVehicleId !== null || selectedOther)) clearSelection();
    collapsed = value;
    document.body.classList.toggle('controls-collapsed', value);
    $('toggle-controls').setAttribute('aria-expanded', String(!value));
    $('toggle-controls').setAttribute('aria-label', value ? 'Show town controls' : 'Hide town controls');
    $('controls-panel').inert = value;
    resizeMap();
}

function setPlanning(value) {
    if (value) clearSelection();
    planning = value;
    $('planner-panel').hidden = !value;
    $('plan-trip').setAttribute('aria-expanded', String(value));
    $('plan-trip-label').textContent = value ? 'Close journey planner' : 'Plan a journey';
    document.body.classList.toggle('planning-trip', value);
    if (value) { setCollapsed(false); calculateTrip(); $('trip-from').focus(); }
    else resizeMap();
    requestDraw();
}

function resetTrip() {
    origin = destination = trip = null;
    for (const [id, placeholder] of [['trip-from', 'Starting place'], ['trip-to', 'Destination']]) {
        const select = $(id);
        select.replaceChildren(new Option(placeholder, ''));
        for (const place of map.landmarks) {
            const node = map.data.nodes[place.nodeId] || nearestNode(map, place.p, town.simulation);
            select.add(new Option(place.name, node.id));
        }
    }
    calculateTrip(); requestDraw();
}

function startTraffic(seed = newSeed()) {
    clearSelection();
    currentSeed = seed;
    town = createRealTown(map, demand, seed, { cyclists: Number(cyclists.value), pedestrians: Number(people.value) });
    town.walking.widthFactor = Number(width.value) / 100;
    acceptedRoadWidth = town.walking.widthFactor;
    setRealTraffic(town, Number(traffic.value) / 100);
    scenery = createScenery(map, seed);
    for (let i = 0; i < 30; i++) updateRealTown(town, 0.1);
    lastMetrics = -1; cacheDirty = true;
    resetTrip(); syncAnimation();
}

function focusPlace(id) {
    if (!camera) return;
    setFollowing(false);
    if (id === 'whole') camera.fit();
    else {
        const place = map.landmarks.find(item => item.id === id);
        if (!place) return;
        camera.focus(place.p, place.zoom);
    }
    $('place-focus').value = id;
    requestDraw(true);
}

function selectMapPoint(point) {
    if (!planning) {
        const vehicle = renderer.hitTest(point, Math.max(6, 15 / camera.view.scale));
        const distance = p => Math.hypot(p.x - point[0], p.y - point[1]);
        const nearby = town.people.map(person => ({ person, p: pedestrianPose(town, person, Number(width.value) / 100) }))
            .filter(({ p }) => distance(p) < 11 / camera.view.scale).sort((a, b) => distance(a.p) - distance(b.p));
        const carDistance = vehicle ? distance(renderer.lastVehiclePoses.get(vehicle.id).p) : Infinity;
        if (nearby.length && distance(nearby[0].p) < carDistance) selectOther({ kind: 'person', id: nearby[0].person.id });
        else if (vehicle) selectVehicle(vehicle);
        else {
            const train = town.trains.find(train => {
                const head = trainPose(train, town.simulation.time);
                return Array.from({ length: train.carriages }, (_, i) => head.q - i * 20)
                    .some(q => q >= 0 && q <= train.route.length && distance(trackPoint(train.route, q)) < 12 / camera.view.scale);
            });
            if (train) selectOther({ kind: 'train', id: train.id }); else clearSelection();
        }
        return;
    }
    const node = nearestNode(map, point, town.simulation);
    if (!origin || destination) { origin = node; destination = null; $('trip-to').value = ''; }
    else destination = node;
    setTripSelect(destination ? $('trip-to') : $('trip-from'), node);
    calculateTrip(); fitTrip(); requestDraw();
}

function setTripSelect(select, node) {
    if (node && ![...select.options].some(option => option.value === String(node.id))) {
        const edge = town.simulation.graph.out.get(node.id)?.[0];
        select.add(new Option(edge?.tags.name || 'Map point', node.id));
    }
    select.value = node?.id ?? '';
}

function fitTrip() {
    if (!trip) return;
    camera.frame(bounds(trip.edges.flatMap(edge => edge.points)));
    $('place-focus').value = '';
    requestDraw(true);
}

function setFollowing(value) {
    following = value;
    if (value) $('place-focus').value = '';
    $('follow-selected').textContent = value ? 'Stop following' : 'Follow';
    $('follow-selected').setAttribute('aria-pressed', String(value));
    document.body.classList.toggle('following-vehicle', value);
    requestDraw();
}

function clearSelection() {
    selectedVehicleId = null; lastInspection = -1;
    selectedOther = null;
    setFollowing(false);
    const wasOpen = !$('selection-panel').hidden;
    $('selection-panel').hidden = true;
    document.body.classList.remove('vehicle-selected');
    if (wasOpen) resizeMap();
}

function selectVehicle(vehicle, follow = false) {
    if (planning) setPlanning(false);
    selectedOther = null;
    selectedVehicleId = vehicle.id; lastInspection = -1;
    showSelection(follow);
}

function showSelection(follow) {
    $('follow-selected').hidden = selectedOther?.kind === 'place';
    $('selection-panel').hidden = false;
    $('map-hint').hidden = true;
    document.body.classList.add('vehicle-selected');
    if (innerWidth <= 720) setCollapsed(true);
    else resizeMap();
    setFollowing(follow);
    if (follow && camera.zoomValue < 95) camera.zoomAt(camera.scaleAt(100));
    canvas.focus({ preventScroll: true });
    requestDraw(true);
}

function selectOther(target, follow = false) {
    if (planning) setPlanning(false);
    selectedVehicleId = null; selectedOther = target; lastInspection = -1;
    showSelection(follow);
}

function updateOtherSelection(alpha) {
    const target = selectedOther;
    let p, title, description, story, status;
    if (target.kind === 'person') {
        const person = town.people.find(p => p.id === target.id);
        if (!person) { clearSelection(); return; }
        p = pedestrianPose(town, person, Number(width.value) / 100);
        title = 'A village wanderer'; description = p.road.tags.name || 'Along a village pavement';
        story = person.activity || 'Off for a little walk around the village.';
        status = person.state.includes('wait') ? 'Looking and waiting' : person.pause ? 'A little rest' : 'One step at a time';
    } else if (target.kind === 'train') {
        const train = town.trains.find(train => train.id === target.id);
        p = trainPose(train, sampleMotionTime(town, alpha, paused));
        title = train.local ? 'The village train' : 'An express train'; description = 'West Coast Main Line';
        story = p.stopped ? 'A stop at Kings Langley station. Time to hop aboard!' : 'Four carriages following the real railway through the village.';
        status = p.stopped ? 'At the station' : 'Rolling along the railway';
        if (p.q > train.route.length + 60) { clearSelection(); notify('The train has left the village. Another will be along soon.'); return; }
    } else {
        p = { x: target.p[0], y: target.p[1] }; title = target.title;
        description = 'Parked cars make the road narrower'; story = target.story; status = 'Two directions. Taking turns.';
    }
    if (following) camera.anchor([p.x, p.y], ...camera.centre);
    if (lastInspection < 0 || town.simulation.time - lastInspection > 0.4) {
        if (lastInspection < 0) $('town-status').textContent = `${title}. ${story}`;
        lastInspection = town.simulation.time;
        $('selection-title').textContent = title; $('selection-description').textContent = description;
        $('selection-story').textContent = story; $('selection-speed').textContent = status;
    }
    renderer.otherSelection = p;
}

function updateSelection(alpha) {
    renderer.otherSelection = null;
    if (selectedOther) { updateOtherSelection(alpha); return; }
    if (selectedVehicleId === null) return;
    const vehicle = town.simulation.cars.find(car => car.id === selectedVehicleId);
    if (!vehicle || vehicle.parked) {
        clearSelection(); notify(vehicle?.parked ? 'Journey complete. Time to park.' : 'That journey has reached the edge of our little world.');
        return;
    }
    const q = sampleVehicleDistance(town, vehicle, alpha, paused);
    const pose = realVehiclePose(town, { ...vehicle, q }, Number(width.value) / 100, paused ? 1 : alpha);
    if (following) {
        camera.anchor([pose.x, pose.y], ...camera.centre);
    }
    if (lastInspection < 0 || town.simulation.time - lastInspection > 0.4) {
        const newlySelected = lastInspection < 0;
        lastInspection = town.simulation.time;
        $('selection-title').textContent = vehicle.demonstration ? 'Three-point turn' : vehicle.type === 'bus' ? `Village bus ${vehicle.busStyle.number}` :
            vehicle.type === 'bicycle' ? 'A village cyclist' : { car: 'A little car', van: 'A village van', lorry: 'A passing lorry' }[vehicle.type] || 'A village journey';
        $('selection-description').textContent = pose.edge.tags.name || (pose.edge.tags.highway === 'motorway' ? 'On the M25' : 'On a village lane');
        if (vehicle.demonstration) $('selection-description').textContent += ' · a little demonstration';
        $('selection-story').textContent = vehicleStory(town, vehicle);
        const mph = Math.round(vehicle.v * 2.23694);
        $('selection-speed').textContent = vehicle.turnaround ? vehicle.turnaround.phase : mph > 0 ? `${mph} mph · ${vehicle.type === 'bicycle' ? 'pedalling along' : 'on the move'}` : 'Waiting a moment';
        if (newlySelected) $('town-status').textContent = `${$('selection-title').textContent} selected. ${following ? 'Following its journey.' : 'Vehicle details are open.'}`;
    }
}

function discover(kind) {
    let note;
    if (kind === 'parking') {
        const id = parkingVisit++ % 2 ? 'vicarage' : 'coniston';
        const place = map.landmarks.find(place => place.id === id);
        note = id === 'coniston' ? 'Parked cars line the northwest side. Watch drivers wait for a turn through the gap.' :
            'Between Marwood Close and Five Acres, parked cars line the north side. Which direction will go next?';
        stageParkingVisit(town, id === 'coniston' ? 'Coniston Road' : 'Vicarage Lane');
        selectOther({ kind: 'place', p: place.p, title: id === 'coniston' ? 'Coniston Road' : 'Vicarage Lane', story: note });
        camera.focus(place.p, 100); $('place-focus').value = id; requestDraw(true);
    } else if (kind === 'turning') {
        const car = stageTurnDemonstration(town);
        if (!car) { notify('No clear turning space just now. Try less traffic or wider roads.'); return; }
        updateRealMetrics(town); lastMetrics = -1;
        selectVehicle(car, true);
        camera.zoomAt(camera.scaleAt(140));
        note = 'A little demonstration: forward, reverse, forward! The car ahead makes a short stop, then drives away.';
        if (paused) notify('Press Resume to watch the three-point turn.');
    } else if (kind === 'cycling') {
        const riders = town.simulation.cars.filter(car => car.type === 'bicycle');
        if (!riders.length) { notify('Add some cyclists with the Cyclists slider to follow a ride.'); return; }
        selectVehicle(riders[Math.floor(town.simulation.time) % riders.length], true);
        note = 'A little bike, a big village. Watch the rider wait at lights and give way.';
    } else if (kind === 'walking') {
        const candidates = town.people.filter(person => person.crossing?.kind === 'gap');
        const walkers = candidates.length ? candidates : town.people.filter(person => person.route?.some(link => link.crossing?.kind === 'gap'));
        const person = walkers[0] || town.people[0];
        if (!person) { notify('Add some people with the People walking slider first.'); return; }
        selectOther({ kind: 'person', id: person.id }, true);
        note = 'Watch them look for a gap, cross one lane, and check the next lane.';
    } else {
        const train = town.trains.find(train => trainPose(train, town.simulation.time).q < train.route.length) || town.trains[0];
        if (!train) return;
        selectOther({ kind: 'train', id: train.id }, true);
        note = 'Count the carriages! The little local train pauses at Kings Langley station.';
    }
    $('explorer-note').textContent = note;
}

function followBus() {
    const centre = camera.worldAt(...camera.centre);
    const candidates = town.simulation.cars.filter(car => car.type === 'bus' && !car.parked).map(car => {
        const pose = realVehiclePose(town, car, Number(width.value) / 100);
        return { car, distance: Math.hypot(pose.x - centre[0], pose.y - centre[1]) };
    }).sort((a, b) => a.distance - b.distance);
    if (!candidates.length) { notify('No buses out just now. Try adding a little more traffic.'); return; }
    selectVehicle(candidates[0].car, true);
}

function applyScenario(key) {
    const scenario = SCENARIOS[key];
    traffic.value = scenario.traffic; cyclists.value = scenario.cyclists; people.value = scenario.pedestrians;
    setRealTraffic(town, scenario.traffic / 100);
    setCyclistCount(town, scenario.cyclists); setPedestrianCount(town, scenario.pedestrians);
    updateRealMetrics(town); lastMetrics = -1;
    requestDraw(); notify(`${scenario.label} in Kings Langley.`);
}

async function shareView() {
    if (!town) return;
    const url = new URL(location.href);
    url.hash = writeViewState({ seed: currentSeed, view: camera.view, paused,
        traffic: Number(traffic.value), cyclists: Number(cyclists.value), pedestrians: Number(people.value),
        width: Number(width.value), speed: Number(speed.value) });
    try {
        await navigator.clipboard.writeText(url.href);
        notify('View link copied. Open it to start a fresh journey here.');
    } catch {
        // The address bar remains a useful fallback when clipboard permission is unavailable.
        history.replaceState(null, '', url);
        notify('The view link is in your address bar, ready to copy.');
    }
}

$('toggle-controls').addEventListener('click', () => setCollapsed(!collapsed));
$('pause-town').addEventListener('click', () => { paused = !paused; syncAnimation(); });
$('plan-trip').addEventListener('click', () => setPlanning(!planning));
$('reset-trip').addEventListener('click', resetTrip);
$('fit-trip').addEventListener('click', fitTrip);
$('swap-trip').addEventListener('click', () => {
    [origin, destination] = [destination, origin];
    setTripSelect($('trip-from'), origin); setTripSelect($('trip-to'), destination);
    calculateTrip(); fitTrip(); requestDraw();
});
$('follow-bus').addEventListener('click', followBus);
$('follow-selected').addEventListener('click', () => setFollowing(!following));
$('close-selection').addEventListener('click', () => { clearSelection(); canvas.focus(); });
$('share-view').addEventListener('click', shareView);
$('save-postcard').addEventListener('click', async () => {
    if (!town) return;
    try {
        draw();
        await savePostcard(canvas);
        notify('A little piece of Kings Langley, saved as a postcard.');
    } catch { notify('The postcard could not be saved. Please try again.'); }
});
for (const button of document.querySelectorAll('[data-scenario]')) button.addEventListener('click', () => applyScenario(button.dataset.scenario));
for (const button of document.querySelectorAll('[data-discover]')) button.addEventListener('click', () => discover(button.dataset.discover));
$('new-town').addEventListener('click', () => { startTraffic(); $('town-status').textContent = 'Fresh traffic and scenery on the same Kings Langley streets.'; });
$('fit-town').addEventListener('click', () => focusPlace('whole'));
$('home-town').addEventListener('click', () => focusPlace('village'));
$('place-focus').addEventListener('change', event => focusPlace(event.target.value));
for (const [id, multiplier] of [['zoom-in', 1.25], ['zoom-out', 0.8]]) $(id).addEventListener('click', () => {
    if (camera) { camera.zoomAt(camera.view.scale * multiplier); requestDraw(true); }
});
traffic.addEventListener('input', () => { setRealTraffic(town, Number(traffic.value) / 100); lastMetrics = -1; requestDraw(); });
cyclists.addEventListener('input', () => { setCyclistCount(town, Number(cyclists.value)); updateRealMetrics(town); lastMetrics = -1; requestDraw(); });
people.addEventListener('input', () => { setPedestrianCount(town, Number(people.value)); updateRealMetrics(town); lastMetrics = -1; requestDraw(); });
width.addEventListener('input', () => {
    const requested = Number(width.value) / 100;
    const blocked = town.simulation.cars.some(car => car.turnaround &&
        !turnaroundFits(car, roadWidthFactor(map.roadById.get(map.data.edges[car.route[car.index]].way), requested)));
    if (blocked) {
        width.value = acceptedRoadWidth * 100;
        notify('Let the turning car finish before narrowing the road.');
    } else { acceptedRoadWidth = requested; town.walking.widthFactor = requested; }
    requestDraw(true);
});
zoom.addEventListener('input', () => { camera.zoomAt(camera.scaleAt(Number(zoom.value))); requestDraw(true); });
speed.addEventListener('change', syncAnimation);
for (const select of [$('trip-from'), $('trip-to')]) select.addEventListener('change', () => {
    origin = map.data.nodes[$('trip-from').value] || null;
    destination = map.data.nodes[$('trip-to').value] || null;
    calculateTrip(); fitTrip(); requestDraw();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && planning) { setPlanning(false); $('plan-trip').focus(); }
    else if (event.key === 'Escape' && (selectedVehicleId !== null || selectedOther)) { clearSelection(); canvas.focus(); }
    if (event.code === 'Space' && event.target === canvas && town) {
        event.preventDefault(); paused = !paused; syncAnimation();
    }
});
document.addEventListener('visibilitychange', syncAnimation);
motionPreference.addEventListener('change', event => {
    if (event.matches) { paused = true; syncAnimation(); }
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resizeMap, 100); });
$('controls-panel').addEventListener('toggle', resizeMap, true);
$('retry-load').addEventListener('click', load);
setCollapsed(collapsed);

async function load() {
    if (loading) return;
    loading = true;
    $('loading-panel').hidden = false;
    $('map-load-error').hidden = true;
    $('loading-message').textContent = 'Bringing the village to life…';
    document.body.classList.add('loading');
    $('simulation-controls').disabled = true;
    try {
        if (!canvas.getContext('2d')) throw new Error('Canvas is unavailable in this browser.');
        const assets = await Promise.all(['network', 'demand'].map(async name => {
            const response = await fetch(new URL(`../data/kings-langley/${name}.json`, import.meta.url));
            if (!response.ok) throw new Error(`Could not load ${name} (${response.status}).`);
            return response.json();
        }));
        map = prepareMap(assets[0]); demand = assets[1];
        renderer = new RealMapRenderer(canvas);
        camera = new MapCamera(map.bounds);
        resizeMap();
        $('place-focus').replaceChildren(new Option('Exploring the village', ''), ...map.landmarks.map(place => new Option(place.name, place.id)), new Option('Whole map', 'whole'));
        const shared = readViewState(location.hash);
        if (shared) {
            for (const [key, input] of Object.entries({ traffic, cyclists, pedestrians: people, width, speed })) {
                if (shared[key] !== undefined) input.value = shared[key];
            }
            paused = motionPreference.matches || shared.paused;
        }
        startTraffic(shared?.seed); focusPlace('village');
        if (shared?.view) {
            const b = map.bounds;
            camera.view.x = Math.max(b.left, Math.min(b.right, shared.view.x));
            camera.view.y = Math.max(b.top, Math.min(b.bottom, shared.view.y));
            camera.view.scale = Math.max(camera.fitScale, Math.min(camera.scaleAt(160), shared.view.scale));
            $('place-focus').value = ''; requestDraw(true);
        }
        connectMapInput(canvas, camera, {
            changed: () => { setFollowing(false); $('place-focus').value = ''; requestDraw(true); },
            selected: selectMapPoint,
        });
        $('loading-panel').hidden = true;
        $('simulation-controls').disabled = false;
        document.body.classList.remove('loading');
        $('town-status').textContent = paused ? motionPreference.matches ? 'Map ready. Animation paused for reduced motion.' : 'Map ready. Animation paused.' : 'Kings Langley is ready to explore.';
    } catch (error) {
        $('loading-message').textContent = 'The village could not load.';
        $('map-load-error').hidden = false;
        console.error(error);
    } finally { loading = false; }
}

load();
