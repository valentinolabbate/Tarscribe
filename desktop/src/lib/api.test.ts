import { describe, expect, it } from "vitest";
import { downloadFilenameFromContentDisposition } from "./api";

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
