// A conservative broad phase for illustrated vehicle and pedestrian hulls.
// Full SAT / paved-surface checks remain the caller's responsibility. Index
// lifetimes are explicit; mutating a stored body requires update(body).
const layerOf = body => Number(body.layer ?? body.road?.layer ?? 0) || 0;
const boundsOf = body => {
  // Circumscribed circles also cover any heading change during a caller's
  // sweep. Their squares deliberately over-return rather than miss a hull.
  const radius = Math.hypot(body.length, body.width) / 2;
  return { left: body.x - radius, right: body.x + radius,
    top: body.y - radius, bottom: body.y + radius, layer: layerOf(body) };
};

export class BodySpatialIndex {
  constructor(bodies = [], cellSize = 32) {
    if (!(Number.isFinite(cellSize) && cellSize > 0)) throw Error('Body index cell size must be positive');
    this.cellSize = cellSize;
    this.cells = new Map();
    this.entries = new Map();
    for (const body of bodies) this.insert(body);
  }
  keys(bounds) {
    const result = [], size = this.cellSize;
    for (let x = Math.floor(bounds.left / size); x <= Math.floor(bounds.right / size); x++)
      for (let y = Math.floor(bounds.top / size); y <= Math.floor(bounds.bottom / size); y++)
        result.push(`${bounds.layer}:${x}:${y}`);
    return result;
  }
  insert(body) {
    if (this.entries.has(body)) this.remove(body);
    const bounds = boundsOf(body), keys = this.keys(bounds);
    this.entries.set(body, { bounds, keys });
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = new Set());
      cell.add(body);
    }
    return body;
  }
  remove(body) {
    const entry = this.entries.get(body);
    if (!entry) return false;
    for (const key of entry.keys) {
      const cell = this.cells.get(key);
      cell.delete(body);
      if (!cell.size) this.cells.delete(key);
    }
    this.entries.delete(body);
    return true;
  }
  update(body) { this.insert(body); return body; }
  query(body, margin = 0) {
    if (!this.entries.size) return [];
    const bounds = boundsOf(body), extra = Math.max(0, margin) * Math.SQRT2;
    // SAT clearance applies on rotated axes; a diagonal contact can extend
    // farther than margin along a world axis. Keep that clearance reachable.
    bounds.left -= extra; bounds.right += extra;
    bounds.top -= extra; bounds.bottom += extra;
    const seen = new Set(), result = [];
    for (const key of this.keys(bounds)) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      for (const other of cell) {
        if (seen.has(other)) continue;
        seen.add(other);
        const b = this.entries.get(other).bounds;
        if (b.right >= bounds.left && b.left <= bounds.right && b.bottom >= bounds.top && b.top <= bounds.bottom)
          result.push(other);
      }
    }
    return result;
  }
}
