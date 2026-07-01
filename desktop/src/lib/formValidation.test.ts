import { describe, expect, it } from "vitest";
import { validateHfToken, validateHttpUrl, validateRequired } from "./formValidation";

describe("form validation", () => {
  it("validates required text fields", () => {
    expect(validateRequired("", "Name")).toBe("Name ist erforderlich.");
    expect(validateRequired(" Arbeit ", "Name")).toBeNull();
  });

  it("accepts only http and https URLs", () => {
    expect(validateHttpUrl("http://localhost:11434/v1", "Base-URL")).toBeNull();
    expect(validateHttpUrl("https://example.test", "Base-URL")).toBeNull();
    expect(validateHttpUrl("ftp://example.test", "Base-URL")).toBe("Base-URL muss mit http:// oder https:// beginnen.");
    expect(validateHttpUrl("localhost:11434", "Base-URL")).toBe("Base-URL muss mit http:// oder https:// beginnen.");
  });

  it("validates Hugging Face token shape", () => {
    expect(validateHfToken("hf_example")).toBeNull();
    expect(validateHfToken("token")).toBe("Hugging Face Tokens beginnen mit hf_.");
  });
});
