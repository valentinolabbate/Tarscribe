import { invoke } from "./tauri";
import { Recorder } from "./recorder";

export interface NativeRecordingOutput {
  path: string;
}

/** Sample rate of the native system-audio live-preview stream (0 if idle). */
export function systemAudioSampleRate(): Promise<number> {
  return invoke<number>("system_audio_sample_rate");
}

/** Drain the system-audio samples buffered since the last poll (mono float). */
export async function pollSystemAudioPcm(): Promise<Float32Array> {
  const samples = await invoke<number[]>("poll_system_audio_pcm");
  return Float32Array.from(samples);
}

export interface MixedNativeRecordingOutput extends NativeRecordingOutput {
  microphoneBlob: Blob;
}

export class NativeSystemAudioRecorder {
  readonly kind = "native";
  readonly mimeType = "audio/x-caf";
  readonly audioStream = null;

  async start(): Promise<boolean> {
    await invoke<void>("start_system_audio_recording");
    return false;
  }

  pause(): void {
    invoke<void>("pause_system_audio_recording").catch(console.error);
  }

  resume(): void {
    invoke<void>("resume_system_audio_recording").catch(console.error);
  }

  stop(): Promise<NativeRecordingOutput> {
    return invoke<NativeRecordingOutput>("stop_system_audio_recording");
  }

  dispose(): void {
    invoke<void>("cancel_system_audio_recording").catch(console.error);
  }
}

export class SystemAudioAndMicrophoneRecorder {
  readonly kind = "mixed";
  private readonly systemAudio = new NativeSystemAudioRecorder();
  private readonly microphone = new Recorder();

  get mimeType(): string {
    return this.microphone.mimeType;
  }

  get audioStream(): MediaStream | null {
    return this.microphone.audioStream;
  }

  async start(deviceId?: string): Promise<boolean> {
    await this.systemAudio.start();
    try {
      return await this.microphone.start(deviceId);
    } catch (error) {
      this.systemAudio.dispose();
      throw error;
    }
  }

  pause(): void {
    this.systemAudio.pause();
    this.microphone.pause();
  }

  resume(): void {
    this.systemAudio.resume();
    this.microphone.resume();
  }

  async stop(): Promise<MixedNativeRecordingOutput> {
    const microphoneBlob = await this.microphone.stop();
    const systemAudio = await this.systemAudio.stop();
    return { ...systemAudio, microphoneBlob };
  }

  dispose(): void {
    this.systemAudio.dispose();
    this.microphone.dispose();
  }
}
