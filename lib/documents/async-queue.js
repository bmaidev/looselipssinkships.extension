/**
 * AsyncQueue — FIFO task queue with bounded concurrency.
 *
 * Prevents the browser from pegging at 100% CPU when a user drops
 * 10 files at once. Only `concurrency` files are processed at a time;
 * the rest wait in the queue.
 *
 * Usage:
 *   const q = new AsyncQueue(2);
 *   q.onTaskStart  = (task) => { ... };
 *   q.onTaskDone   = (task, result) => { ... };
 *   q.onTaskError  = (task, err) => { ... };
 *   q.onDrain      = () => { ... }; // all tasks finished
 *
 *   const results = await q.enqueueAll([
 *     { id: 'file1', fn: () => processFile(file1) },
 *     { id: 'file2', fn: () => processFile(file2) },
 *   ]);
 */

(function () {
  'use strict';

  class AsyncQueue {
    /**
     * @param {number} [concurrency=2] — max simultaneous active tasks
     */
    constructor(concurrency = 2) {
      this.concurrency = Math.max(1, concurrency);
      this._queue = [];      // pending tasks
      this._active = 0;      // currently running
      this._completed = 0;   // finished (success or error)
      this._total = 0;       // total ever enqueued
      this._results = [];

      // Callbacks (override these)
      this.onTaskStart = null; // (task) => void
      this.onTaskDone = null;  // (task, result) => void
      this.onTaskError = null; // (task, error) => void
      this.onDrain = null;     // () => void — queue empty + nothing active
    }

    /**
     * Add a single task to the queue.
     * @param {{id?: string, fn: () => Promise<any>, [key: string]: any}} task
     * @returns {Promise<any>} resolves with the task's result
     */
    enqueue(task) {
      return new Promise((resolve, reject) => {
        this._total++;
        this._queue.push({ task, resolve, reject });
        this._pump();
      });
    }

    /**
     * Add multiple tasks and wait for all to complete.
     * @param {Array<{id?: string, fn: () => Promise<any>}>} tasks
     * @returns {Promise<Array<{task, result?, error?}>>}
     */
    async enqueueAll(tasks) {
      const settled = [];
      const promises = tasks.map((task) =>
        this.enqueue(task)
          .then((result) => settled.push({ task, result }))
          .catch((error) => settled.push({ task, error }))
      );
      await Promise.allSettled(promises);
      return settled;
    }

    /** Number of tasks waiting in the queue. */
    get pending() {
      return this._queue.length;
    }

    /** Number of tasks currently executing. */
    get active() {
      return this._active;
    }

    /** Number of tasks completed (success + error). */
    get completed() {
      return this._completed;
    }

    /** Total tasks ever enqueued. */
    get total() {
      return this._total;
    }

    /** Clear pending tasks (does not cancel active ones). */
    clear() {
      for (const item of this._queue) {
        item.reject(new Error('Queue cleared'));
      }
      this._queue = [];
    }

    // ── Internal ──────────────────────────────────────────────────────────

    _pump() {
      while (this._active < this.concurrency && this._queue.length > 0) {
        const { task, resolve, reject } = this._queue.shift();
        this._active++;

        if (this.onTaskStart) {
          try { this.onTaskStart(task); } catch (_) { /* swallow */ }
        }

        task
          .fn()
          .then((result) => {
            this._results.push(result);
            if (this.onTaskDone) {
              try { this.onTaskDone(task, result); } catch (_) { /* swallow */ }
            }
            resolve(result);
          })
          .catch((err) => {
            if (this.onTaskError) {
              try { this.onTaskError(task, err); } catch (_) { /* swallow */ }
            }
            reject(err);
          })
          .finally(() => {
            this._active--;
            this._completed++;
            this._pump();

            if (this._active === 0 && this._queue.length === 0 && this.onDrain) {
              try { this.onDrain(); } catch (_) { /* swallow */ }
            }
          });
      }
    }
  }

  // Exports
  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_AsyncQueue = AsyncQueue;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AsyncQueue };
  }
})();
