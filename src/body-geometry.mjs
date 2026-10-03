/** Clockwise corners of an oriented body in world metres. */
export function vehicleCorners(body) {
  const c = Math.cos(body.angle || 0), s = Math.sin(body.angle || 0);
  const halfLength = body.length / 2, halfWidth = body.width / 2;
  return [[-halfLength, -halfWidth], [halfLength, -halfWidth], [halfLength, halfWidth], [-halfLength, halfWidth]]
    .map(([x, y]) => ({ x: body.x + c * x - s * y, y: body.y + s * x + c * y }));
}

/** Exact rectangle SAT. Margin is the total additional desired body clearance. */
export function orientedBodiesOverlap(a, b, margin = 0) {
  if (!a || !b || (a.layer ?? 0) !== (b.layer ?? 0)) return false;
  const ac = Math.cos(a.angle || 0), as = Math.sin(a.angle || 0);
  const bc = Math.cos(b.angle || 0), bs = Math.sin(b.angle || 0);
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [x, y] of [[ac, as], [-as, ac], [bc, bs], [-bs, bc]]) {
    const distance = Math.abs(dx * x + dy * y);
    const ar = Math.abs(x * ac + y * as) * a.length / 2 + Math.abs(-x * as + y * ac) * a.width / 2;
    const br = Math.abs(x * bc + y * bs) * b.length / 2 + Math.abs(-x * bs + y * bc) * b.width / 2;
    if (distance >= ar + br + Math.max(0, margin)) return false;
  }
  return true;
}
