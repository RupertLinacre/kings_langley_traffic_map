// Keyboard and simultaneous touch controls share the same held-button state.
export function connectFireEngineControls({ pad, active, action, document: doc = document,
    window: win = window }) {
    const keys = new Set(), pointers = new Map();
    const bindings = { ArrowUp: 'forward', KeyW: 'forward', ArrowDown: 'reverse', KeyS: 'reverse',
        ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'brake' };
    const buttons = [...pad.querySelectorAll('[data-drive-control]')];
    const held = name => [...keys].some(code => bindings[code] === name) || [...pointers.values()].includes(name);
    function paint() { for (const button of buttons) button.classList.toggle('held', held(button.dataset.driveControl)); }
    function clear() { keys.clear(); pointers.clear(); paint(); }
    doc.addEventListener('keydown', event => {
        if (!active() || event.altKey || event.ctrlKey || event.metaKey ||
            event.target?.closest?.('input, select, textarea, [contenteditable="true"]')) return;
        if (bindings[event.code]) {
            event.preventDefault(); event.stopImmediatePropagation(); keys.add(event.code); paint();
        } else if (['KeyN', 'KeyM', 'Escape'].includes(event.code)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (!event.repeat) action(event.code === 'KeyN' ? 'siren' : event.code === 'KeyM' ? 'sound' : 'leave');
        }
    }, true);
    doc.addEventListener('keyup', event => {
        if (!keys.has(event.code)) return;
        event.preventDefault(); keys.delete(event.code); paint();
    }, true);
    for (const button of buttons) {
        button.addEventListener('pointerdown', event => {
            if (!active() || event.button > 0) return;
            event.preventDefault(); pointers.set(event.pointerId, button.dataset.driveControl);
            button.setPointerCapture(event.pointerId); paint();
        });
        const release = event => { pointers.delete(event.pointerId); paint(); };
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
    }
    win.addEventListener('blur', clear);
    doc.addEventListener('visibilitychange', clear);
    return { clear, read: () => active() ? { throttle: Number(held('forward')) - Number(held('reverse')),
        steer: Number(held('right')) - Number(held('left')), brake: held('brake') } :
        { throttle: 0, steer: 0, brake: true } };
}
