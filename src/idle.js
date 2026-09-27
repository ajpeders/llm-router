// projects/llm-router/src/idle.js
function createIdleTracker(windowMs) {
  let inFlight = 0;
  let lastActivity = 0;
  return {
    begin() { inFlight += 1; },
    end() { inFlight = Math.max(0, inFlight - 1); },
    markActivity(nowMs) { lastActivity = nowMs; },
    // Same test as snapshot().idle, against a caller-chosen window — the batch lane
    // uses a much longer holdoff (BATCH_HOLDOFF_MS) than /idle's IDLE_WINDOW_MS.
    idleFor(nowMs, ms) { return inFlight === 0 && nowMs - lastActivity > ms; },
    snapshot(nowMs) {
      const quiet = nowMs - lastActivity;
      return {
        idle: inFlight === 0 && quiet > windowMs,
        inFlight,
        idleSeconds: Math.floor(quiet / 1000),
        quietWindowMs: windowMs,
      };
    },
  };
}

module.exports = { createIdleTracker };
