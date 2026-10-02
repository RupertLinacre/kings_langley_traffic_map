export const VEHICLES = {
  bicycle: {
    length: 5.6,
    width: 0.8,
    a: 0.8,
    b: 2,
    headway: 1.15,
    minGap: 1.8,
    maxSpeed: 6,
  },
  car: {
    length: 4.5,
    width: 1.8,
    a: 1.5,
    b: 2,
    headway: 1.35,
    minGap: 2,
    maxSpeed: 31.3,
  },
  van: {
    length: 6,
    width: 2,
    a: 1.2,
    b: 2,
    headway: 1.5,
    minGap: 2,
    maxSpeed: 29,
  },
  bus: {
    length: 12,
    width: 2.5,
    a: 0.8,
    b: 1.7,
    headway: 1.8,
    minGap: 2.5,
    maxSpeed: 22.2,
  },
  lorry: {
    length: 16.5,
    width: 2.5,
    a: 0.65,
    b: 1.6,
    headway: 1.9,
    minGap: 2.5,
    maxSpeed: 25,
  },
};
export function idmAcceleration(
  vehicle,
  desiredSpeed,
  gap = Infinity,
  leaderSpeed = 0,
) {
  const { v, a, b, headway, minGap } = vehicle;
  const desiredGap =
    minGap +
    Math.max(0, v * headway + (v * (v - leaderSpeed)) / (2 * Math.sqrt(a * b)));
  return Math.max(
    -8,
    a *
      (1 -
        (v / Math.max(0.1, desiredSpeed)) ** 4 -
        (desiredGap / Math.max(0.05, gap)) ** 2),
  );
}
export function integrate(v, acc, dt) {
  const next = Math.max(0, v + acc * dt);
  return {
    v: next,
    move:
      next === 0 && acc < 0
        ? (-v * v) / (2 * acc)
        : v * dt + 0.5 * acc * dt * dt,
  };
}
export function laneCount(edge) {
  const t = edge.tags || {},
    direction = t['oneway:motor_vehicle'] ?? t.oneway;
  const oneWay =
    ['yes', '1', 'true', '-1'].includes(direction) ||
    (direction === undefined &&
      (t.junction === 'roundabout' || t.highway === 'motorway'));
  const directional = Number(
    t[edge.forward ? 'lanes:forward' : 'lanes:backward'],
  );
  if (directional > 0) return Math.min(5, Math.floor(directional));
  const total = Number(t.lanes);
  if (total > 0)
    return Math.max(
      1,
      Math.min(
        5,
        oneWay
          ? Math.floor(total)
          : Math.floor((total - Number(t['lanes:both_ways'] || 0)) / 2),
      ),
    );
  return t.highway === 'motorway' ? 3 : 1;
}
export function laneOffset(edge, lane) {
  const t = edge.tags || {},
    oneWay =
      ['yes', '1', 'true', '-1'].includes(t.oneway) ||
      t.junction === 'roundabout' ||
      t.highway === 'motorway';
  // Screen y points south: positive offset is the driver's left.
  return oneWay
    ? ((laneCount(edge) - 1) / 2 - lane) * 3.3
    : (laneCount(edge) - lane - 0.5) * 3.1;
}
