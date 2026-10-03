// A miniature day advances from simulation.time, never the browser clock.
// Pause, speed controls and deterministic replay therefore share one clock.
export const DAY_PERIODS = Object.freeze({
    quiet: { id: 'quiet', label: 'Early morning', startMinutes: 6 * 60 + 30, demandFactor: 0.65 },
    'school-run': { id: 'school-run', label: 'School run', startMinutes: 8 * 60 + 10, demandFactor: 1.12 },
    everyday: { id: 'everyday', label: 'Village daytime', startMinutes: 10 * 60 + 30, demandFactor: 1 },
    afternoon: { id: 'afternoon', label: 'School pickup', startMinutes: 14 * 60 + 45, demandFactor: 1.08 },
    rush: { id: 'rush', label: 'Heading home', startMinutes: 17 * 60 + 15, demandFactor: 1.12 },
    evening: { id: 'evening', label: 'Village evening', startMinutes: 19 * 60 + 30, demandFactor: 0.72 },
});

const wrap = value => ((value % 1440) + 1440) % 1440;
const periodAt = minutes => minutes < 465 || minutes >= 1260 ? 'quiet' : minutes < 555 ? 'school-run' :
    minutes < 885 ? 'everyday' : minutes < 975 ? 'afternoon' : minutes < 1140 ? 'rush' : 'evening';
const format = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;

/** Attach {daySeconds,anchorTime,anchorMinutes,generation,clock}. A default
 * day takes one simulation hour; local trips retain their ordinary physics. */
export function attachVillageDay(town, { period = 'everyday', daySeconds = 3600, initialMinutes } = {}) {
    const definition = DAY_PERIODS[period] || DAY_PERIODS.everyday;
    town.villageDay = { daySeconds: Number.isFinite(daySeconds) && daySeconds > 0 ? daySeconds : 3600,
        anchorTime: town.simulation.time, anchorMinutes: Number.isFinite(initialMinutes) ? wrap(initialMinutes) : definition.startMinutes,
        generation: 0, clock: null };
    return updateVillageDay(town);
}

/** Return {minutes,label,period,day,demandFactor,absoluteMinutes,generation}.
 * Pure sampling also works when the clock is queried while paused. */
export function villageClock(town) {
    if (!town.villageDay) attachVillageDay(town);
    const state = town.villageDay;
    const absoluteMinutes = state.anchorMinutes + Math.max(0, town.simulation.time - state.anchorTime) * 1440 / state.daySeconds;
    const minutes = wrap(absoluteMinutes), period = periodAt(minutes);
    return { minutes, label: format(minutes), period, day: Math.floor(absoluteMinutes / 1440),
        demandFactor: DAY_PERIODS[period].demandFactor,
        absoluteMinutes, generation: state.generation };
}

/** Update before road arrivals; this does not advance simulation.time. */
export function updateVillageDay(town) {
    if (!town.villageDay) return attachVillageDay(town);
    town.villageDay.clock = villageClock(town);
    return town.villageDay.clock;
}

/** Jump the displayed village time and begin a fresh demand schedule.
 * Existing journeys are deliberately allowed to finish. */
export function setVillagePeriod(town, id) {
    const definition = DAY_PERIODS[id];
    if (!definition) return false;
    if (!town.villageDay) attachVillageDay(town);
    const state = town.villageDay, previous = villageClock(town);
    state.anchorTime = town.simulation.time;
    state.anchorMinutes = previous.day * 1440 + definition.startMinutes;
    state.generation++;
    updateVillageDay(town);
    return true;
}
