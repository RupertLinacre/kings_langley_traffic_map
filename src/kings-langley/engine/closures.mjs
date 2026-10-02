import { makeGraph, findRoute } from './graph.mjs';
import { laneCount } from './traffic-model.mjs';

export class Closures {
  constructor(simulation) {
    this.sim = simulation;
    this.ways = new Set();
    this.revision = 0;
    this.entries = new Map();
    this.cache = new Map();
    this.graph = simulation.graph;
  }
  anchor(path, stop) {
    if (!stop || stop.done) return null;
    let offset = 0;
    for (const id of path) {
      const edge = this.sim.data.edges[id];
      if (stop.q <= offset + edge.length) return { edge, d: stop.q - offset };
      offset += edge.length;
    }
    return null;
  }
  route(from, to, incoming = null, arrival = null) {
    const key = `${from}:${to}:${incoming?.id ?? '-'}:${arrival ?? '-'}`;
    if (!this.cache.has(key))
      this.cache.set(
        key,
        findRoute(this.graph, from, to, incoming, null, arrival),
      );
    return this.cache.get(key);
  }
  journey(from, to, incoming, anchor) {
    if (!anchor) return { path: this.route(from, to, incoming) };
    if (this.ways.has(anchor.edge.way)) return { path: null };
    const first = this.route(from, anchor.edge.to, incoming, anchor.edge.id);
    if (!first) return { path: null };
    const last = this.route(anchor.edge.to, to, anchor.edge);
    if (!last) return { path: null };
    const q =
      first.reduce((sum, id) => sum + this.sim.data.edges[id].length, 0) -
      anchor.edge.length +
      anchor.d;
    return { path: [...first, ...last], q };
  }
  set(way, closed) {
    if (!this.sim.data.edges.some((e) => e.way === way))
      throw Error('This section has no drivable road.');
    if (this.ways.has(way) === closed) return;
    if (closed) this.ways.add(way);
    else this.ways.delete(way);
    this.revision++;
    this.entries.clear();
    this.cache.clear();
    // Keep edge IDs stable; only the adjacency used for diversions is filtered.
    this.graph = makeGraph(this.sim.data);
    for (const [id, edges] of this.graph.out)
      this.graph.out.set(
        id,
        edges.filter((e) => !this.ways.has(e.way)),
      );
    for (const [id, spec] of this.sim.routeSpecs.entries()) {
      if (!spec.path.some((i) => this.ways.has(this.sim.data.edges[i].way)))
        continue;
      const first = this.sim.data.edges[spec.path[0]],
        last = this.sim.data.edges[spec.path.at(-1)];
      const result = this.journey(
        first.from,
        last.to,
        null,
        this.anchor(spec.path, spec.roadStop),
      );
      this.entries.set(
        id,
        result.path?.length
          ? {
              ...spec,
              path: result.path,
              roadStop: spec.roadStop
                ? { ...spec.roadStop, q: result.q }
                : undefined,
            }
          : null,
      );
    }
    this.updateCars();
  }
  entry(id) {
    return this.entries.has(id)
      ? this.entries.get(id)
      : this.sim.routeSpecs[id];
  }
  updateCars() {
    for (const c of this.sim.cars) {
      if (c.closureRevision === this.revision) continue;
      // Finish parking/committed single-lane passage before changing its route.
      if (c.parked || c.turnaround || this.sim.parking.zones.some((z) => z.claims.has(c.id)))
        continue;
      c.closureRevision = this.revision;
      c.closureBlocked = false;
      let cut = c.index;
      const current = this.sim.data.edges[c.route[cut]];
      // Vehicles already on a newly closed section can clear it. No new entrants.
      if (this.ways.has(current.way))
        while (
          cut + 1 < c.route.length &&
          this.sim.data.edges[c.route[cut + 1]].way === current.way
        )
          cut++;
      if (
        !c.route
          .slice(cut + 1)
          .some((id) => this.ways.has(this.sim.data.edges[id].way))
      )
        continue;
      const anchor = this.anchor(c.route, c.roadStop);
      const prefix = c.route.slice(0, cut + 1),
        last = this.sim.data.edges[prefix.at(-1)],
        destination = this.sim.data.edges[c.route.at(-1)].to;
      const upcoming =
        anchor && c.roadStop.q > c.offsets[cut + 1] ? anchor : null;
      const result = this.journey(last.to, destination, last, upcoming);
      if (!result.path) {
        c.closureBlocked = true;
        continue;
      }
      const base = c.offsets[cut + 1];
      c.closureBarrierRevision = -1;
      c.route = [...prefix, ...result.path];
      c.offsets = c.offsets.slice(0, cut + 2);
      c.lanes = c.lanes.slice(0, cut + 1);
      for (const id of result.path) {
        c.offsets.push(c.offsets.at(-1) + this.sim.data.edges[id].length);
        c.lanes.push(
          Math.min(c.lanes.at(-1), laneCount(this.sim.data.edges[id]) - 1),
        );
      }
      if (upcoming) c.roadStop.q = base + result.q;
      // Preserve reservations behind the front: the vehicle's tail still owns them.
      for (const [node, claims] of this.sim.reservations) {
        const kept = claims.filter(
          (r) => r.car !== c || r.crossing <= c.q || r.crossing < base,
        );
        if (kept.length) this.sim.reservations.set(node, kept);
        else this.sim.reservations.delete(node);
      }
      this.sim.parking.prepare(c);
    }
  }
  gap(c) {
    if (!this.ways.size) return Infinity;
    if (c.closureBarrierRevision !== this.revision) {
      const current = this.sim.data.edges[c.route[c.index]];
      let clearing = this.ways.has(current.way);
      c.closureBarrier = Infinity;
      for (let i = c.index + 1; i < c.route.length; i++) {
        const e = this.sim.data.edges[c.route[i]];
        if (e.way !== current.way) clearing = false;
        if (this.ways.has(e.way) && !clearing) {
          c.closureBarrier = c.offsets[i];
          break;
        }
      }
      c.closureBarrierRevision = this.revision;
    }
    return Math.max(0, c.closureBarrier - c.q);
  }
  summary() {
    return {
      sections: this.ways.size,
      divertedRoutes: [...this.entries.values()].filter(Boolean).length,
      blockedRoutes: [...this.entries.values()].filter((r) => !r).length,
      waiting:
        this.sim.cars.filter((c) => c.closureBlocked).length +
        [...this.sim.pending].reduce(
          (s, [id, n]) => s + (this.entry(id) ? 0 : n),
          0,
        ),
    };
  }
}
