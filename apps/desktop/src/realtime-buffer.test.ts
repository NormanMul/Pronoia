import { expect, it } from 'vitest';
import { PcmBuffer } from './realtime-buffer';

it('retains ordered PCM until the connection is ready and preserves failed sends for retry', () => {
  const buffer = new PcmBuffer();
  buffer.append(new Uint8Array([1, 0]));
  buffer.append(new Uint8Array([2, 0]));
  const sent: number[] = [];
  expect(() =>
    buffer.flush((bytes) => {
      if (bytes[0] === 2) throw new Error('Disconnected');
      sent.push(bytes[0] ?? 0);
    }),
  ).toThrow('Disconnected');
  buffer.flush((bytes) => sent.push(bytes[0] ?? 0));
  expect(sent).toEqual([1, 2]);
  buffer.flush(() => {
    throw new Error('Already drained');
  });
});

it('enforces the exact two-MiB pending-audio limit and rejects partial PCM16 samples', () => {
  const buffer = new PcmBuffer();
  expect(() => buffer.append(new Uint8Array(1))).toThrow(/PCM16/);
  buffer.append(new Uint8Array(2 * 1024 * 1024));
  expect(() => buffer.append(new Uint8Array(2))).toThrow(/buffer/i);
  buffer.flush(() => undefined);
  expect(() => buffer.append(new Uint8Array(2))).not.toThrow();
});
