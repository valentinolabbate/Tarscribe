// Microphone recording via the MediaRecorder API. The resulting blob is uploaded
// to the backend, which normalizes any container/codec to 16 kHz mono wav.

export class Recorder {
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

  async start(deviceId?: string): Promise<boolean> {
    let usedFallback = false;
    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch (e) {
        if (!deviceId || !isMissingDeviceError(e)) throw e;
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        reject(e.error);
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

export interface RecordingDevice {
  deviceId: string;
  label: string;
}

export async function listRecordingDevices(requestPermission = false): Promise<RecordingDevice[]> {
  let stream: MediaStream | null = null;
  try {
    if (requestPermission) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
