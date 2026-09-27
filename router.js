"use strict";
const { loadConfig } = require("./src/config");
const { Pool } = require("./src/pool");
const { Leaser } = require("./src/lease");
const { Queue } = require("./src/queue");
const { Drainer, makeRunJob } = require("./src/drain");
const { startDiscovery } = require("./src/discovery");
const { deliverCallback, alertDead } = require("./src/notify");
const { createServer } = require("./src/server");
const { createIdleTracker } = require("./src/idle");

const cfg = loadConfig();
const pool = new Pool(Object.keys(cfg.backends), cfg.defaultSlots);
const leaser = new Leaser(pool);
const queue = new Queue(cfg.dbPath);
const recovered = queue.recoverRunning(Date.now());
// Shared: the server records interactive traffic, the drainer reads it to hold batch
// off until BATCH_HOLDOFF_MS after the last interactive request.
const idleTracker = createIdleTracker(cfg.idleWindowMs);

const drainer = new Drainer({
  queue, leaser, pool, cfg,
  runJob: makeRunJob(cfg),
  isInteractiveIdle: () => idleTracker.idleFor(Date.now(), cfg.batchHoldoffMs),
  onFinished: async (job) => {
    await deliverCallback(job);
    if (job.status === "dead") await alertDead(job, cfg);
  },
});

const discovery = startDiscovery({ cfg, pool, leaser });
const server = createServer({ cfg, pool, leaser, queue, drainer, idleTracker });

server.listen(cfg.port, "0.0.0.0", async () => {
  console.log(`[llm-router] listening :${cfg.port}; backends ${JSON.stringify(cfg.backends)}; recovered ${recovered} running job(s)`);
  await discovery.pollOnce();
  setInterval(() => {
    try {
      drainer.tick();
    } catch (err) {
      console.log(`[llm-router] drain tick failed: ${err.message}`);
    }
  }, 1000);
  setInterval(() => {
    try {
      queue.purge(Date.now(), cfg.doneRetentionMs);
    } catch (err) {
      console.log(`[llm-router] purge failed: ${err.message}`);
    }
  }, 3600000);
});
