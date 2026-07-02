import { describe, expect, it } from "vitest";
import { bytesFromIpcResponse, downloadFilenameFromContentDisposition } from "./api";

describe("bytesFromIpcResponse", () => {
  it("keeps raw IPC array buffers binary", () => {
    const input = new Uint8Array([82, 73, 70, 70]).buffer;
    expect([...bytesFromIpcResponse(input)]).toEqual([82, 73, 70, 70]);
  });

  it("supports the numeric fallback used outside raw IPC", () => {
    expect([...bytesFromIpcResponse([1, 2, 255])]).toEqual([1, 2, 255]);
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
