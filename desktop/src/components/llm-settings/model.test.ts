import { describe, expect, it } from "vitest";
import { buildModelSelectOptions } from "./model";

describe("buildModelSelectOptions", () => {
  it("deduplicates server models and keeps the current selection first", () => {
    expect(buildModelSelectOptions(["llama", "mistral", "llama"], "mistral")).toEqual([
      { value: "mistral", label: "mistral", available: true },
      { value: "llama", label: "llama", available: true },
    ]);
  });

  it("keeps a saved model that is not reported by the server", () => {
    expect(buildModelSelectOptions(["llama"], "old-model")).toEqual([
      { value: "old-model", label: "old-model (gespeichert)", available: false },
      { value: "llama", label: "llama", available: true },
    ]);
  });
});
