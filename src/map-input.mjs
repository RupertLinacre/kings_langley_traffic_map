export function connectMapInput(canvas, camera, { changed, selected }) {
    const pointers = new Map();
    let down = null, dragged = false;
    const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
    const centre = pair => [(pair[0].x + pair[1].x) / 2, (pair[0].y + pair[1].y) / 2];
    canvas.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        canvas.focus({ preventScroll: true });
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 1) { down = [event.clientX, event.clientY]; dragged = false; }
        else dragged = true;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', event => {
        const previous = pointers.get(event.pointerId);
        if (!previous) return;
        const before = [...pointers.values()];
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 1) {
            if (!dragged && Math.hypot(event.clientX - down[0], event.clientY - down[1]) <= 5) return;
            camera.pan(event.clientX - (dragged ? previous.x : down[0]), event.clientY - (dragged ? previous.y : down[1]));
            dragged = true;
        } else {
            const after = [...pointers.values()], oldCentre = centre(before), newCentre = centre(after);
            camera.zoomAt(camera.view.scale * distance(after) / Math.max(1, distance(before)), ...oldCentre);
            camera.pan(newCentre[0] - oldCentre[0], newCentre[1] - oldCentre[1]);
        }
        changed();
    });
    function release(event) {
        if (!pointers.has(event.pointerId)) return;
        if (event.type === 'pointerup' && !dragged) selected(camera.worldAt(event.clientX, event.clientY));
        pointers.delete(event.pointerId);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        if (!pointers.size) canvas.classList.remove('dragging');
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, release);
    canvas.addEventListener('wheel', event => {
        event.preventDefault();
        const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? camera.height : 1);
        camera.zoomAt(camera.view.scale * Math.exp(-pixels * 0.0015), event.clientX, event.clientY);
        changed();
    }, { passive: false });
    canvas.addEventListener('keydown', event => {
        const arrows = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
        if (arrows[event.key]) camera.pan(...arrows[event.key]);
        else if (['+', '=', '-'].includes(event.key)) camera.zoomAt(camera.view.scale * (event.key === '-' ? 0.8 : 1.25));
        else return;
        event.preventDefault(); changed();
    });
}
