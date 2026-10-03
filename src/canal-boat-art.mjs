import { canalBoatPose } from './canal-boats.mjs';
import { circle, line, rounded } from './miniature-art.mjs';
import { pathPoint } from './street-geometry.mjs';

const variantOf = boat => [...String(boat.id || boat.name || '')]
    .reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);

function hull(g, length, width, fill, stroke) {
    const half = length / 2, side = width / 2, bow = Math.min(2.4, length * 0.15);
    g.beginPath();
    g.moveTo(-half + 0.5, -side);
    g.lineTo(half - bow, -side);
    g.quadraticCurveTo(half - bow * 0.25, -side * 0.8, half, 0);
    g.quadraticCurveTo(half - bow * 0.25, side * 0.8, half - bow, side);
    g.lineTo(-half + 0.5, side);
    g.quadraticCurveTo(-half, side, -half, side - 0.5);
    g.lineTo(-half, -side + 0.5);
    g.quadraticCurveTo(-half, -side, -half + 0.5, -side);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 0.16;
        g.stroke();
    }
}

function waterMarks(g, boat, pose, time, length, width) {
    const moving = Math.min(1, Math.max(0, pose.speed || 0) / 0.7);
    const phase = (time * 0.7 + (variantOf(boat) % 17) * 0.17) % 1;
    g.save();
    g.strokeStyle = '#deeee2';
    g.lineWidth = 0.16;
    // Short ripples hug the hull; the wake stays within the narrow canal.
    for (const side of [-1, 1]) {
        g.globalAlpha = 0.18 + moving * 0.15;
        g.beginPath();
        g.moveTo(length / 2 + 0.35, 0);
        g.quadraticCurveTo(length / 2 - 0.7, side * width * 0.63,
            length / 2 - 2.5, side * width * 0.61);
        g.stroke();
        if (moving < 0.05) continue;
        for (let i = 0; i < 3; i++) {
            const age = (i + phase) / 3, behind = length / 2 + age * 3.2;
            g.globalAlpha = moving * (1 - age) * 0.34;
            g.beginPath();
            g.moveTo(-behind + 0.7, side * width * (0.39 + age * 0.08));
            g.quadraticCurveTo(-behind + 0.1, side * width * (0.55 + age * 0.08),
                -behind - 0.75, side * width * (0.58 + age * 0.08));
            g.stroke();
        }
    }
    g.restore();
}

export function drawCanalBoat(g, boat, pose, time) {
    const length = boat.length || 17, width = Math.min(2.8, boat.width || 2.25);
    const half = length / 2, variant = variantOf(boat), colour = boat.colour || '#467d78';
    const roof = ['#e9ddbb', '#eee9d5', '#b7c9c7'][variant % 3];
    const cabinX = -half + 2.4, cabinLength = length - 5.4, cabinWidth = width - 0.45;
    g.save();
    g.translate(pose.x, pose.y);
    g.rotate(pose.angle);
    waterMarks(g, boat, pose, time, length, width);

    // Dark gunwales frame the painted hull and the long, low cabin.
    g.save();
    g.translate(0.12, 0.2);
    hull(g, length, width + 0.18, '#263f4530');
    g.restore();
    hull(g, length, width, colour, '#2f4848');
    for (const side of [-1, 1]) {
        line(g, -half + 0.6, side * width * 0.43, half - 2.3,
            side * width * 0.43, '#e0bc6d', 0.13);
    }

    rounded(g, cabinX + 0.1, -cabinWidth / 2 + 0.13, cabinLength, cabinWidth, 0.25, '#293e453c');
    rounded(g, cabinX, -cabinWidth / 2, cabinLength, cabinWidth, 0.23, roof);
    line(g, cabinX + 0.3, -cabinWidth / 2 + 0.16,
        cabinX + cabinLength - 0.3, -cabinWidth / 2 + 0.16, '#ffffff70', 0.12);
    for (let x = cabinX + 0.65; x < cabinX + cabinLength - 0.5; x += 1.85) {
        for (const side of [-1, 1]) {
            rounded(g, x, side * cabinWidth / 2 - 0.11, 0.7, 0.22, 0.06, '#355d64');
        }
    }

    // Roof hatches, brass vents and a tiny chimney make each boat distinct.
    rounded(g, cabinX + cabinLength * 0.22, -0.5, 1.1, 1, 0.12, colour);
    line(g, cabinX + cabinLength * 0.22 + 0.2, -0.28,
        cabinX + cabinLength * 0.22 + 0.9, -0.28, '#ffffff4a', 0.1);
    for (const fraction of [0.14, 0.56, 0.85]) {
        circle(g, cabinX + cabinLength * fraction, 0, 0.15, '#a89666');
        circle(g, cabinX + cabinLength * fraction - 0.04, -0.03, 0.08, '#f0ddaa');
    }
    if (variant % 2) {
        const panelX = cabinX + cabinLength * 0.62;
        rounded(g, panelX, -0.57, 1.85, 1.14, 0.08, '#496477');
        for (let x = panelX + 0.46; x < panelX + 1.85; x += 0.46) {
            line(g, x, -0.5, x, 0.5, '#a4bdc66b', 0.06);
        }
        line(g, panelX + 0.08, 0, panelX + 1.77, 0, '#a4bdc66b', 0.06);
    } else {
        rounded(g, cabinX + cabinLength * 0.68, -0.39, 1, 0.78, 0.12, '#75948f');
        line(g, cabinX + cabinLength * 0.68 + 0.1, -0.2,
            cabinX + cabinLength * 0.68 + 0.9, -0.2, '#e5efdc', 0.1);
    }
    circle(g, cabinX + 0.6, 0.46, 0.22, '#364a45');
    circle(g, cabinX + 0.55, 0.41, 0.11, '#9eada0');

    // Open stern deck, tiller, skipper and a coiled rope on the bow.
    rounded(g, -half + 0.38, -width * 0.32, 1.7, width * 0.64, 0.16, '#6b7469');
    line(g, -half + 0.14, 0, -half + 1.2, 0, '#dbbf72', 0.17);
    line(g, -half + 1.2, 0, -half + 1.2, -0.43, '#dbbf72', 0.17);
    circle(g, -half + 1.4, 0.33, 0.3, ['#527a94', '#b46e52', '#748d52'][variant % 3]);
    line(g, -half + 1.25, 0.14, -half + 1.16, -0.3, '#e5b990', 0.16);
    circle(g, -half + 1.4, 0.31, 0.17, '#e9bd94');
    circle(g, -half + 1.44, 0.27, 0.1, '#f0dfb1');
    circle(g, half - 1.65, 0, 0.24, '#bfa579');
    circle(g, half - 1.65, 0, 0.13, colour);
    line(g, half - 0.58, -0.16, half - 0.58, 0.16, '#2f4848', 0.21);
    g.restore();
}

