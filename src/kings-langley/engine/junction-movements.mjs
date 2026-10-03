import { position } from './graph.mjs';
import { laneOffset } from './traffic-model.mjs';

const laneKey = claim => `${claim.edge}:${claim.fromLane ?? claim.lane}:${claim.next}:${claim.lane}`;
function movement(data, claim, cache) {
  const key = laneKey(claim);
  if (cache.has(key)) return cache.get(key);
  const edge = data.edges[claim.edge], next = data.edges[claim.next];
  const incoming = position(edge, edge.length), outgoing = position(next, 0);
  const before = laneOffset(edge, claim.fromLane ?? claim.lane), after = laneOffset(next, claim.lane);
  const reach = Math.max(12, Math.abs(before) * 2 + 4, Math.abs(after) * 2 + 4);
  // A small lane diagram around the shared junction. The curve approaches and
  // leaves in the actual surveyed road directions, on the British left side.
  const a = [-incoming.dx * reach + incoming.dy * before, -incoming.dy * reach - incoming.dx * before];
  const d = [outgoing.dx * reach + outgoing.dy * after, outgoing.dy * reach - outgoing.dx * after];
  const b = [a[0] + incoming.dx * reach * 0.8, a[1] + incoming.dy * reach * 0.8];
  const c = [d[0] - outgoing.dx * reach * 0.8, d[1] - outgoing.dy * reach * 0.8];
  const points = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16, u = 1 - t;
    return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0],
      u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]];
  });
  cache.set(key, points);
  return points;
}
function pointDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentsDistance(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  if (ac * ad < 0 && ca * cb < 0) return 0;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}

export function movementsCompatible(data, a, b, shapes = new Map(), results = new Map()) {
  const aa = laneKey(a), bb = laneKey(b), width = ((a.car?.width || 2.5) + (b.car?.width || 2.5)) / 2 + 0.25;
  const long = [a.car, b.car].some(car => ['bus', 'lorry'].includes(car?.type) || car?.length > 12);
  const key = aa < bb ? `${aa}|${bb}|${width}|${long}` : `${bb}|${aa}|${width}|${long}`;
  if (results.has(key)) return results.get(key);
  let compatible = true;
  const turnsCorner = claim => {
    const edge = data.edges[claim.edge], next = data.edges[claim.next];
    const before = position(edge, edge.length), after = position(next, 0);
    return before.dx * after.dx + before.dy * after.dy < 0.94;
  };
  if ((a.edge === b.edge && (a.fromLane ?? a.lane) === (b.fromLane ?? b.lane)) ||
      (a.next === b.next && a.lane === b.lane)) compatible = false;
  // Long illustrated bodies need extra turning room at the hard corners of
  // surveyed polylines. Keep those corner pairs exclusive; opposite buses
  // travelling straight can still use their separate lanes simultaneously.
  else if (long && (turnsCorner(a) || turnsCorner(b))) compatible = false;
  else {
    const pa = movement(data, a, shapes), pb = movement(data, b, shapes);
    for (let i = 1; i < pa.length && compatible; i++) for (let j = 1; j < pb.length; j++) {
      if (segmentsDistance(pa[i - 1], pa[i], pb[j - 1], pb[j]) < width) { compatible = false; break; }
    }
  }
  results.set(key, compatible);
  return compatible;
}
