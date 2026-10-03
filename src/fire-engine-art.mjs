const RED = '#cc4039';
const LIME = '#e6e570';
const BLUE = '#59c8ff';

function box(g, x, y, width, height, radius, fill, outline = null) {
    g.beginPath(); g.roundRect(x, y, width, height, radius);
    g.fillStyle = fill; g.fill();
    if (outline) { g.strokeStyle = outline; g.lineWidth = 0.09; g.stroke(); }
}

function stroke(g, x1, y1, x2, y2, colour, width = 0.1) {
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
    g.strokeStyle = colour; g.lineWidth = width; g.stroke();
}

function lamp(g, x, y, flashing, phase) {
    // The soft halo belongs to each lamp, so it never obscures the road ahead.
    if (flashing) {
        g.beginPath(); g.ellipse(x, y, 0.7, 0.5, 0, 0, Math.PI * 2);
        g.fillStyle = '#42baff24'; g.fill();
        g.beginPath(); g.ellipse(x, y, 0.42, 0.32, 0, 0, Math.PI * 2);
        g.fillStyle = '#54c8ff50'; g.fill();
    }
    box(g, x - 0.19, y - 0.17, 0.38, 0.34, 0.09,
        flashing ? BLUE : '#337995');
    if (flashing) box(g, x - 0.11, y - 0.1, 0.22, 0.2, 0.06,
        phase ? '#f0fbff' : '#b9efff');
}

/** Draw in map metres, with +x forward. Width includes any renderer road-width
 * exaggeration; scale uniformly sizes the whole drawing. Time must be sampled
 * simulation time, so pausing also pauses the blue lights. Returns false for a
 * hidden/invalid pose. No model or canvas state escapes the save/restore pair.
 */