export function drawCanalBoats(g, boats, time, layer, visible = () => true) {
    for (const boat of boats) {
        const pose = canalBoatPose(boat, time);
        if (!pose.visible || pose.layer !== layer || !visible(pose)) continue;
        drawCanalBoat(g, boat, pose, time);
    }
}

function lockGate(g, open, inward) {
    for (const side of [-1, 1]) {
        const closedAngle = Math.atan2(-side * 4, inward * 0.8);
        const openAngle = Math.atan2(-side * 0.1, inward * 4);
        const turn = Math.atan2(Math.sin(openAngle - closedAngle), Math.cos(openAngle - closedAngle));
        const angle = closedAngle + turn * open;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        const tipX = dx * 4.08, tipY = side * 4 + dy * 4.08;
        line(g, 0.16, side * 4 + 0.14, tipX + 0.16, tipY + 0.14, '#2f4d4230', 0.8);
        line(g, 0, side * 4, tipX, tipY, '#536152', 0.62);
        line(g, dx * 0.15, side * 4 + dy * 0.15,
            tipX - dx * 0.15, tipY - dy * 0.15, '#adb29a', 0.14);
        // White balance beams rotate with each leaf, just above the banks.
        line(g, -dx * 2.2, side * 4 - dy * 2.2,
            dx * 0.7, side * 4 + dy * 0.7, '#e9e5cd', 0.44);
        line(g, -dx * 2.2, side * 4 - dy * 2.2,
            -dx * 1.85, side * 4 - dy * 1.85, '#4c5d50', 0.46);
        circle(g, 0, side * 4, 0.29, '#536152');
        circle(g, -0.04, side * 4 - 0.04, 0.12, '#c5c6a7');
    }
}

export function drawCanalLocks(g, boats, time, layer, visible = () => true) {
    const locks = new Map();
    for (const boat of boats) {
        for (const segment of boat.route.segments) {
            if (segment.item.tags.lock !== 'yes' || segment.item.layer !== layer) continue;
            locks.set(segment.item.id || segment.item, segment);
        }
    }
    const poses = boats.map(boat => ({ boat, pose: canalBoatPose(boat, time) }))
        .filter(({ pose }) => pose.visible);
    for (const segment of locks.values()) {
        for (const [distance, inward] of [[0, 1], [segment.path.length, -1]]) {
            const p = pathPoint(segment.path, distance);
            if (!visible(p)) continue;
            let opening = 0;
            for (const { boat, pose } of poses) {
                if (pose.layer !== layer) continue;
                const clearance = (boat.length || 17) / 2 + 8;
                const approach = Math.max(0, Math.min(1,
                    (clearance + 20 - Math.hypot(pose.x - p.x, pose.y - p.y)) / 20));
                opening = Math.max(opening, approach * approach * (3 - 2 * approach));
            }
            g.save();
            g.translate(p.x, p.y);
            g.rotate(p.angle);
            lockGate(g, opening, inward);
            g.restore();
        }
    }
}
