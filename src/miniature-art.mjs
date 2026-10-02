// The original miniature-town artwork, shared with the real-map renderer.
export function rounded(g, x, y, width, height, radius, fill, stroke) {
    g.beginPath();
    g.roundRect(x, y, width, height, radius);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}

export function line(g, x1, y1, x2, y2, colour, width = 1) {
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
}

export function circle(g, x, y, radius, colour) {
    g.fillStyle = colour;
    g.beginPath();
    g.arc(x, y, radius, 0, Math.PI * 2);
    g.fill();
}

export function trace(g, points) {
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
}

export function strokePath(g, path, colour, width) {
    g.beginPath();
    trace(g, path.points);
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.stroke();
}

export function tree(g, x, y, radius, random) {
    circle(g, x + 3, y + 5, radius + 1, '#5f77562a');
    const colour = ['#729967', '#81a674', '#609077', '#99ad6d'][Math.floor(random() * 4)];
    circle(g, x, y, radius * 0.9, colour);
    for (let i = 0; i < 5; i++) {
        const angle = i * Math.PI * 0.4;
        circle(g, x + Math.cos(angle) * radius * 0.44, y + Math.sin(angle) * radius * 0.4, radius * 0.59, colour);
    }
    circle(g, x - radius * 0.3, y - radius * 0.25, radius * 0.66, '#ffffff21');
    circle(g, x + radius * 0.3, y + radius * 0.3, radius * 0.35, '#365a3820');
}

export function building(g, x, y, width, height, random, shop = false) {
    const roofs = ['#c88870', '#b9b3a1', '#7f9b9e', '#ceac79', '#aa938f', '#9baba2'];
    const roof = roofs[Math.floor(random() * roofs.length)];
    rounded(g, x + 4, y + 6, width + 1, height, 3, '#57655327');
    rounded(g, x - 2, y - 2, width + 4, height + 5, 3, '#f4edde');
    rounded(g, x, y, width, height, 2, roof);
    g.save(); g.globalAlpha = 0.13;
    for (let row = y + 4; row < y + height - 2; row += 4) line(g, x + 2, row, x + width - 2, row, '#48554d', 0.6);
    g.restore();
    g.fillStyle = '#ffffff23';
    g.fillRect(x + 2, y + 2, width - 4, height / 2 - 2);
    line(g, x + 2, y + height / 2, x + width - 2, y + height / 2, '#58615e40', 2);
    line(g, x + 1, y + 1, x + 10, y + height / 2, '#ffffff38');
    line(g, x + width - 1, y + 1, x + width - 10, y + height / 2, '#ffffff38');
    rounded(g, x + width * 0.65, y + 5, 6, 8, 1, '#677574', '#d5d4c4');
    rounded(g, x + width * 0.65 + 1, y + 5, 4, 3, 0.4, '#475953');
    if (shop) {
        for (let i = 0; i < Math.floor(width / 7); i++) {
            g.fillStyle = i % 2 ? '#eee9d8' : '#6b9390';
            g.fillRect(x + i * 7, y + height - 1, 7, 7);
        }
        rounded(g, x + width / 2 - 8, y + height + 8, 16, 3, 1, '#a3ac9b');
    } else if (random() > 0.5) {
        rounded(g, x + 7, y + height / 2 + 4, 14, 8, 1, '#536e79', '#b2c2c0');
        line(g, x + 14, y + height / 2 + 4, x + 14, y + height / 2 + 12, '#a6b8ba');
    }
}

export function bench(g, x, y, vertical = false) {
    g.save();
    g.translate(x, y);
    if (vertical) g.rotate(Math.PI / 2);
    rounded(g, -8, -3, 16, 6, 1, '#b39368');
    line(g, -8, 0, 8, 0, '#ead7ad');
    line(g, -5, -4, -5, 4, '#626d5d', 1.5);
    line(g, 5, -4, 5, 4, '#626d5d', 1.5);
    g.restore();
}

