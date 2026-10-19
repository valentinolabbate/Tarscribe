import { afterEach, describe, expect, it, vi } from "vitest";
import { api, downloadFilenameFromContentDisposition } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("backend health timeout", () => {
  it("aborts an unresponsive server so recovery can be offered", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const result = expect(api.health()).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timeout after a successful probe", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"ok"}')));
    await expect(api.health()).resolves.toEqual({ status: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("downloadFilenameFromContentDisposition", () => {
  it("parses quoted filenames", () => {
    expect(downloadFilenameFromContentDisposition('attachment; filename="bericht.md"')).toBe("bericht.md");
  });

  it("parses RFC 5987 encoded filenames", () => {
    expect(downloadFilenameFromContentDisposition("attachment; filename*=UTF-8''Tarscribe%20Aufgaben.ics")).toBe(
      "Tarscribe Aufgaben.ics",
    );
  });

  it("returns null when no filename is present", () => {
    expect(downloadFilenameFromContentDisposition("attachment")).toBeNull();
    expect(downloadFilenameFromContentDisposition(null)).toBeNull();
  });
});

describe("audio preview cache", () => {
  it("gives a replaced audio file a fresh browser URL even if the recording id is reused", async () => {
    const first = await api.audioUrl(1, "/private/audio/first.wav");
    const replacement = await api.audioUrl(1, "/private/audio/replacement.wav");
    expect(first).not.toBe(replacement);
    expect(replacement).toContain("/api/recordings/1/audio?v=replacement.wav");
    expect(replacement).not.toContain("/private/audio");
  });

  it("does not reuse a cached missing-audio response for the waveform", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"duration_sec":20,"peaks":[0,1]}'));
    vi.stubGlobal("fetch", fetch);
    await expect(api.getWaveform(1)).resolves.toEqual({ duration_sec: 20, peaks: [0, 1] });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/recordings/1/waveform"),
      expect.objectContaining({ cache: "no-store" }));
  });
});

describe("chat conversation identity", () => {
  it("sends the persisted conversation identity with each streamed turn", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(
      'data: {"type":"delta","content":"Antwort"}\n\ndata: {"type":"done"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const onDelta = vi.fn();
    for (const sessionId of ["tarscribe-chat-12", "tarscribe-chat-12", "tarscribe-chat-13"]) {
      await api.ragChat([{ role: "user", content: "Was wurde entschieden?" }],
        { sessionId, recordingId: 7 }, { onDelta });
    }
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((body) => body.session_id)).toEqual([
      "tarscribe-chat-12", "tarscribe-chat-12", "tarscribe-chat-13",
    ]);
    expect(bodies.every((body) => body.recording_id === 7)).toBe(true);
    expect(onDelta).toHaveBeenCalledTimes(3);
    expect(onDelta).toHaveBeenCalledWith("Antwort");
  });
});
