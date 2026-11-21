import { DesktopError } from './safety';

export class PcmBuffer {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  append(bytes: Uint8Array): void {
    if (!bytes.length || bytes.length % 2) {
      throw new DesktopError(
        'PCM_FORMAT',
        'PCM16 audio requires complete two-byte samples.',
      );
    }
    if (this.bytes + bytes.length > 2 * 1024 * 1024) {
      throw new DesktopError(
        'REALTIME_BACKPRESSURE',
        'The pending realtime audio buffer is full; pause or switch to batch.',
      );
    }
    this.chunks.push(bytes.slice());
    this.bytes += bytes.length;
  }

  flush(send: (bytes: Uint8Array) => void): boolean {
    let sent = false;
    while (this.chunks.length) {
      const chunk = this.chunks[0];
      if (!chunk)
        throw new DesktopError(
          'PCM_BUFFER',
          'The pending audio buffer is inconsistent.',
        );
      send(chunk);
      this.chunks.shift();
      this.bytes -= chunk.length;
      sent = true;
    }
    return sent;
  }
}
