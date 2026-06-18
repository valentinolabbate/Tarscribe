// Microphone recording via the MediaRecorder API. The resulting blob is uploaded
// to the backend, which normalizes any container/codec to 16 kHz mono wav.

let micPermissionPrimed = false;

function microphoneCaptureConstraints(deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

/**
 * Make sure the microphone permission is *granted* before we open the real
 * capture stream.
 *
 * macOS quirk: when the system mic permission is still "not determined", the
 * first `getUserMedia` call returns a stream whose audio track only goes live
 * after the user answers the TCC prompt. Feeding that not-yet-live track into a
 * MediaRecorder right away yields an empty recording that then fails on stop —
 * which is exactly why a recording started before "Geräte aktualisieren"
 * (which makes that first throwaway call) used to break. Priming the permission
 * with a throwaway open/close moves it to a determined state, so the capture
 * stream we use for the actual recording is live from the first sample.
 */
export async function ensureMicrophonePermission(): Promise<void> {
  if (micPermissionPrimed) return;
  try {
    const status = await navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .catch(() => null);
    if (status?.state === "granted") {
      micPermissionPrimed = true;
      return;
    }
  } catch {
    // Permissions API unavailable (older WebKit) — fall through to priming.
  }
  const stream = await navigator.mediaDevices.getUserMedia(microphoneCaptureConstraints());
  stream.getTracks().forEach((track) => track.stop());
  micPermissionPrimed = true;
}

export class Recorder {
  readonly kind = "browser";
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mr = null;
  }

  get mimeType(): string {
    return this.mr?.mimeType || "audio/webm";
  }

  /** The underlying MediaStream, available after start() resolves. */
  get audioStream(): MediaStream | null {
    return this.stream;
  }

  async start(deviceId?: string): Promise<boolean> {
    // Grant the OS mic permission first so the capture stream is live (see above).
    await ensureMicrophonePermission();
    let usedFallback = false;
    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(microphoneCaptureConstraints(deviceId));
      } catch (e) {
        if (!deviceId || !isMissingDeviceError(e)) throw e;
        this.stream = await navigator.mediaDevices.getUserMedia(microphoneCaptureConstraints());
        usedFallback = true;
      }
      this.chunks = [];
      this.mr = new MediaRecorder(this.stream);
      this.mr.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      this.mr.start(1000); // gather data each second (robust for long recordings)
      return usedFallback;
    } catch (e) {
      this.cleanup();
      throw e;
    }
  }

  pause(): void {
    if (this.mr?.state === "recording") this.mr.pause();
  }
  resume(): void {
    if (this.mr?.state === "paused") this.mr.resume();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const mr = this.mr;
      if (!mr) return resolve(new Blob());
      mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: mr.mimeType || "audio/webm" });
        this.cleanup();
        resolve(blob);
      };
      mr.onerror = (e) => {
        this.cleanup();
        reject(e.error ?? new Error("Die Aufnahme wurde unerwartet beendet."));
      };
      try {
        mr.stop();
      } catch (e) {
        this.cleanup();
        reject(e);
      }
    });
  }

  dispose(): void {
    this.cleanup();
  }
}

function isMissingDeviceError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "NotFoundError" || e.name === "OverconstrainedError");
}

/**
 * Turn anything that gets thrown — Error, DOMException, string, plain object —
 * into a human-readable message. Never returns "undefined": `getUserMedia` and
 * MediaRecorder often reject with values whose `.message` is empty, which used
 * to surface to the user as literally "undefined".
 */
export function errorMessage(e: unknown): string {
  if (e instanceof DOMException || e instanceof Error) {
    const friendly: Record<string, string> = {
      NotAllowedError:
        "Kein Zugriff auf das Mikrofon. Bitte erlaube Tarscribe in den Systemeinstellungen den Mikrofonzugriff.",
      SecurityError:
        "Kein Zugriff auf das Mikrofon. Bitte erlaube Tarscribe in den Systemeinstellungen den Mikrofonzugriff.",
      NotFoundError: "Kein Mikrofon gefunden.",
      OverconstrainedError: "Das gewählte Mikrofon ist nicht verfügbar.",
      NotReadableError: "Das Mikrofon wird bereits von einer anderen App verwendet.",
    };
    return friendly[e.name] ?? e.message ?? e.name ?? "Unbekannter Fehler";
  }
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return "Unbekannter Fehler";
}

export interface RecordingDevice {
  deviceId: string;
  label: string;
}

export async function listRecordingDevices(requestPermission = false): Promise<RecordingDevice[]> {
  let stream: MediaStream | null = null;
  try {
    if (requestPermission) {
      stream = await navigator.mediaDevices.getUserMedia(microphoneCaptureConstraints());
      micPermissionPrimed = true; // refreshing already obtained the OS permission
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Mikrofon ${index + 1}`,
      }));
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export function recordingExtension(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}
