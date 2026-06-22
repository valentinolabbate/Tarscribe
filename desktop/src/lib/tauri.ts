// Thin wrappers around Tauri APIs that no-op in a plain browser (dev).

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export interface SystemAudioCapability {
  supported: boolean;
  minimum_macos_version: string;
  current_macos_version: string | null;
  reason: string | null;
}

export async function getSystemAudioCapability(): Promise<SystemAudioCapability> {
  if (!isTauri()) {
    return {
      supported: false,
      minimum_macos_version: "14.2",
      current_macos_version: null,
      reason: "Systemaudio-Aufnahmen sind nur in der installierten Desktop-App verfügbar.",
    };
  }
  return invoke<SystemAudioCapability>("system_audio_capability");
}

export type TrayRecordingState =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "saving"
  | "transcribing";

export async function setTrayRecordingState(payload: {
  state: TrayRecordingState;
  elapsed: number;
  topicName: string | null;
  canStart: boolean;
}): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_tray_recording_state", {
    payload: {
      state: payload.state,
      elapsed: Math.max(0, Math.floor(payload.elapsed)),
      topicName: payload.topicName,
      canStart: payload.canStart,
    },
  });
}

/** Native folder picker (Tauri only); returns null in a plain browser. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}
