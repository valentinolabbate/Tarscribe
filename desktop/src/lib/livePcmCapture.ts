/**
 * Captures mono PCM16 audio from a MediaStream via AudioWorklet at 16 kHz.
 * Uses an inline blob for the worklet module to work in Tauri's webview.
 */

const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._chunkSamples = (options.processorOptions && options.processorOptions.chunkSamples) || 32000;
    this._buf = [];
    this._active = true;
    // System-audio samples fed from the main thread (already at this context's
    // sample rate). Kept as a queue of segments with a read offset; the
    // microphone input drives the clock and these are summed in 1:1.
    this._sysSegments = [];
    this._sysOffset = 0;
    this._sysLength = 0;
    this._maxSysQueue = sampleRate; // cap the queue at ~1 s to bound latency
    this.port.onmessage = (e) => {
      const data = e.data;
      if (data === 'pause') {
        this._active = false;
        this._clearSystem();
      } else if (data === 'resume') {
        this._active = true;
      } else if (data && data.type === 'system') {
        this._pushSystem(data.samples);
      }
    };
  }

  _clearSystem() {
    this._sysSegments = [];
    this._sysOffset = 0;
    this._sysLength = 0;
  }

  _pushSystem(samples) {
    if (!samples || samples.length === 0) return;
    this._sysSegments.push(samples);
    this._sysLength += samples.length;
    // Drop the oldest samples if the consumer (microphone clock) falls behind.
    while (this._sysLength > this._maxSysQueue && this._sysSegments.length > 0) {
      const head = this._sysSegments[0];
      const available = head.length - this._sysOffset;
      const overflow = this._sysLength - this._maxSysQueue;
      if (overflow >= available) {
        this._sysSegments.shift();
        this._sysOffset = 0;
        this._sysLength -= available;
      } else {
        this._sysOffset += overflow;
        this._sysLength -= overflow;
      }
    }
  }

  _nextSystem() {
    if (this._sysLength === 0) return 0;
    const head = this._sysSegments[0];
    const value = head[this._sysOffset++];
    this._sysLength--;
    if (this._sysOffset >= head.length) {
      this._sysSegments.shift();
      this._sysOffset = 0;
    }
    return value;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (!this._active) return true;

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i] + this._nextSystem();
      this._buf.push(Math.max(-1, Math.min(1, s)));
    }

    while (this._buf.length >= this._chunkSamples) {
      const slice = this._buf.splice(0, this._chunkSamples);
      const pcm = new Int16Array(this._chunkSamples);
      for (let i = 0; i < slice.length; i++) {
        pcm[i] = Math.round(slice[i] * 32767);
      }
      this.port.postMessage({ type: 'chunk', buffer: pcm.buffer }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

export interface SystemAudioSource {
  /** Drain system-audio samples buffered since the last poll (mono float). */
  poll: () => Promise<Float32Array>;
  /** Sample rate of the polled samples. */
  sampleRate: () => Promise<number>;
  /** How often to poll the native buffer (default 200 ms). */
  pollIntervalMs?: number;
}

export interface PcmCaptureOptions {
  stream: MediaStream;
  sampleRate?: number;
  chunkDurationSec?: number;
  onChunk: (chunk: ArrayBuffer, sequenceNumber: number) => void;
  /**
   * Optional second source (e.g. native system audio) mixed into the same PCM
   * stream as ``stream``. The microphone drives the clock; system samples are
   * summed in as they arrive so the live preview reflects every source.
   */
  systemAudio?: SystemAudioSource;
}

export interface SystemAudioCaptureOptions {
  sampleRate?: number;
  chunkDurationSec?: number;
  onChunk: (chunk: ArrayBuffer, sequenceNumber: number) => void;
  systemAudio: SystemAudioSource;
}

export class LivePcmCapture {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sinkNode: MediaStreamAudioDestinationNode | null = null;
  private sequenceNumber = 0;
  private started = false;
  private targetSampleRate = 16000;
  private systemTimer: ReturnType<typeof setInterval> | null = null;
  private systemPolling = false;
  private systemPaused = false;
  private systemNativeRate = 0;
  private systemRemainder = new Float32Array(0);

  async start(opts: PcmCaptureOptions): Promise<void> {
    const sampleRate = opts.sampleRate ?? 16000;
    const chunkDurationSec = opts.chunkDurationSec ?? 2;
    const chunkSamples = Math.round(sampleRate * chunkDurationSec);
    this.targetSampleRate = sampleRate;

    this.audioCtx = new AudioContext({ sampleRate });

    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.audioCtx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-capture", {
      processorOptions: { chunkSamples },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.workletNode.port.onmessage = (e) => {
      if (e.data?.type === "chunk") {
        opts.onChunk(e.data.buffer as ArrayBuffer, this.sequenceNumber++);
      }
    };

    this.source = this.audioCtx.createMediaStreamSource(opts.stream);
    this.source.connect(this.workletNode);
    // Pull the graph through an in-memory sink. Connecting a silent node to
    // audioCtx.destination still opens the hardware output device on macOS.
    this.sinkNode = this.audioCtx.createMediaStreamDestination();
    this.workletNode.connect(this.sinkNode);

    this.started = true;

    if (opts.systemAudio) {
      this.startSystemAudio(opts.systemAudio);
    }
  }

  private startSystemAudio(source: SystemAudioSource): void {
    const intervalMs = source.pollIntervalMs ?? 200;
    this.systemTimer = setInterval(() => {
      if (this.systemPaused || this.systemPolling || !this.workletNode) return;
      this.systemPolling = true;
      void (async () => {
        try {
          if (!(this.systemNativeRate > 0)) {
            this.systemNativeRate = await source.sampleRate();
            if (!(this.systemNativeRate > 0)) return;
          }
          const samples = await source.poll();
          if (samples.length === 0 || !this.workletNode) return;
          const resampled = this.resampleSystem(samples);
          if (resampled.length === 0) return;
          this.workletNode.port.postMessage(
            { type: "system", samples: resampled },
            [resampled.buffer],
          );
        } catch (e) {
          console.warn("[live] system-audio poll failed:", e);
        } finally {
          this.systemPolling = false;
        }
      })();
    }, intervalMs);
  }

  /**
   * Resample native system-audio samples to the capture rate via linear
   * interpolation, carrying the unconsumed tail across polls so no audio is
   * dropped at chunk boundaries.
   */
  private resampleSystem(samples: Float32Array): Float32Array {
    let input = samples;
    if (this.systemRemainder.length > 0) {
      input = new Float32Array(this.systemRemainder.length + samples.length);
      input.set(this.systemRemainder, 0);
      input.set(samples, this.systemRemainder.length);
    }

    const ratio = this.systemNativeRate / this.targetSampleRate;
    if (ratio <= 0) return new Float32Array(0);
    if (ratio === 1) {
      this.systemRemainder = new Float32Array(0);
      return input;
    }

    const outLength = Math.floor((input.length - 1) / ratio);
    if (outLength <= 0) {
      this.systemRemainder = input;
      return new Float32Array(0);
    }
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      out[i] = input[idx] + (input[idx + 1] - input[idx]) * frac;
    }
    const consumed = Math.floor(outLength * ratio);
    this.systemRemainder = input.slice(consumed);
    return out;
  }

  pause(): void {
    this.systemPaused = true;
    this.systemRemainder = new Float32Array(0);
    this.workletNode?.port.postMessage("pause");
  }

  resume(): void {
    this.systemPaused = false;
    this.workletNode?.port.postMessage("resume");
  }

  stop(): void {
    if (this.systemTimer !== null) {
      clearInterval(this.systemTimer);
      this.systemTimer = null;
    }
    try {
      this.source?.disconnect();
      this.workletNode?.disconnect();
      this.sinkNode?.disconnect();
      this.audioCtx?.close();
    } catch {
      /* ignore cleanup errors */
    }
    this.audioCtx = null;
    this.workletNode = null;
    this.source = null;
    this.sinkNode = null;
    this.started = false;
    this.sequenceNumber = 0;
    this.systemPaused = false;
    this.systemPolling = false;
    this.systemNativeRate = 0;
    this.systemRemainder = new Float32Array(0);
  }

  get isStarted(): boolean {
    return this.started;
  }
}

/**
 * Captures mono PCM16 from the native system-audio tap without requiring a
 * MediaStream. This covers the "Systemaudio" recording source where no
 * microphone stream exists to drive the AudioWorklet clock.
 */
export class SystemAudioPcmCapture {
  private sequenceNumber = 0;
  private started = false;
  private paused = false;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private targetSampleRate = 16000;
  private nativeSampleRate = 0;
  private chunkSamples = 32000;
  private remainder = new Float32Array(0);
  private pending = new Float32Array(0);
  private options: SystemAudioCaptureOptions | null = null;

  async start(opts: SystemAudioCaptureOptions): Promise<void> {
    if (this.started) return;
    this.options = opts;
    this.targetSampleRate = opts.sampleRate ?? 16000;
    const chunkDurationSec = opts.chunkDurationSec ?? 2;
    this.chunkSamples = Math.round(this.targetSampleRate * chunkDurationSec);
    this.nativeSampleRate = await this.readNativeSampleRate(opts.systemAudio);
    if (!(this.nativeSampleRate > 0)) {
      throw new Error("Systemaudio-Livequelle ist noch nicht bereit.");
    }

    this.started = true;
    const intervalMs = opts.systemAudio.pollIntervalMs ?? 200;
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
    await this.pollOnce();
  }

  private async readNativeSampleRate(source: SystemAudioSource): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rate = await source.sampleRate();
      if (rate > 0) return rate;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return 0;
  }

  private async pollOnce(): Promise<void> {
    if (!this.started || this.paused || this.polling || !this.options) return;
    this.polling = true;
    try {
      const samples = await this.options.systemAudio.poll();
      if (samples.length === 0) return;
      const resampled = this.resample(samples);
      if (resampled.length === 0) return;
      this.emitChunks(resampled);
    } catch (e) {
      console.warn("[live] system-audio capture poll failed:", e);
    } finally {
      this.polling = false;
    }
  }

  private resample(samples: Float32Array): Float32Array {
    let input = samples;
    if (this.remainder.length > 0) {
      input = new Float32Array(this.remainder.length + samples.length);
      input.set(this.remainder, 0);
      input.set(samples, this.remainder.length);
    }

    const ratio = this.nativeSampleRate / this.targetSampleRate;
    if (ratio <= 0) return new Float32Array(0);
    if (Math.abs(ratio - 1) < 0.000001) {
      this.remainder = new Float32Array(0);
      return input;
    }

    const outLength = Math.floor((input.length - 1) / ratio);
    if (outLength <= 0) {
      this.remainder = input;
      return new Float32Array(0);
    }

    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      out[i] = input[idx] + (input[idx + 1] - input[idx]) * frac;
    }
    const consumed = Math.floor(outLength * ratio);
    this.remainder = input.slice(consumed);
    return out;
  }

  private emitChunks(samples: Float32Array): void {
    let input = samples;
    if (this.pending.length > 0) {
      input = new Float32Array(this.pending.length + samples.length);
      input.set(this.pending, 0);
      input.set(samples, this.pending.length);
    }

    let offset = 0;
    while (input.length - offset >= this.chunkSamples) {
      const pcm = new Int16Array(this.chunkSamples);
      for (let i = 0; i < this.chunkSamples; i++) {
        const sample = Math.max(-1, Math.min(1, input[offset + i]));
        pcm[i] = Math.round(sample * 32767);
      }
      this.options?.onChunk(pcm.buffer, this.sequenceNumber++);
      offset += this.chunkSamples;
    }

    this.pending = input.slice(offset);
  }

  pause(): void {
    this.paused = true;
    this.remainder = new Float32Array(0);
    this.pending = new Float32Array(0);
    void this.options?.systemAudio.poll().catch((e) => {
      console.warn("[live] system-audio pause drain failed:", e);
    });
  }

  resume(): void {
    this.paused = false;
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.paused = false;
    this.polling = false;
    this.sequenceNumber = 0;
    this.nativeSampleRate = 0;
    this.remainder = new Float32Array(0);
    this.pending = new Float32Array(0);
    this.options = null;
  }

  get isStarted(): boolean {
    return this.started;
  }
}
