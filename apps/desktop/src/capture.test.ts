import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { captureAudio } from './capture';
import type { Start } from './shared';
const mediaToken = async () => ({
  ok: true as const,
  value: '11111111-1111-4111-8111-111111111111',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const input: Start = {
  participantsNotified: true,
  cloudApproved: true,
  synthetic: true,
  sourceId: 'demo',
  assessment: 'Contoso',
  issues: [2],
  microphone: true,
  systemAudio: false,
  provider: 'batch',
  autoWatch: false,
};

function devices() {
  const stopped = vi.fn();
  let ended: (() => void) | undefined;
  const track = {
    stop: stopped,
    addEventListener: (_name: string, callback: () => void) => {
      ended = callback;
    },
  };
  const stream = { getTracks: () => [track] };
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => stream },
  });
  class Recorder {
    static current: Recorder | undefined;
    static isTypeSupported() {
      return true;
    }
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: (event: Event) => void;
    constructor() {
      Recorder.current = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['complete clip']) });
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  return { stopped, end: () => ended?.(), recorder: () => Recorder.current };
}

it('stops all audio immediately when a track ends or the recorder errors', async () => {
  vi.useFakeTimers();
  const fixture = devices();
  const onError = vi.fn();
  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  await captureAudio(
    { audio, pcm: audio, mediaToken },
    input,
    's',
    'win32',
    onError,
    new AbortController().signal,
  );
  fixture.recorder()?.onerror?.(new Event('error'));
  fixture.end();
  expect(fixture.stopped).toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(audio).not.toHaveBeenCalled();
});

it('keeps the system-video grant alive for loopback but records audio tracks only', async () => {
  vi.useFakeTimers();
  devices();
  const video = { stop: vi.fn(), addEventListener: vi.fn() };
  const audioTrack = { stop: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: async () => ({
        getVideoTracks: () => [video],
        getAudioTracks: () => [audioTrack],
        getTracks: () => [video, audioTrack],
      }),
    },
  });
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: (typeof audioTrack)[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );

  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const stop = await captureAudio(
    { audio, pcm: audio, mediaToken },
    { ...input, microphone: false, systemAudio: true },
    's',
    'win32',
    () => undefined,
    new AbortController().signal,
  );
  expect(video.stop).not.toHaveBeenCalled();
  stop();
  expect(video.stop).toHaveBeenCalled();
  expect(audioTrack.stop).toHaveBeenCalled();
});

it('sends one complete rollover clip at 15 seconds with its capture-start timestamp', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  devices();
  const audio = vi.fn(
    async (payload: {
      session: string;
      source: 'You' | 'Meeting';
      bytes: ArrayBuffer;
      startedAt?: string;
    }) => {
      expect(payload.source).toBe('You');
      return { ok: true as const, value: undefined };
    },
  );
  const stop = await captureAudio(
    { audio, pcm: audio, mediaToken },
    input,
    's',
    'win32',
    () => undefined,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(14999);
  expect(audio).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(audio).toHaveBeenCalledTimes(1);
  expect(audio.mock.calls[0]?.[0].startedAt).toBe('2026-11-20T12:00:00.000Z');
  stop();
});

it('refuses realtime PCM when the actual AudioContext rate is not 24 kHz', async () => {
  const fixture = devices();
  const closed = vi.fn(async () => undefined);
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48000;
      audioWorklet = {
        addModule: async () => {
          throw new Error(
            'Should reject the rate before starting the worklet.',
          );
        },
      };
      close = closed;
    },
  );
  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  await expect(
    captureAudio(
      { audio, pcm: audio, mediaToken },
      { ...input, provider: 'realtime' },
      's',
      'win32',
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/24|sampling|sample rate/i);
  expect(fixture.stopped).toHaveBeenCalled();
  expect(closed).toHaveBeenCalled();
});

it('stops capture immediately and never sends an unfinished final audio chunk', async () => {
  vi.useFakeTimers();
  const fixture = devices();
  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const api = { audio, pcm: audio, mediaToken };
  const stop = await captureAudio(
    api,
    input,
    's',
    'win32',
    () => undefined,
    new AbortController().signal,
  );
  stop();
  await vi.advanceTimersByTimeAsync(15000);
  expect(fixture.stopped).toHaveBeenCalledOnce();
  expect(audio).not.toHaveBeenCalled();
});

it('does not send a completed rollover blob after Stop cancels an in-flight conversion', async () => {
  vi.useFakeTimers();
  devices();
  let release: ((bytes: ArrayBuffer) => void) | undefined;
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  );
  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const stop = await captureAudio(
    { audio, pcm: audio, mediaToken },
    input,
    's',
    'win32',
    () => undefined,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(15000);
  stop();
  release?.(new ArrayBuffer(10));
  await Promise.resolve();
  await Promise.resolve();
  expect(audio).not.toHaveBeenCalled();
});

it('stops a microphone acquired after Stop instead of starting a late recorder', async () => {
  vi.useFakeTimers();
  devices();
  const stopped = vi.fn();
  const stream = { getTracks: () => [{ stop: stopped }] };
  let release: ((value: typeof stream) => void) | undefined;
  const media = new Promise<typeof stream>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => media } });
  const controller = new AbortController();
  const audio = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const recording = captureAudio(
    { audio, pcm: audio, mediaToken },
    input,
    's',
    'win32',
    () => undefined,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  release?.(stream);
  const result = await recording.then(
    (stop) => {
      stop();
      return 'capturing';
    },
    (error: unknown) => (error instanceof Error ? error.name : 'unexpected'),
  );
  expect(result).toBe('AbortError');
  expect(stopped).toHaveBeenCalled();
});

it('converts and clips real worklet samples to signed PCM16 without wrapping', () => {
  let processor: { process: (inputs: Float32Array[][]) => boolean } | undefined;
  let output: Int16Array | undefined;
  class BaseProcessor {
    port = {
      postMessage: (bytes: ArrayBuffer) => {
        output = new Int16Array(bytes);
      },
    };
  }
  runInNewContext(
    readFileSync(new URL('./pcm-worklet.js', import.meta.url), 'utf8'),
    {
      AudioWorkletProcessor: BaseProcessor,
      Int16Array,
      registerProcessor: (
        _name: string,
        Constructor: new () => NonNullable<typeof processor>,
      ) => {
        processor = new Constructor();
      },
    },
  );
  expect(
    processor?.process([[new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])]]),
  ).toBe(true);
  expect(output ? [...output] : []).toEqual([
    -32768, -32768, -16384, 0, 16384, 32767, 32767,
  ]);
});
