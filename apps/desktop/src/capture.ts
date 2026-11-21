import pcmUrl from './pcm-worklet.js?url';
import type { PronoiaApi, Start } from './shared';

export async function captureAudio(
  api: Pick<PronoiaApi, 'audio' | 'pcm' | 'mediaToken'>,
  input: Start,
  sessionId: string,
  platform: string,
  onError: (message: string) => void,
  signal: AbortSignal,
): Promise<() => void> {
  const streams: { source: 'You' | 'Meeting'; stream: MediaStream }[] = [];
  const recorders: MediaRecorder[] = [];
  const contexts: AudioContext[] = [];
  const closingContexts = new Set<AudioContext>();
  const videoGrants: MediaStreamTrack[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = true;
  const stop = () => {
    running = false;
    signal.removeEventListener('abort', stop);
    for (const timer of timers) clearTimeout(timer);
    for (const recorder of recorders)
      if (recorder.state !== 'inactive') recorder.stop();
    for (const entry of streams)
      for (const track of entry.stream.getTracks()) track.stop();
    for (const track of videoGrants) track.stop();
    for (const context of contexts) {
      if (closingContexts.has(context)) continue;
      closingContexts.add(context);
      void context
        .close()
        .catch((error: unknown) =>
          onError(
            error instanceof Error
              ? error.message
              : 'Audio context could not close.',
          ),
        );
    }
  };
  const fail = (message: string) => {
    if (!running) return;
    stop();
    onError(message);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    if (!input.microphone && !input.systemAudio) return stop;
    const token = await api.mediaToken(sessionId);
    if (!token.ok) throw new Error(token.error.message);
    const capture = token.value;
    signal.throwIfAborted();
    if (input.microphone)
      streams.push({
        source: 'You',
        stream: await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        }),
      });
    signal.throwIfAborted();
    if (input.systemAudio && platform !== 'linux') {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // Keep the display grant alive, but never feed video tracks to MediaRecorder.
      videoGrants.push(...display.getVideoTracks());
      if (!display.getAudioTracks().length)
        throw new Error('The selected source did not provide system audio.');
      streams.push({
        source: 'Meeting',
        stream: new MediaStream(display.getAudioTracks()),
      });
    }
    signal.throwIfAborted();
    for (const track of videoGrants)
      track.addEventListener(
        'ended',
        () => fail('System sharing ended; capture stopped.'),
        { once: true },
      );
    for (const entry of streams) {
      for (const track of entry.stream.getTracks()) {
        track.addEventListener(
          'ended',
          () => fail(`${entry.source} audio ended; capture stopped.`),
          { once: true },
        );
      }
      if (input.provider === 'realtime') {
        const context = new AudioContext({ sampleRate: 24000 });
        contexts.push(context);
        if (context.sampleRate !== 24000)
          throw new Error(
            'Realtime PCM requires an actual 24 kHz sampling rate; choose batch transcription on this device.',
          );
        await context.audioWorklet.addModule(pcmUrl);
        signal.throwIfAborted();
        await context.resume();
        signal.throwIfAborted();
        const processor = new AudioWorkletNode(context, 'pronoia-pcm');
        processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (!running) return;
          void api
            .pcm({
              session: sessionId,
              capture,
              source: entry.source,
              bytes: event.data,
            })
            .then((reply) => {
              if (!reply.ok) {
                fail(reply.error.message);
              }
            })
            .catch((error: unknown) => {
              fail(
                error instanceof Error
                  ? error.message
                  : 'PCM transport failed.',
              );
            });
        };
        context.createMediaStreamSource(entry.stream).connect(processor);
        const mute = context.createGain();
        mute.gain.value = 0;
        processor.connect(mute).connect(context.destination);
      } else {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const recorder = new MediaRecorder(entry.stream, { mimeType });
        recorders.push(recorder);
        let chunks: Blob[] = [];
        let clipStartedAt = new Date().toISOString();
        recorder.onerror = (event) =>
          fail(
            'error' in event && event.error instanceof Error
              ? event.error.message
              : 'Audio recording failed; capture stopped.',
          );
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = () => {
          const clip = new Blob(chunks, { type: mimeType });
          const startedAt = clipStartedAt;
          chunks = [];
          if (!running) return;
          if (clip.size)
            void clip
              .arrayBuffer()
              .then((bytes) =>
                running
                  ? api.audio({
                      session: sessionId,
                      capture,
                      source: entry.source,
                      bytes,
                      startedAt,
                    })
                  : undefined,
              )
              .then((reply) => {
                if (reply && !reply.ok) {
                  fail(reply.error.message);
                }
              })
              .catch((error: unknown) => {
                fail(
                  error instanceof Error
                    ? error.message
                    : 'Transcription upload failed.',
                );
              });
          if (running) {
            clipStartedAt = new Date().toISOString();
            recorder.start();
            timers.push(
              setTimeout(() => {
                if (running && recorder.state !== 'inactive') recorder.stop();
              }, 15000),
            );
          }
        };
        recorder.start();
        timers.push(
          setTimeout(() => {
            if (running && recorder.state !== 'inactive') recorder.stop();
          }, 15000),
        );
      }
    }
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
