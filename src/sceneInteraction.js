// A tap is one uninterrupted, stationary primary-pointer gesture. In
// particular, the last finger of a pinch must never become an atom edit.
export function createTapTracker({ distance = 6, duration = 700 } = {}) {
  const active = new Set();
  let candidate = null;
  const id = event => event.pointerId ?? 1;
  return {
    get isDown() { return active.size > 0; },
    start(event) {
      active.add(id(event));
      if (active.size !== 1 || event.button !== 0 || event.isPrimary === false) {
        candidate = null;
        return;
      }
      candidate = { id: id(event), x: event.clientX, y: event.clientY, time: event.timeStamp ?? 0, moved: false };
    },
    move(event) {
      if (candidate?.id === id(event) && Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > distance) candidate.moved = true;
    },
    end(event) {
      const elapsed = (event.timeStamp ?? 0) - (candidate?.time ?? 0);
      const tap = active.size === 1 && candidate?.id === id(event) && !candidate.moved && event.button === 0 &&
        elapsed >= 0 && elapsed <= duration && Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) <= distance;
      active.delete(id(event));
      candidate = null;
      return Boolean(tap);
    },
    cancel(event) {
      active.delete(id(event));
      candidate = null;
    },
  };
}
