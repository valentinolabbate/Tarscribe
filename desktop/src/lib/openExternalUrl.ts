import { isTauri } from "./tauri";

export async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Nur HTTP- und HTTPS-Links können geöffnet werden.");
  }
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.href);
    return;
  }
  const opened = window.open(url.href, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("Der Browser hat das neue Fenster blockiert.");
}
