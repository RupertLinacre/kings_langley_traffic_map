export const SCENARIOS = {
    quiet: { label: 'Quiet morning', period: 'quiet', traffic: 40, cyclists: 12, pedestrians: 80 },
    everyday: { label: 'Village life', period: 'everyday', traffic: 100, cyclists: 24, pedestrians: 140 },
    'school-run': { label: 'School run', period: 'school-run', traffic: 160, cyclists: 18, pedestrians: 160 },
    rush: { label: 'Rush hour', period: 'rush', traffic: 300, cyclists: 45, pedestrians: 220 },
};

const LIMITS = { traffic: [0, 600], cyclists: [0, 150], pedestrians: [0, 400], width: [150, 400], speed: [0.5, 8] };
const PERIODS = new Set(['quiet', 'school-run', 'everyday', 'afternoon', 'rush', 'evening']);

// Shared links describe a view and its miniature scene, not a live traffic feed.
export function readViewState(hash) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    if (params.get('v') !== '1') return null;
    const number = key => params.has(key) && params.get(key).trim() !== '' ? Number(params.get(key)) : NaN;
    const seed = number('seed');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
    const state = { seed };
    for (const [key, [low, high]] of Object.entries(LIMITS)) {
        const value = number(key);
        if (Number.isFinite(value)) state[key] = Math.max(low, Math.min(high, value));
    }
    if (![0.5, 1, 2, 4, 8].includes(state.speed)) delete state.speed;
    const x = number('x'), y = number('y'), scale = number('scale');
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(scale) && Math.abs(x) < 1e6 && Math.abs(y) < 1e6 && scale > 0 && scale <= 10) {
        state.view = { x, y, scale };
    }
    state.paused = params.get('paused') === '1';
    if (PERIODS.has(params.get('period'))) state.period = params.get('period');
    const villageMinutes = number('villageMinutes');
    if (state.period && villageMinutes >= 0 && villageMinutes < 1440) state.villageMinutes = villageMinutes;
    return state;
}

export function writeViewState({ seed, view, paused, ...settings }) {
    const params = new URLSearchParams({ v: '1', seed: String(seed >>> 0) });
    params.set('x', view.x.toFixed(2));
    params.set('y', view.y.toFixed(2));
    params.set('scale', view.scale.toFixed(5));
    for (const key of Object.keys(LIMITS)) if (Number.isFinite(settings[key])) params.set(key, String(settings[key]));
    if (PERIODS.has(settings.period)) {
        params.set('period', settings.period);
        if (Number.isFinite(settings.villageMinutes) && settings.villageMinutes >= 0 && settings.villageMinutes < 1440)
            params.set('villageMinutes', String(settings.villageMinutes));
    }
    if (paused) params.set('paused', '1');
    return `#${params}`;
}

export function scenarioFor(traffic, cyclists, pedestrians, period = null) {
    return Object.keys(SCENARIOS).find(key => {
        const scenario = SCENARIOS[key];
        return scenario.traffic === traffic && scenario.cyclists === cyclists && scenario.pedestrians === pedestrians &&
            (!period || scenario.period === period);
    }) || null;
}
