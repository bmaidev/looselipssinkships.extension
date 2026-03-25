/**
 * Debug logger for Loose Lips Sink Ships.
 *
 * Outputs to the browser console when debugMode is enabled in settings.
 * All messages are prefixed with [LLSS] and grouped by subsystem.
 *
 * Usage:
 *   LLSS_debug.log("nano", "Session created", { prompt: "..." });
 *   LLSS_debug.warn("pipeline", "Fallback to regex");
 *   LLSS_debug.setEnabled(true);
 */

(function () {
  'use strict';

  let enabled = false;

  const debug = {
    /** Enable or disable debug output. */
    setEnabled(flag) {
      enabled = !!flag;
      if (enabled) {
        console.log(
          '%c[LLSS] Debug logging enabled',
          'color: #22c55e; font-weight: bold'
        );
      }
    },

    isEnabled() {
      return enabled;
    },

    /** Standard debug log.  @param {string} subsystem  @param {...any} args */
    log(subsystem, ...args) {
      if (!enabled) return;
      console.log(
        `%c[LLSS:${subsystem}]`,
        'color: #3b82f6; font-weight: bold',
        ...args
      );
    },

    /** Warning-level log.  @param {string} subsystem  @param {...any} args */
    warn(subsystem, ...args) {
      if (!enabled) return;
      console.warn(`[LLSS:${subsystem}]`, ...args);
    },

    /** Error-level log (always outputs, even when debug is off). */
    error(subsystem, ...args) {
      console.error(`[LLSS:${subsystem}]`, ...args);
    },

    /** Log with timing — returns a function that logs elapsed ms when called. */
    time(subsystem, label) {
      if (!enabled) return () => {};
      const start = performance.now();
      debug.log(subsystem, `${label} — started`);
      return () => {
        const elapsed = (performance.now() - start).toFixed(1);
        debug.log(subsystem, `${label} — ${elapsed}ms`);
      };
    },
  };

  if (typeof globalThis !== 'undefined') globalThis.LLSS_debug = debug;
  if (typeof module !== 'undefined' && module.exports) module.exports = { debug };
})();
