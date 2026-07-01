import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { invoke, isTauri } from "../lib/tauri";

function shortcutLabel(accelerator: string): string {
  const symbols: Record<string, string> = {
    alt: "⌥",
    option: "⌥",
    opt: "⌥",
    meta: "⌘",
    cmd: "⌘",
    command: "⌘",
    super: "⌘",
    ctrl: "⌃",
    control: "⌃",
    shift: "⇧",
  };
  return accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => symbols[part.toLowerCase()] ?? part.toUpperCase())
    .join("");
}

export function useAppSettingsBootstrap({
  ready,
  needsSetup,
  needsEnv,
  toast,
}: {
  ready: boolean;
  needsSetup: boolean;
  needsEnv: boolean;
  toast: (message: string, type?: "success" | "error" | "info") => void;
}) {
  const [dictationShortcutLabel, setDictationShortcutLabel] = useState("⌥⌘D");

  useEffect(() => {
    if (!ready || needsSetup || needsEnv) return;
    api.getSettings()
      .then((settings) => {
        const accelerator = settings.dictation_shortcut || "Alt+Meta+D";
        setDictationShortcutLabel(shortcutLabel(accelerator));
        if (isTauri()) {
          return Promise.all([
            invoke<string>("set_dictation_shortcut", { accelerator }).catch((error) => {
              toast(`Diktat-Hotkey konnte nicht gesetzt werden: ${String(error)}`, "error");
            }),
            invoke<void>("configure_meeting_detection", {
              enabled: settings.meeting_detection_enabled,
              apps: settings.meeting_detection_apps,
            }).catch(() => {}),
          ]);
        }
      })
      .catch(() => {});
  }, [needsEnv, needsSetup, ready, toast]);

  return dictationShortcutLabel;
}