export function drawFireEngine(g, pose, {
    time = 0, scale = 1, siren = false, length = 10.4, width = 2.5,
    braking = false, indicator = 0, zoom,
} = {}) {
    if (!pose || pose.visible === false || ![pose.x, pose.y, pose.angle].every(Number.isFinite)) return false;
    if (![scale, length, width].every(value => Number.isFinite(value) && value > 0)) return false;
    const sampledTime = Number.isFinite(time) ? time : 0;
    const matrix = typeof g.getTransform === 'function' ? g.getTransform() : null;
    const screenScale = Number.isFinite(zoom) ? zoom : Math.hypot(matrix?.a || 1, matrix?.b || 0);
    // Only paint the small roof lettering when it has at least six screen pixels.
    const showLettering = screenScale * scale * length / 10.4 >= 6;
    const phase = Math.floor(sampledTime * 4) % 2;

    g.save();
    g.translate(pose.x, pose.y); g.rotate(pose.angle);
    g.scale(scale * length / 10.4, scale * width / 2.5);
    g.lineJoin = 'round'; g.lineCap = 'round';

    // Rubber tyres and a restrained shadow anchor the larger appliance.
    box(g, -5.05 + 0.2, -1.24 + 0.18, 10.1, 2.48, 0.27, '#253f4030');
    for (const x of [-3.45, -2.5, 3.38]) for (const side of [-1, 1]) {
        box(g, x - 0.37, side * 1.1 - 0.15, 0.74, 0.3, 0.09, '#30464a');
        stroke(g, x - 0.19, side * 1.18, x + 0.19, side * 1.18, '#738082', 0.09);
    }
    box(g, -5.1, -1.2, 7.35, 2.4, 0.18, '#a73130', '#853f38');
    box(g, -5.04, -1.15, 7.23, 2.3, 0.17, RED);
    // The forward cab is a separate, rounded shape with clearly visible glass.
    box(g, 1.9, -1.2, 3.25, 2.4, 0.28, '#dd5145', '#8d3f38');
    box(g, 2.07, -1.07, 2.93, 2.14, 0.2, RED);
    box(g, 4.04, -1.02, 0.66, 2.04, 0.13, '#294e5a');
    stroke(g, 4.2, -0.78, 4.2, 0.63, '#81b9c0', 0.1);
    stroke(g, 4.1, 0, 4.66, 0, '#324953', 0.08);
    box(g, 2.42, -1.17, 1.24, 0.23, 0.07, '#355d68');
    box(g, 2.42, 0.94, 1.24, 0.23, 0.07, '#355d68');
    for (const side of [-1, 1]) {
        stroke(g, 3.99, side * 1.08, 4.16, side * 1.2, '#354b50', 0.1);
        box(g, 4.05, side * 1.2 - 0.05, 0.26, 0.1, 0.045, '#40575d');
        box(g, 4.92, side * 0.77 - 0.18, 0.2, 0.36, 0.07, '#fff2c9');
        box(g, 2.46, side * 1.18 - 0.07, 0.41, 0.14, 0.04, LIME);
    }
    box(g, 5.02, -0.94, 0.14, 1.88, 0.03, '#d4dbcc');
    stroke(g, 4.9, -0.62, 4.9, 0.62, '#ffffff54', 0.08);
    stroke(g, 1.89, -1.1, 1.89, 1.1, '#8e3430', 0.12);

    // Silver shutter tops and alternating reflective blocks suggest the side
    // equipment lockers without relying on details visible only from ground level.
    for (const side of [-1, 1]) {
        for (let x = -4.58; x < 1.2; x += 1.38) {
            box(g, x, side > 0 ? 0.72 : -1.07, 1.21, 0.35, 0.04, '#c4ccc7');
            stroke(g, x + 0.14, side * 0.81, x + 1.08, side * 0.81, '#889d9e', 0.055);
        }
        for (let i = 0; i < 8; i++) {
            box(g, -4.71 + i * 0.84, side > 0 ? 1.0 : -1.18, 0.72, 0.18, 0.025,
                i % 2 ? '#a73734' : LIME);
        }
    }
    box(g, -4.75, -0.64, 6.63, 1.28, 0.08, '#bdc5be', '#728b8a');
    // A coiled hose and equipment hatch remain visible beside the roof ladder.
    box(g, -4.43, -0.52, 1.23, 1.04, 0.12, '#d0d6cb');
    for (const radius of [0.38, 0.24, 0.11]) {
        g.beginPath(); g.arc(-3.81, 0, radius, 0, Math.PI * 2);
        g.strokeStyle = radius === 0.11 ? '#617675' : '#8c9d8d'; g.lineWidth = 0.08; g.stroke();
    }
    box(g, -3.05, -0.42, 4.87, 0.84, 0.05, '#849794');
    for (const side of [-1, 1]) {
        stroke(g, -3.08, side * 0.39, 1.82, side * 0.39, '#e8eee1', 0.14);
        stroke(g, -3.05, side * 0.22, 1.79, side * 0.22, '#c3cfca', 0.08);
    }
    for (let x = -2.82; x < 1.79; x += 0.49) {
        stroke(g, x, -0.38, x, 0.38, '#e4ebdf', 0.105);
    }
    for (const x of [-2.45, 1.14]) stroke(g, x, -0.62, x, 0.62, '#657c7e', 0.14);

    // The rear chevrons give a child a strong cue to the vehicle's heading.
    box(g, -5.11, -1.08, 0.31, 2.16, 0.04, '#dfdf6f');
    for (const side of [-1, 1]) for (let y = 0.12; y < 0.9; y += 0.3) {
        stroke(g, -5.12, side * y, -4.81, side * (y + 0.22), '#cd4136', 0.15);
    }
    for (const side of [-1, 1]) {
        box(g, -5.12, side * 0.84 - 0.14, 0.15, 0.28, 0.04, braking ? '#ff9b7c' : '#923c39');
    }

    // Alternating cab and rear strobes use shared sim time, never wall time.
    box(g, 2.12, -1.01, 0.36, 2.02, 0.08, '#d8dfd4');
    for (const side of [-1, 1]) {
        const on = Boolean(siren) && (phase === (side < 0 ? 0 : 1));
        lamp(g, 2.3, side * 0.82, on, phase);
        lamp(g, -4.56, -side * 0.79, on, phase);
    }
    if (showLettering) {
        g.fillStyle = '#fff9e8'; g.font = '800 1px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('FIRE', 3.22, 0, 1.8);
    }
    if (indicator && Math.floor(sampledTime * 2.8) % 2 === 0) {
        const side = Math.sign(indicator);
        box(g, 4.78, side * 1.14 - 0.1, 0.23, 0.2, 0.06, '#ffcf65');
        box(g, -4.85, side * 1.14 - 0.1, 0.22, 0.2, 0.05, '#ffcf65');
    }
    g.restore();
    return true;
}
