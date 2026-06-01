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
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this._active = false;
      else if (e.data === 'resume') this._active = true;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (!this._active) return true;

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
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

export interface PcmCaptureOptions {
  stream: MediaStream;
  sampleRate?: number;
  chunkDurationSec?: number;
  onChunk: (chunk: ArrayBuffer, sequenceNumber: number) => void;
}

export class LivePcmCapture {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private sequenceNumber = 0;
  private started = false;

  async start(opts: PcmCaptureOptions): Promise<void> {
    const sampleRate = opts.sampleRate ?? 16000;
    const chunkDurationSec = opts.chunkDurationSec ?? 2;
    const chunkSamples = Math.round(sampleRate * chunkDurationSec);

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

    // Silent sink so the graph stays active without playing to speakers.
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 0;

    this.source = this.audioCtx.createMediaStreamSource(opts.stream);
    this.source.connect(this.workletNode);
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioCtx.destination);

    this.started = true;
  }

  pause(): void {
    this.workletNode?.port.postMessage("pause");
  }

  resume(): void {
    this.workletNode?.port.postMessage("resume");
  }

  stop(): void {
    try {
      this.source?.disconnect();
      this.workletNode?.disconnect();
      this.gainNode?.disconnect();
      this.audioCtx?.close();
    } catch {
      /* ignore cleanup errors */
    }
    this.audioCtx = null;
    this.workletNode = null;
    this.source = null;
    this.gainNode = null;
    this.started = false;
    this.sequenceNumber = 0;
  }

  get isStarted(): boolean {
    return this.started;
  }
}
