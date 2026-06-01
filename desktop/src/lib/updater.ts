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

/** Download + install the update, reporting progress (0..1), then relaunch. */
export async function installUpdate(
  pending: PendingUpdate,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const update = pending.handle as {
    downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
  };
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      downloaded += e.data.chunkLength;
      if (total) onProgress?.(Math.min(1, downloaded / total));
    } else if (e.event === "Finished") onProgress?.(1);
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data: Record<string, never> };
