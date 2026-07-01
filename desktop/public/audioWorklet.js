class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._chunkSamples = (options.processorOptions && options.processorOptions.chunkSamples) || 32000;
    this._buf = [];
    this._active = true;
    this._sysSegments = [];
    this._sysOffset = 0;
    this._sysLength = 0;
    this._maxSysQueue = sampleRate;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === "pause") {
        this._active = false;
        this._clearSystem();
      } else if (data === "resume") {
        this._active = true;
      } else if (data && data.type === "system") {
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
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (!this._active) return true;

    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index] + this._nextSystem();
      this._buf.push(Math.max(-1, Math.min(1, sample)));
    }

    while (this._buf.length >= this._chunkSamples) {
      const slice = this._buf.splice(0, this._chunkSamples);
      const pcm = new Int16Array(this._chunkSamples);
      for (let index = 0; index < slice.length; index++) {
        pcm[index] = Math.round(slice[index] * 32767);
      }
      this.port.postMessage({ type: "chunk", buffer: pcm.buffer }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
