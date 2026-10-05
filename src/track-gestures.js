export function bindQueueSwipe(row, trackId) {
    row.classList.add('queue-swipe-row');
    row.title = 'Glisser vers la droite pour lire ensuite';
    let gesture = null;
    let suppressClickUntil = 0;
    const reset = () => {
        gesture = null;
        row.classList.remove('is-swiping', 'swipe-ready');
        row.style.removeProperty('--swipe-offset');
    };
    row.addEventListener('dragstart', event => event.preventDefault());
    row.addEventListener('click', event => {
        if (Date.now() < suppressClickUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    row.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || event.target.closest('button, input, a')) return;
        suppressClickUntil = 0;
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, dragging: false };
    });
    row.addEventListener('pointermove', event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.dragging) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
            suppressClickUntil = Date.now() + 500;
            if (dx < 0 || Math.abs(dy) > dx / 1.4) return reset();
            gesture.dragging = true;
            row.setPointerCapture(event.pointerId);
            row.classList.add('is-swiping');
        }
        event.preventDefault();
        gesture.distance = Math.max(0, dx);
        row.style.setProperty('--swipe-offset', `${Math.min(gesture.distance, 110)}px`);
        row.classList.toggle('swipe-ready', gesture.distance >= 72);
    });
    row.addEventListener('pointerup', event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const enqueue = gesture.dragging && gesture.distance >= 72;
        if (gesture.dragging) suppressClickUntil = Date.now() + 500;
        reset();
        if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
        if (enqueue) void this.enqueueNextSong(trackId);
    });
    row.addEventListener('pointercancel', reset);
    row.addEventListener('lostpointercapture', event => {
        // Touch initially captures the child under the finger. Its release
        // bubbles here when we transfer capture to the whole row.
        if (event.target === row) reset();
    });
}
