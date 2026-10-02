// Shared measured geometry for streets, lane offsets, and neighbourhood boundaries.
export function measure(points) {
    let length = 0;
    points.forEach((point, i) => {
        if (i) length += Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y);
        point.distance = length;
    });
    return { points, length };
}

export function pathPoint(path, distance) {
    const points = path.points;
    distance = Math.max(0, Math.min(path.length, distance));
    let low = 1;
    let high = points.length - 1;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (points[mid].distance < distance) low = mid + 1;
        else high = mid;
    }
    const a = points[low - 1];
    const b = points[low];
    const t = (distance - a.distance) / (b.distance - a.distance || 1);
    const angle = a.angle === undefined ? Math.atan2(b.y - a.y, b.x - a.x) :
        a.angle + Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle)) * t;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle };
}

export function offsetPath(path, offset, start = 0, end = path.length) {
    const count = Math.max(2, Math.ceil((end - start) / 4));
    return measure(Array.from({ length: count + 1 }, (_, i) => {
        const p = pathPoint(path, start + (end - start) * i / count);
        return { x: p.x + Math.sin(p.angle) * offset, y: p.y - Math.cos(p.angle) * offset, angle: p.angle };
    }));
}

export function slicePath(path, start, end) {
    const points = [pathPoint(path, start), ...path.points.filter(p => p.distance > start && p.distance < end)
        .map(p => ({ x: p.x, y: p.y, angle: p.angle })), pathPoint(path, end)];
    return { ...path, ...measure(points) };
}

export function reversePath(path) {
    return { ...path, ...measure([...path.points].reverse().map(p =>
        ({ x: p.x, y: p.y, angle: p.angle + Math.PI }))) };
}

export function circularArc(a, b, sagitta) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    const offset = sagitta / 2 - chord * chord / (8 * sagitta);
    const center = { x: (a.x + b.x) / 2 - dy / chord * offset,
        y: (a.y + b.y) / 2 + dx / chord * offset };
    const radius = Math.hypot(a.x - center.x, a.y - center.y);
    const sweep = -4 * Math.atan(2 * sagitta / chord);
    const start = Math.atan2(a.y - center.y, a.x - center.x);
    const count = Math.max(24, Math.ceil(Math.abs(sweep) * radius / 5));
    const points = Array.from({ length: count + 1 }, (_, i) => {
        const theta = start + sweep * i / count;
        return { x: center.x + Math.cos(theta) * radius, y: center.y + Math.sin(theta) * radius,
            angle: theta + Math.sign(sweep) * Math.PI / 2 };
    });
    Object.assign(points[0], { x: a.x, y: a.y });
    Object.assign(points.at(-1), { x: b.x, y: b.y });
    return { ...measure(points), kind: 'arc', center, radius };
}

export function polygonArea(points) {
    return points.reduce((area, a, i) => {
        const b = points[(i + 1) % points.length];
        return area + a.x * b.y - b.x * a.y;
    }, 0) / 2;
}

export function insidePolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j];
        const b = polygon[i];
        if ((a.y > point.y) !== (b.y > point.y) &&
            point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

export function boundaryDistance(point, polygon) {
    let closest = Infinity;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        closest = Math.min(closest, Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t));
    }
    return closest;
}
