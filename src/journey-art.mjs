import { circle, line, rounded } from './miniature-art.mjs';
import { drawPedestrian } from './real-pedestrians.mjs';
import { groupPose } from './purposeful-journeys.mjs';
import { pathPoint } from './street-geometry.mjs';

function child(g, pose, member, group, time) {
    const stride = pose.moving ? Math.sin(time * 6.1 + group.id) * 1.4 : 0;
    g.save(); g.translate(pose.x, pose.y); g.rotate(pose.angle); g.scale(0.38, 0.38);
    circle(g, 1, 2, 3.5, '#304b3c25');
    line(g, -3 + stride, -1.4, 0, -1, '#40504b', 1.6);
    line(g, -3 - stride, 1.4, 0, 1, '#40504b', 1.6);
    rounded(g, -1.5, -2.7, 3.8, 5.4, 1.6, member.colour);
    // A bright little backpack distinguishes the school family at village zoom.
    rounded(g, -2.8, -1.9, 2.7, 3.8, 0.75, '#e6b74e');
    line(g, -2.6, 0, -0.4, 0, '#b58b31', 0.45);
    circle(g, 1.1, 0, 2.05, '#e6c09e'); g.restore();
}

/** Draw compact parent/child and shopping groups separately from random
 * pedestrians. Time and interpolation come from the renderer's shared clock. */
export function drawJourneyGroups(g, town, time, widthFactor = 2.5, layer = 0, visible = () => true, alpha = 1) {
    for (const group of town.purposefulJourneys?.groups || []) {
        const pose = groupPose(town, group, widthFactor, alpha);
        if (!pose.visible || pose.layer !== layer || !visible(pose, 12)) continue;
        const link = group.walker.route?.[group.walker.index];
        const distance = link?.type === 'walk' ? link.from.distance + (link.to.distance - link.from.distance) * group.walker.progress : group.walker.node.distance;
        const canonical = pathPoint(group.walk.section.path, distance).angle;
        const side = group.walk.side;
        const outward = { x: Math.sin(canonical) * side, y: -Math.cos(canonical) * side };
        const children = group.members.some(member => member.role === 'child');
        if (children) {
            line(g, pose.x + outward.x * 0.8, pose.y + outward.y * 0.8,
                pose.x + outward.x * 1.8, pose.y + outward.y * 1.8, '#d5ad8a', 0.45);
        }
        for (const [i, member] of group.members.entries()) {
            const p = { ...pose, x: pose.x + outward.x * i * 2.15, y: pose.y + outward.y * i * 2.15 };
            if (member.role === 'child') child(g, p, member, group, time);
            else drawPedestrian(g, { id: group.id * 3 + i, colour: member.colour, speed: group.walker.speed,
                pause: pose.moving ? 0 : 1, state: group.walker.state }, p, time);
            if (group.bag && i === 0) {
                g.save(); g.translate(p.x, p.y); g.rotate(p.angle);
                rounded(g, -1.4, 1.7, 1.7, 1.6, 0.2, '#dcb573');
                line(g, -1.05, 1.8, -0.2, 1.8, '#927145', 0.3); g.restore();
            }
        }
    }
}
