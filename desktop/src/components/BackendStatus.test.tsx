import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStatus } from "./BackendStatus";
import { Splash } from "./Splash";

afterEach(() => vi.unstubAllGlobals());

describe("backend recovery UI", () => {
  it("offers service restart in the desktop app even when startup failed", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const html = renderToStaticMarkup(<Splash connection={{ status: "offline", error: "Dienst antwortet nicht" }} onRestart={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Dienst neu starten");
    expect(html).toContain("Dienst antwortet nicht");
  });

  it("offers reconnect in the browser", () => {
    const html = renderToStaticMarkup(<BackendStatus connection={{ status: "offline" }} onRestart={vi.fn()} />);
    expect(html).toContain("Erneut verbinden");
  });

  it("disables repeated clicks during restart and disappears when online", () => {
    const html = renderToStaticMarkup(<BackendStatus connection={{ status: "restarting" }} onRestart={vi.fn()} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('disabled=""');
    expect(renderToStaticMarkup(<BackendStatus connection={{ status: "online" }} onRestart={vi.fn()} />)).toBe("");
  });
});
