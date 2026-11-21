/* global AudioWorkletProcessor, registerProcessor */
class PronoiaPcm extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      const pcm = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i += 1) {
        const value = Math.max(-1, Math.min(1, channel[i]));
        pcm[i] = Math.round(value < 0 ? value * 32768 : value * 32767);
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pronoia-pcm', PronoiaPcm);
