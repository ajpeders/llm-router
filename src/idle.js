// projects/llm-router/src/idle.js
function createIdleTracker(windowMs) {
  let inFlight = 0;
  let lastActivity = 0;
  return {
    begin() { inFlight += 1; },
    end() { inFlight = Math.max(0, inFlight - 1); },
    markActivity(nowMs) { lastActivity = nowMs; },
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
