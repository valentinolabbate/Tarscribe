import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { checkForUpdate, type PendingUpdate } from "../lib/updater";
import { api } from "../lib/api";
import type { Recording, Topic } from "../lib/types";

interface RecordingController {
  state: string;
  start: (topicId: number, topicName: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<unknown> | void;
}

interface DictationController {
  state: string;
  toggle: () => Promise<void> | void;
}

type ToastFn = (message: string, type?: "success" | "error" | "info") => void;

export function useDetectedMeetingStarter({
  topics,
  queryClient,
  recordingRef,
  setActiveTopic,
  setShowHome,
  setShowTasks,
  setShowPeople,
  setShowJobs,
  setOpenRecording,
  setDetectedMeeting,
  toast,
}: {
  topics: Topic[] | undefined;
  queryClient: QueryClient;
  recordingRef: MutableRefObject<RecordingController>;
  setActiveTopic: Dispatch<SetStateAction<number | null>>;
  setShowHome: Dispatch<SetStateAction<boolean>>;
  setShowTasks: Dispatch<SetStateAction<boolean>>;
  setShowPeople: Dispatch<SetStateAction<boolean>>;
  setShowJobs: Dispatch<SetStateAction<boolean>>;
  setOpenRecording: Dispatch<SetStateAction<Recording | null>>;
  setDetectedMeeting: Dispatch<SetStateAction<{ appName: string } | null>>;
  toast: ToastFn;
}) {
  return useCallback(async () => {
    if (recordingRef.current.state !== "idle") {
      setDetectedMeeting(null);
      return;
    }
    try {
      let topic = topics?.find((item) => item.name.toLowerCase() === "meetings");
      if (!topic) {
        topic = await api.createTopic("Meetings", "#0f766e");
        await queryClient.invalidateQueries({ queryKey: ["topics"] });
      }
      setActiveTopic(topic.id);
      setShowHome(false);
      setShowTasks(false);
      setShowPeople(false);
      setShowJobs(false);
      setOpenRecording(null);
      await recordingRef.current.start(topic.id, topic.name);
      setDetectedMeeting(null);
    } catch (error) {
      toast(`Meeting-Aufnahme konnte nicht gestartet werden: ${(error as Error).message}`, "error");
    }
  }, [
    queryClient,
    recordingRef,
    setActiveTopic,
    setDetectedMeeting,
    setOpenRecording,
    setShowHome,
    setShowJobs,
    setShowPeople,
    setShowTasks,
    toast,
    topics,
  ]);
}

export function useNativeAppEvents({
  currentTopicRef,
  recordingRef,
  dictationRef,
  setShowSettings,
  setShowTopicModal,
  setUpdate,
  setShowUpdate,
  setDetectedMeeting,
  toast,
}: {
  currentTopicRef: MutableRefObject<Topic | null>;
  recordingRef: MutableRefObject<RecordingController>;
  dictationRef: MutableRefObject<DictationController>;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowTopicModal: Dispatch<SetStateAction<boolean>>;
  setUpdate: Dispatch<SetStateAction<PendingUpdate | null>>;
  setShowUpdate: Dispatch<SetStateAction<boolean>>;
  setDetectedMeeting: Dispatch<SetStateAction<{ appName: string } | null>>;
  toast: ToastFn;
}) {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlisteners: (() => void)[] = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("menu", (event) => {
        if (event.payload === "settings") setShowSettings(true);
        if (event.payload === "new-topic") setShowTopicModal(true);
        if (event.payload === "record-start") {
          const topic = currentTopicRef.current;
          const activeRecording = recordingRef.current;
          if (!topic) {
            setShowTopicModal(true);
            toast("Wähle zuerst einen Themenbereich für die Aufnahme.", "info");
            return;
          }
          if (activeRecording.state === "idle") {
            void activeRecording.start(topic.id, topic.name);
          }
        }
        if (event.payload === "record-pause") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "recording") activeRecording.pause();
        }
        if (event.payload === "record-resume") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "paused") activeRecording.resume();
        }
        if (event.payload === "record-stop") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state === "recording" || activeRecording.state === "paused") {
            void activeRecording.stop();
          }
        }
        if (event.payload === "dictation-toggle") {
          const activeRecording = recordingRef.current;
          if (activeRecording.state !== "idle") {
            toast("Diktat kann während einer laufenden Aufnahme nicht gestartet werden.", "info");
            return;
          }
          void dictationRef.current.toggle();
        }
        if (event.payload === "check-update") {
          checkForUpdate().then((update) => {
            if (update) {
              setUpdate(update);
              setShowUpdate(true);
            } else {
              toast("Tarscribe ist auf dem neuesten Stand.", "success");
            }
          });
        }
      }).then((unlisten) => unlisteners.push(unlisten));
      listen<{ app_name: string }>("meeting-detected", (event) => {
        if (recordingRef.current.state !== "idle") return;
        if (dictationRef.current.state !== "idle") return;
        setDetectedMeeting({ appName: event.payload.app_name });
      }).then((unlisten) => unlisteners.push(unlisten));
    });
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [
    currentTopicRef,
    dictationRef,
    recordingRef,
    setDetectedMeeting,
    setShowSettings,
    setShowTopicModal,
    setShowUpdate,
    setUpdate,
    toast,
  ]);
}
