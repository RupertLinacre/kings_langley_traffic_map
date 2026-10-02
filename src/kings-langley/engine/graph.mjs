export function isSignal(tags) {
  return (
    tags.highway === 'traffic_signals' ||
    tags.crossing === 'traffic_signals' ||
    tags['crossing:signals'] === 'yes'
  );
}
export class Heap {
  constructor() {
    this.a = [];
  }
  push(item) {
    let i = this.a.length;
    this.a.push(item);
    while (i) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= item[0]) break;
      this.a[i] = this.a[p];
      i = p;
    }
    this.a[i] = item;
  }
  pop() {
    if (!this.a.length) return null;
    const result = this.a[0],
      last = this.a.pop();
    if (this.a.length) {
      let i = 0;
      while (2 * i + 1 < this.a.length) {
        let c = 2 * i + 1;
        if (c + 1 < this.a.length && this.a[c + 1][0] < this.a[c][0]) c++;
        if (this.a[c][0] >= last[0]) break;
        this.a[i] = this.a[c];
        i = c;
      }
      this.a[i] = last;
    }
    return result;
  }
}
export function makeGraph(data) {
  const out = new Map();
  for (const e of data.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
  }
  const rules = new Map();
  for (const r of data.restrictions) {
    const key = `${r.via}:${r.from}`;
    if (!rules.has(key)) rules.set(key, []);
    rules.get(key).push(r);
  }
  return { data, out, rules };
}
export function canTurn(graph, prev, next) {
  if (prev.to !== next.from) return false;
  if (next.to === prev.from) return false;
  return (graph.rules.get(`${prev.to}:${prev.way}`) || []).every((r) =>
    r.type.startsWith('only_')
      ? next.way === r.to
      : r.type === 'no_u_turn' && r.from === r.to
        ? next.to !== prev.from
        : next.way !== r.to,
  );
}
export function findRoute(
  graph,
  from,
  to,
  incoming = null,
  edgeCost = null,
  arrivalEdge = null,
) {
  if (from === to && arrivalEdge === null) return [];
  const heap = new Heap(),
    cost = new Map(),
    parent = new Map();
  for (const e of graph.out.get(from) || []) {
    if (incoming && !canTurn(graph, incoming, e)) continue;
    const c = edgeCost ? edgeCost(e) : e.length / e.speed;
    cost.set(e.id, c);
    heap.push([c, e.id]);
  }
  let end;
  while (heap.a.length) {
    const [c, id] = heap.pop();
    if (c !== cost.get(id)) continue;
    const edge = graph.data.edges[id];
    if (edge.to === to && (arrivalEdge === null || edge.id === arrivalEdge)) {
      end = id;
      break;
    }
    for (const next of graph.out.get(edge.to) || []) {
      if (!canTurn(graph, edge, next)) continue;
      const nc =
        c +
        (edgeCost ? edgeCost(next) : next.length / next.speed) +
        (isSignal(graph.data.nodes[next.to].tags) ? 8 : 0);
      if (nc < (cost.get(next.id) ?? Infinity)) {
        cost.set(next.id, nc);
        parent.set(next.id, id);
        heap.push([nc, next.id]);
      }
    }
  }
  if (end === undefined) return null;
  const path = [];
  for (let id = end; id !== undefined; id = parent.get(id)) path.push(id);
  return path.reverse();
}
export function position(edge, distance) {
  let remaining = distance;
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1],
      b = edge.points[i],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= length || i === edge.points.length - 1) {
      const t = length ? Math.min(1, remaining / length) : 0;
      return {
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        dx: (b[0] - a[0]) / (length || 1),
        dy: (b[1] - a[1]) / (length || 1),
      };
    }
    remaining -= length;
  }
  return { x: edge.points[0][0], y: edge.points[0][1], dx: 1, dy: 0 };
}
