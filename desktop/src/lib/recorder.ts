// Microphone recording via the MediaRecorder API. The resulting blob is uploaded
// to the backend, which normalizes any container/codec to 16 kHz mono wav.

export class Recorder {
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  get mimeType(): string {
    return this.mr?.mimeType || "audio/webm";
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mr = new MediaRecorder(this.stream);
    this.mr.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.mr.start(1000); // gather data each second (robust for long recordings)
  }

  pause(): void {
    if (this.mr?.state === "recording") this.mr.pause();
  }
  resume(): void {
    if (this.mr?.state === "paused") this.mr.resume();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const mr = this.mr;
      if (!mr) return resolve(new Blob());
      mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: mr.mimeType || "audio/webm" });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.mr = null;
        resolve(blob);
      };
      mr.stop();
    });
  }
}

export function recordingExtension(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "mp4";
  return "webm";
}
