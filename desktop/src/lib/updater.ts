import { invoke, isTauri } from "./tauri";

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

// Opaque handle to the pending update (Tauri Update object).
export interface PendingUpdate {
  handle: unknown;
  info: UpdateInfo;
}

/** Check GitHub for a newer signed release. Returns null if up to date. */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) {
    await invoke("set_update_badge", { available: false, version: null }).catch(() => {});
    return null;
  }
  await invoke("set_update_badge", { available: true, version: update.version }).catch(() => {});
  return {
    handle: update,
    info: { version: update.version, notes: update.body || undefined, date: update.date || undefined },
  };
}

/** Turn anything thrown (Tauri plugins often throw strings/objects) into a message. */
export function describeError(e: unknown): string {
  if (e == null) return "Unbekannter Fehler";
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "object") {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

/** Open the latest GitHub release page so the user can download the DMG manually. */
export async function openReleasesPage(): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://github.com/valentinolabbate/Tarscribe/releases/latest");
}

export type InstallResult = "relaunching" | "needs-restart";

/**
 * Download + install the update, reporting progress (0..1), then relaunch.
 *
 * Throws (with a real message) only when the download/install itself fails. If the
 * install succeeds but the relaunch fails, the update *is* applied — we return
 * "needs-restart" so the user only has to reopen the app, not reinstall it.
 */
export async function installUpdate(
  pending: PendingUpdate,
  onProgress?: (fraction: number) => void,
): Promise<InstallResult> {
  // Warn if running from the read-only DMG (the update can't be written there).
  // NOTE: executableDir() is unsupported on macOS — it throws "unknown path"
  // (dirs::executable_dir() returns None), which previously made EVERY macOS update
  // fail before it began. resourceDir() resolves from the bundle and works on macOS;
  // any failure here is treated as "not on a DMG" so the update can proceed.
  let bundleLocation: string | null = null;
  try {
    const { resourceDir } = await import("@tauri-apps/api/path");
    bundleLocation = await resourceDir();
  } catch {
    /* path API unavailable — skip the DMG guard */
  }
  if (bundleLocation?.startsWith("/Volumes/")) {
    throw new Error("Bitte verschiebe Tarscribe zuerst in den Programme-Ordner und starte die App erneut.");
  }
  const update = pending.handle as {
    downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
  };
  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        downloaded += e.data.chunkLength;
        if (total) onProgress?.(Math.min(1, downloaded / total));
      } else if (e.event === "Finished") onProgress?.(1);
    });
  } catch (e) {
    console.error("[updater] download/install failed:", e);
    throw new Error(describeError(e));
  }

  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return "relaunching";
  } catch (e) {
    // The update is already installed at this point; only the auto-restart failed.
    console.error("[updater] relaunch failed (update already installed):", e);
    return "needs-restart";
  }
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data: Record<string, never> };
