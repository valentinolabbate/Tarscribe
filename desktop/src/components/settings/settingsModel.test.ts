import { describe, expect, it } from "vitest";
import {
  ASR_MODEL_SUGGESTIONS, asrEngineValue, asrPurpose, experimentalAsr,
  normalizeAsrModelForEngine,
} from "./settingsModel";

describe("transcription model catalog", () => {
  it("offers exactly the five requested experimental engines", () => {
    expect(ASR_MODEL_SUGGESTIONS.filter((item) => experimentalAsr(item.engine)).map((item) => item.engine))
      .toEqual(["qwen3-mlx", "nemotron-mlx", "moss-mlx", "vibevoice-mlx", "vibevoice-bitnet"]);
    expect(JSON.stringify(ASR_MODEL_SUGGESTIONS)).not.toMatch(/voxtral|cohere/i);
  });

  it.each(ASR_MODEL_SUGGESTIONS)("recognizes $engine and preserves compatible presets", (item) => {
    expect(asrEngineValue(item.engine)).toBe(item.engine);
    expect(normalizeAsrModelForEngine(item.engine, item.model)).toBe(item.model);
  });

  it("clears known incompatible model IDs when changing engine", () => {
    expect(normalizeAsrModelForEngine("nemotron-mlx", "mlx-community/Qwen3-ASR-1.7B-8bit")).toBe("");
    expect(asrEngineValue("unknown")).toBe("");
  });

  it("keeps established defaults and separates use cases", () => {
    expect(experimentalAsr("")).toBe(false);
    expect(asrPurpose("parakeet-mlx")).toBe("everyday");
    expect(asrPurpose("qwen3-mlx")).toBe("quality");
    expect(asrPurpose("nemotron-mlx")).toBe("live");
    expect(asrPurpose("moss-mlx")).toBe("speakers");
    expect(asrPurpose("vibevoice-bitnet")).toBe("cpu");
  });
});
