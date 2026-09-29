// In-process job queues. Each named queue runs its handler with limited
// concurrency; jobs live in memory only (durable state belongs in the DB,
// e.g. zip_jobs rows, so a restart can mark interrupted work as failed).
//
// createJobs(ctx) -> { register(name, handler, { concurrency }), enqueue(name, payload),
//                      idle(), stop(), stats() }
// handler(payload, ctx) may be async; errors are logged, never thrown back.

export function createJobs(ctx) {
  const queues = new Map();
  const idleWaiters = new Set();
  let stopped = false;
  let stopWaiter = null;

  const log = ctx?.log ?? console;

  function busy() {
    for (const queue of queues.values()) if (queue.items.length || queue.running) return true;
    return false;
  }

  function settle() {
    if (busy()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
    if (stopWaiter) stopWaiter();
  }

  function pump(queue) {
    while (!stopped && queue.running < queue.concurrency && queue.items.length) {
      const job = queue.items.shift();
      queue.running += 1;
      Promise.resolve()
        .then(() => queue.handler(job.payload, ctx))
        .then(job.resolve, (err) => {
          log.error(`[jobs] ${queue.name} failed:`, err);
          job.resolve(undefined);
        })
        .finally(() => {
          queue.running -= 1;
          pump(queue);
          settle();
        });
    }
    if (stopped) {
      // drop what never started
      for (const job of queue.items.splice(0)) job.resolve(undefined);
    }
  }

  return {
    register(name, handler, { concurrency = 1 } = {}) {
      if (typeof handler !== "function") throw new Error(`job handler for ${name} must be a function`);
      const existing = queues.get(name);
      const queue = existing ?? { name, items: [], running: 0 };
      queue.handler = handler;
      queue.concurrency = Math.max(1, concurrency);
      queues.set(name, queue);
      pump(queue);
    },
    // Resolves with the handler result when the job finishes (callers
    // usually do not await it). Unknown queues are ignored.
    enqueue(name, payload) {
      const queue = queues.get(name);
      if (!queue?.handler || stopped) {
        if (!stopped) log.debug?.(`[jobs] no handler for ${name}; job dropped`);
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => {
        const start = () => {
          queue.items.push({ payload, resolve });
          queueMicrotask(() => pump(queue));
        };
        // Inside a transaction the job starts after the commit, outside the
        // transaction (never when it rolls back).
        if (ctx?.db?.inTransaction?.()) ctx.db.afterCommit(start);
        else start();
      });
    },
    has(name) {
      return Boolean(queues.get(name)?.handler);
    },
    // Resolves when every queue is empty and idle (tests).
    idle() {
      if (!busy()) return new Promise((resolve) => setImmediate(() => (busy() ? idleWaiters.add(resolve) : resolve())));
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    // Stops taking work; resolves when running jobs finish.
    stop() {
      stopped = true;
      for (const queue of queues.values()) for (const job of queue.items.splice(0)) job.resolve(undefined);
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => {
        stopWaiter = resolve;
      });
    },
    stats() {
      return [...queues.values()].map((q) => ({ name: q.name, queued: q.items.length, running: q.running }));
    },
  };
}
