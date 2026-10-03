// Illustrative temperaments, not measured individual driving behaviour.
// All drivers obey the same current collision and stop-line constraints.
export const DRIVER_PROFILES = Object.freeze({
  cautious: Object.freeze({ label: 'Cautious', reactionTime: 0.95, pullAwayDelay: 0.65,
    headwayFactor: 1.28, gapFactor: 1.18, accelerationFactor: 0.8, speedFactor: 0.97 }),
  ordinary: Object.freeze({ label: 'Ordinary', reactionTime: 0.6, pullAwayDelay: 0.35,
    headwayFactor: 1, gapFactor: 1, accelerationFactor: 1, speedFactor: 1 }),
  confident: Object.freeze({ label: 'Confident', reactionTime: 0.35, pullAwayDelay: 0.15,
    headwayFactor: 0.88, gapFactor: 0.92, accelerationFactor: 1.08, speedFactor: 1 }),
});

function variation(seed, id) {
  let n = (seed ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0;
  n = Math.imul(n ^ n >>> 16, 0x21f0aaad);
  n = Math.imul(n ^ n >>> 15, 0x735a2d97);
  return ((n ^ n >>> 15) >>> 0) / 4294967296;
}

export function createDriver(seed, id, type, profile = null) {
  if (type === 'bicycle') return null;
  const draw = variation(seed, id);
  profile ??= draw < 0.25 ? 'cautious' : draw < 0.8 ? 'ordinary' : 'confident';
  const definition = DRIVER_PROFILES[profile];
  if (!definition) throw Error('Unknown driver profile');
  const factor = 0.92 + variation(seed ^ 0x5bd1e995, id) * 0.16;
  return Object.freeze({ profile, ...definition,
    reactionTime: definition.reactionTime * factor,
    pullAwayDelay: definition.pullAwayDelay * factor,
    // Large vehicles keep at least their vehicle-class following clearances.
    headwayFactor: ['bus', 'lorry'].includes(type) ? Math.max(1, definition.headwayFactor) : definition.headwayFactor,
    gapFactor: ['bus', 'lorry'].includes(type) ? Math.max(1, definition.gapFactor) : definition.gapFactor,
  });
}

export function applyDriver(vehicle, driver) {
  if (!driver || vehicle.driver === driver) return;
  const previous = vehicle.driver;
  for (const [field, factor] of [['a', 'accelerationFactor'], ['headway', 'headwayFactor'],
    ['minGap', 'gapFactor'], ['desiredFactor', 'speedFactor']])
    vehicle[field] *= driver[factor] / (previous?.[factor] ?? 1);
  vehicle.driver = driver;
  vehicle.driverState = null;
}

export function resetDriverResponse(vehicle) {
  vehicle.driverState = null;
}

/** Delay improvements in acceleration, never a newly observed danger. The
 * bounded history stores acceleration requests rather than stale road gaps:
 * current leader, junction, signal and crossing constraints remain immediate.
 */
export function driverAcceleration(vehicle, immediate, time, preciseStop = false) {
  const driver = vehicle.driver;
  if (!driver) return immediate;
  if (preciseStop) {
    resetDriverResponse(vehicle);
    return immediate;
  }
  const state = vehicle.driverState ??= { history: [{ time: time - driver.reactionTime, acceleration: immediate }],
    awaitingStart: vehicle.v < 0.15, readyAt: null, phase: 'driving', remaining: 0 };
  const history = state.history;
  if (time - history.at(-1).time >= 0.05 - 1e-8) history.push({ time, acceleration: immediate });
  while (history.length > 1 && history[1].time <= time - driver.reactionTime + 1e-8) history.shift();
  let acceleration = Math.min(immediate, history[0].acceleration);
  if (vehicle.v < 0.15 && immediate <= 0.02) {
    state.awaitingStart = true;
    state.readyAt = null;
  }
  state.remaining = 0;
  if (state.awaitingStart) {
    if (acceleration > 0.05) {
      state.readyAt ??= time + driver.pullAwayDelay;
      state.remaining = Math.max(0, state.readyAt - time);
      if (state.remaining > 1e-8) {
        state.phase = 'pulling-away';
        return Math.min(0, immediate);
      }
      state.awaitingStart = false;
    } else {
      state.readyAt = null;
      state.phase = immediate > 0.05 ? 'reacting' : 'waiting';
      state.remaining = state.phase === 'reacting' ? Math.max(0,
        (history.find(sample => sample.acceleration > 0.05)?.time ?? time) + driver.reactionTime - time) : 0;
      return Math.min(0, acceleration);
    }
  }
  state.phase = acceleration + 0.05 < immediate ? 'reacting' : 'driving';
  return acceleration;
}