export function drawVehicle(g, vehicle, p, time) {
    const length = vehicle.length;
    const width = vehicle.width;
    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.angle);
    rounded(g, -length / 2 + 2, -width / 2 + 3, length, width, 3, '#263e3c35');
    // Tyres remain visible either side of the body.
    for (const axle of [-length * 0.3, length * 0.29]) {
        rounded(g, axle - 2, -width / 2 - 1, 4, width + 2, 1, '#34494a');
    }
    rounded(g, -length / 2, -width / 2, length, width, vehicle.bus ? 3 : 4, vehicle.colour);
    if (vehicle.bus) {
        rounded(g, -length / 2 + 4, -width / 2 + 2, length - 10, width - 4, 2, '#f3e8c9');
        rounded(g, length / 2 - 6, -width / 2 + 1, 4, width - 2, 1, '#34575c');
        rounded(g, -length / 2 + 3, -width / 2 + 1, 3, width - 2, 1, '#567574');
        rounded(g, -7, -3, 6, 6, 1, '#ddd5bc');
        for (let x = -8; x < 9; x += 5) {
            g.fillStyle = '#3f6666';
            g.fillRect(x, -width / 2, 3.5, 1.5);
            g.fillRect(x, width / 2 - 1.5, 3.5, 1.5);
        }
        // Route numbers on the roof are easy to follow from above.
        g.fillStyle = '#485a53';
        g.font = 'bold 7px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(vehicle.route.number, 5, 0.4);
    } else if (vehicle.type === 'lorry') {
        rounded(g, -length / 2 + 1, -width / 2 + 0.7, length * 0.68, width - 1.4, 1, '#e7e4d8');
        for (let x = -length / 2 + 4; x < length * 0.18; x += 4) line(g, x, -width / 2 + 1.5, x, width / 2 - 1.5, '#b9c5bd', 0.7);
        rounded(g, length * 0.28, -width / 2 + 0.8, 3, width - 1.6, 0.8, '#3e626d');
    } else if (vehicle.type === 'van') {
        rounded(g, -length * 0.43, -width / 2 + 1, length * 0.58, width - 2, 1.5, '#f2eee1');
        line(g, -length * 0.15, -width / 2 + 2, -length * 0.15, width / 2 - 2, '#bec7bc', 0.6);
        rounded(g, length * 0.2, -width / 2 + 1, length * 0.1, width - 2, 1, '#3e626d');
    } else {
        rounded(g, -length * 0.19, -width / 2 + 1, length * 0.48, width - 2, 2, '#3e626d');
        rounded(g, -length * 0.12, -width / 2 + 1, length * 0.26, width - 2, 1, vehicle.colour);
        line(g, -length * 0.07, -width / 2 + 2, length * 0.11, -width / 2 + 2, '#ffffff50');
    }
    // A fine bonnet glint and bumper distinguish the heading at village scale.
    line(g, length * 0.37, -width * 0.28, length * 0.37, width * 0.28, '#ffffff45', 0.7);
    for (const side of [-1, 1]) {
        rounded(g, length / 2 - 1.5, side * (width / 2 - 2) - 1, 1.5, 2, 0.5, '#fff1c1');
        rounded(g, -length / 2, side * (width / 2 - 2) - 1, 1.5, 2, 0.5, vehicle.reversing ? '#fff8dd' : vehicle.braking ? '#ff795f' : '#a94b40');
    }
    if (vehicle.dwell > 0) {
        g.fillStyle = '#f6d679';
        g.fillRect(4, -width / 2 - 1, 5, 2);
    }
    if (vehicle.indicator && Math.floor(time * 2.8) % 2 === 0) {
        circle(g, length / 2 - 3, vehicle.indicator * width / 2, 1.8, '#ffe08b');
        circle(g, -length / 2 + 2, vehicle.indicator * width / 2, 1.6, '#ffc65d');
    }
    g.restore();
}
