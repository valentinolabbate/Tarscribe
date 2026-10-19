import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendMonitor } from "./backendMonitor";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const probe = vi.fn<() => Promise<unknown>>().mockResolvedValue({ status: "ok" });
  const restart = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  const changed = vi.fn();
  const monitor = createBackendMonitor(probe, restart, changed);
  return { probe, restart, changed, monitor };
}

describe("backend connection recovery", () => {
  it("reports a crash and reconnects without restarting the app", async () => {
    const { probe, changed, monitor } = fixture();
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith({ status: "online" });
    probe.mockRejectedValue(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed.mock.lastCall?.[0].status).toBe("offline");
    probe.mockResolvedValue({ status: "ok" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenLastCalledWith({ status: "online" });
    monitor.stop();
  });

  it("allows startup time, then shows an error and keeps checking", async () => {
    const { probe, changed, monitor } = fixture();
    probe.mockRejectedValue(new Error("not started"));
    monitor.start();
    await vi.advanceTimersByTimeAsync(29000);
    expect(changed).toHaveBeenLastCalledWith({ status: "starting" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed.mock.lastCall?.[0].status).toBe("offline");
    probe.mockResolvedValue({ status: "ok" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenLastCalledWith({ status: "online" });
    monitor.stop();
  });

  it("ignores stale probes and serializes repeated restart clicks", async () => {
    const { probe, restart, changed, monitor } = fixture();
    let resolveProbe!: () => void;
    let resolveRestart!: () => void;
    probe.mockReturnValueOnce(new Promise<void>((resolve) => { resolveProbe = resolve; }));
    restart.mockReturnValueOnce(new Promise<void>((resolve) => { resolveRestart = resolve; }));
    monitor.start();
    const restarting = monitor.restart();
    await monitor.restart();
    resolveProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
    resolveRestart();
    await restarting;
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith({ status: "online" });
    monitor.stop();
  });

  it("makes a failed restart retryable", async () => {
    const { restart, changed, monitor } = fixture();
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    restart.mockRejectedValueOnce(new Error("Python missing"));
    await monitor.restart();
    expect(changed).toHaveBeenLastCalledWith({ status: "offline", error: "Neustart fehlgeschlagen: Python missing" });
    await monitor.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ status: "online" });
    monitor.stop();
  });

  it("does not leave timers or publish results after unmount", async () => {
    const { probe, changed, monitor } = fixture();
    let resolve!: () => void;
    probe.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    monitor.start();
    monitor.stop();
    changed.mockClear();
    resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(changed).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
