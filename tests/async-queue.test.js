const { AsyncQueue } = require("../lib/documents/async-queue");

describe("AsyncQueue", () => {
  test("processes tasks in FIFO order", async () => {
    const q = new AsyncQueue(1); // concurrency 1 = strict order
    const order = [];

    await q.enqueueAll([
      { id: "a", fn: async () => { order.push("a"); return "a"; } },
      { id: "b", fn: async () => { order.push("b"); return "b"; } },
      { id: "c", fn: async () => { order.push("c"); return "c"; } },
    ]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  test("limits concurrency", async () => {
    const q = new AsyncQueue(2);
    let maxConcurrent = 0;
    let current = 0;

    const makeTask = (id) => ({
      id,
      fn: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 10));
        current--;
        return id;
      },
    });

    await q.enqueueAll([
      makeTask("a"),
      makeTask("b"),
      makeTask("c"),
      makeTask("d"),
    ]);

    expect(maxConcurrent).toBe(2);
  });

  test("concurrency of 1 runs tasks sequentially", async () => {
    const q = new AsyncQueue(1);
    let maxConcurrent = 0;
    let current = 0;

    const makeTask = (id) => ({
      id,
      fn: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 5));
        current--;
        return id;
      },
    });

    await q.enqueueAll([makeTask("a"), makeTask("b"), makeTask("c")]);

    expect(maxConcurrent).toBe(1);
  });

  test("enqueue returns individual task result", async () => {
    const q = new AsyncQueue(2);
    const result = await q.enqueue({ fn: async () => 42 });
    expect(result).toBe(42);
  });

  test("enqueueAll returns settled results", async () => {
    const q = new AsyncQueue(2);

    const results = await q.enqueueAll([
      { id: "ok", fn: async () => "success" },
      { id: "fail", fn: async () => { throw new Error("boom"); } },
    ]);

    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.task.id === "ok");
    const fail = results.find((r) => r.task.id === "fail");
    expect(ok.result).toBe("success");
    expect(fail.error).toBeInstanceOf(Error);
    expect(fail.error.message).toBe("boom");
  });

  test("calls onTaskStart, onTaskDone, onDrain callbacks", async () => {
    const q = new AsyncQueue(1);
    const events = [];

    q.onTaskStart = (task) => events.push(`start:${task.id}`);
    q.onTaskDone = (task, result) => events.push(`done:${task.id}:${result}`);
    q.onDrain = () => events.push("drain");

    await q.enqueueAll([
      { id: "a", fn: async () => 1 },
      { id: "b", fn: async () => 2 },
    ]);

    expect(events).toEqual([
      "start:a", "done:a:1",
      "start:b", "done:b:2",
      "drain",
    ]);
  });

  test("calls onTaskError for failed tasks", async () => {
    const q = new AsyncQueue(1);
    const errors = [];

    q.onTaskError = (task, err) => errors.push(`${task.id}:${err.message}`);

    await q.enqueueAll([
      { id: "bad", fn: async () => { throw new Error("oops"); } },
    ]);

    expect(errors).toEqual(["bad:oops"]);
  });

  test("tracks pending, active, completed, total counts", async () => {
    const q = new AsyncQueue(1);

    expect(q.pending).toBe(0);
    expect(q.active).toBe(0);
    expect(q.completed).toBe(0);
    expect(q.total).toBe(0);

    let resolveFn;
    const blockingTask = { fn: () => new Promise((r) => { resolveFn = r; }) };

    const p1 = q.enqueue(blockingTask);
    const p2 = q.enqueue({ fn: async () => "done" });

    // Wait a tick for the pump to start
    await new Promise((r) => setTimeout(r, 0));

    expect(q.active).toBe(1);
    expect(q.pending).toBe(1);
    expect(q.total).toBe(2);

    resolveFn("ok");
    await p1;
    await p2;

    // Allow microtasks to settle (finally blocks run after resolve)
    await new Promise((r) => setTimeout(r, 10));

    expect(q.completed).toBe(2);
    expect(q.active).toBe(0);
    expect(q.pending).toBe(0);
  });

  test("clear rejects pending tasks", async () => {
    const q = new AsyncQueue(1);

    // Block the first task
    const p1 = q.enqueue({ fn: () => new Promise(() => {}) }); // Never resolves

    // These will be queued
    const p2 = q.enqueue({ fn: async () => "b" });
    const p3 = q.enqueue({ fn: async () => "c" });

    await new Promise((r) => setTimeout(r, 0));

    q.clear();

    await expect(p2).rejects.toThrow("Queue cleared");
    await expect(p3).rejects.toThrow("Queue cleared");
    expect(q.pending).toBe(0);
  });

  test("minimum concurrency is 1", () => {
    const q = new AsyncQueue(0);
    expect(q.concurrency).toBe(1);

    const q2 = new AsyncQueue(-5);
    expect(q2.concurrency).toBe(1);
  });
});
