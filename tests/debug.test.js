require("../lib/debug");

const debug = globalThis.LLSS_debug;

describe("LLSS_debug", () => {
  beforeEach(() => {
    debug.setEnabled(false);
    jest.restoreAllMocks();
  });

  // ── setEnabled / isEnabled ─────────────────────────────────────────────

  test("setEnabled/isEnabled toggle", () => {
    expect(debug.isEnabled()).toBe(false);
    debug.setEnabled(true);
    expect(debug.isEnabled()).toBe(true);
    debug.setEnabled(false);
    expect(debug.isEnabled()).toBe(false);
  });

  test("setEnabled coerces truthy values", () => {
    debug.setEnabled(1);
    expect(debug.isEnabled()).toBe(true);
    debug.setEnabled(0);
    expect(debug.isEnabled()).toBe(false);
  });

  test("setEnabled(true) logs an enable message", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    debug.setEnabled(true);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS]"),
      expect.any(String)
    );
  });

  // ── log() ──────────────────────────────────────────────────────────────

  test("log() outputs when enabled", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    debug.setEnabled(true);
    spy.mockClear();

    debug.log("test", "hello");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:test]"),
      expect.any(String),
      "hello"
    );
  });

  test("log() does not output when disabled", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    debug.setEnabled(false);
    spy.mockClear();

    debug.log("test", "hello");
    expect(spy).not.toHaveBeenCalled();
  });

  // ── warn() ─────────────────────────────────────────────────────────────

  test("warn() outputs when enabled", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    debug.setEnabled(true);

    debug.warn("pipeline", "fallback triggered");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:pipeline]"),
      "fallback triggered"
    );
  });

  test("warn() does not output when disabled", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    debug.setEnabled(false);

    debug.warn("pipeline", "fallback triggered");
    expect(spy).not.toHaveBeenCalled();
  });

  // ── error() ────────────────────────────────────────────────────────────

  test("error() always outputs even when disabled", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    debug.setEnabled(false);

    debug.error("critical", "something broke");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:critical]"),
      "something broke"
    );
  });

  test("error() outputs when enabled", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    debug.setEnabled(true);

    debug.error("critical", "something broke");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:critical]"),
      "something broke"
    );
  });

  // ── time() ─────────────────────────────────────────────────────────────

  test("time() returns a function that logs elapsed time when enabled", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    debug.setEnabled(true);
    spy.mockClear();

    const end = debug.time("perf", "operation");
    expect(typeof end).toBe("function");

    // The start message should have been logged
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:perf]"),
      expect.any(String),
      expect.stringContaining("started")
    );

    spy.mockClear();
    end();

    // The completion message should include timing
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[LLSS:perf]"),
      expect.any(String),
      expect.stringContaining("ms")
    );
  });

  test("time() returns a no-op function when disabled", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    debug.setEnabled(false);
    spy.mockClear();

    const end = debug.time("perf", "operation");
    expect(typeof end).toBe("function");

    end();
    // No output at all when disabled
    expect(spy).not.toHaveBeenCalled();
  });
});
