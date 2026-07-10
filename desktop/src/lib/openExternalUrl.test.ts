import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./tauri";
import { openExternalUrl } from "./openExternalUrl";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./tauri", () => ({ isTauri: vi.fn() }));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReset();
    vi.mocked(openUrl).mockReset();
  });

  it("uses the native opener inside Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    await openExternalUrl("https://example.com/source");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/source");
  });

  it("uses a new browser tab outside Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal("window", { open });
    await openExternalUrl("https://example.com/source");
    expect(open).toHaveBeenCalledWith(
      "https://example.com/source",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });

  it("rejects unsupported URL schemes", async () => {
    await expect(openExternalUrl("javascript:alert(1)")).rejects.toThrow(
      "Nur HTTP- und HTTPS-Links",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });
});
