import { readFileSync } from 'node:fs';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import OpenAI from 'openai';
import { beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../config.js';
import { stateSchema } from '../workflow/schemas.js';
import { analystSchema, roleSchemas } from './roles.js';
import {
  createFoundryClient,
  foundryConfig,
  FoundryService,
} from './foundry.js';

function sample(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../samples/ai/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}
const config = configSchema.parse({});
const context = {
  config,
  issues: [{ number: 1, state: stateSchema.parse({}) }],
  references: ['https://docs.github.com/en/code-security'],
  at: '2026-11-20T12:00:00Z',
};
const environment = {
  AZURE_AUTH_MODE: 'key',
  AZURE_FOUNDRY_ENDPOINT: 'https://pronoia-demo.openai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'test-only-noncredential',
  FOUNDRY_CHAT_DEPLOYMENT: 'configured-chat',
  FOUNDRY_TRANSCRIBE_DEPLOYMENT: 'configured-transcribe',
  FOUNDRY_REALTIME_TRANSCRIBE_DEPLOYMENT: 'configured-realtime',
};

it('uses a statically supplied SDK constructor without changing the shared client configuration', () => {
  const configured = foundryConfig(environment);
  if (!configured.ok) throw new Error('Invalid synthetic configuration');
  class BundledClient extends OpenAI {}
  const client = createFoundryClient(configured.value, {
    clientClass: BundledClient,
  });
  expect(client).toBeInstanceOf(BundledClient);
  expect(client.baseURL).toBe(
    'https://pronoia-demo.openai.azure.com/openai/v1/',
  );
  expect(client.timeout).toBe(15000);
});

function service(outputs: unknown[], override?: typeof fetch) {
  const requests: { url: string; body: unknown; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'data:,') return new Response('');
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const value = outputs.shift();
    const data = String(input).includes('/audio/transcriptions')
      ? value
      : {
          id: 'resp_synthetic',
          object: 'response',
          status: 'completed',
          created_at: 1,
          output: [
            {
              type: 'message',
              id: 'msg_synthetic',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text:
                    typeof value === 'string' ? value : JSON.stringify(value),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        };
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const parsed = foundryConfig(environment);
  if (!parsed.ok) throw new Error('Bad fixture configuration');
  const client = createFoundryClient(parsed.value, {
    fetch: override ?? fetcher,
  });
  return {
    service: new FoundryService(client, parsed.value),
    client,
    requests,
  };
}

it('routes batch audio to the documented deployment API while preserving secure key headers', async () => {
  const fixture = service([{ text: 'Synthetic Contoso audio.' }]);
  const bytes = new Uint8Array(16);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  const result = await fixture.service.transcribe(bytes, 'en');
  expect(result.ok).toBe(true);
  expect(fixture.requests[0]?.url).toBe(
    'https://pronoia-demo.openai.azure.com/openai/deployments/configured-transcribe/audio/transcriptions?api-version=2024-10-21',
  );
  expect(fixture.requests[0]?.headers.get('api-key')).toBe(
    'test-only-noncredential',
  );
  expect(fixture.requests[0]?.headers.has('authorization')).toBe(false);
});

beforeAll(() => {
  service([]);
}, 30000);

it('uses a Foundry-compatible wire schema while keeping URL validation locally', async () => {
  const fixture = service([
    {
      answer: 'Synthetic MFA verification is pending.',
      references: [],
      confidence: 0.5,
    },
  ]);
  const result = await fixture.service.call(
    'Coach',
    { text: 'Synthetic Contoso check.' },
    context,
  );
  expect(result.ok).toBe(true);
  expect(JSON.stringify(fixture.requests)).not.toContain('"format":"uri"');
  expect(
    roleSchemas.Coach.safeParse({
      answer: 'Invalid reference',
      references: ['not-a-url'],
      confidence: 0.5,
    }).success,
  ).toBe(false);
});

it.each([
  'http://pronoia-demo.openai.azure.com',
  'https://pronoia-demo.openai.azure.com.attacker.invalid',
  'https://user:password@pronoia-demo.openai.azure.com',
  'https://pronoia-demo.openai.azure.com:444',
  'https://pronoia-demo.openai.azure.com/openai/v1',
  'https://pronoia-demo.services.ai.azure.com/api/projects/../bad',
  'https://pronoia-demo.openai.azure.com?api-version=ignored',
  'https://127.0.0.1',
])(
  'rejects unsafe Azure endpoints without leaking credentials: %s',
  (endpoint) => {
    const result = foundryConfig({
      ...environment,
      AZURE_FOUNDRY_ENDPOINT: endpoint,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('user:password');
  },
);

it('accepts documented resource/project endpoints, deployment environment names and identity-first auth', () => {
  const result = foundryConfig({
    ...environment,
    AZURE_FOUNDRY_ENDPOINT:
      'https://pronoia-demo.services.ai.azure.com/api/projects/demo/',
    AZURE_AUTH_MODE: 'identity',
    AZURE_FOUNDRY_API_KEY: '',
  });
  expect(result).toMatchObject({
    ok: true,
    value: { deployment: 'configured-chat', auth: { mode: 'identity' } },
  });
  if (!result.ok) throw new Error('Expected identity config');
  const client = createFoundryClient(result.value, {
    tokenProvider: async () => 'test-only-bearer',
  });
  expect(client.baseURL).toBe(
    'https://pronoia-demo.services.ai.azure.com/api/projects/demo/openai/v1/',
  );
  expect(client.maxRetries).toBe(1);
  expect(client.timeout).toBe(15000);
  expect(foundryConfig({})).toMatchObject({
    ok: false,
    error: { code: 'config' },
  });
  expect(foundryConfig({ ...environment, AZURE_AUTH_MODE: '' })).toMatchObject({
    ok: true,
    value: { auth: { mode: 'identity' } },
  });
});

it.each([
  'Intake',
  'Triage',
  'Listener',
  'Analyst',
  'Coach',
  'Verifier',
  'Scribe',
] as const)(
  'validates the %s role fixture through the common structured-call mechanism',
  async (role) => {
    const f = service([sample(role.toLowerCase())]);
    const result = await f.service.call(
      role,
      { text: 'Synthetic data only.' },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(roleSchemas[role].safeParse(result.value).success).toBe(true);
    expect(result.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      calls: 1,
    });
    expect(f.requests[0]?.url).toBe(
      'https://pronoia-demo.openai.azure.com/openai/v1/responses',
    );
    expect(f.requests[0]?.body).toMatchObject({
      model: 'configured-chat',
      store: false,
      max_output_tokens: 1600,
      text: { format: { type: 'json_schema', strict: true } },
    });
  },
);

it('repairs invalid JSON/schema once, then returns a typed safe error and total usage', async () => {
  const f = service([
    'not-json',
    { ...(sample('analyst') as object), confidence: 2 },
  ]);
  const result = await f.service.call(
    'Analyst',
    { text: 'Synthetic input.' },
    context,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'invalid-output' },
    usage: { input_tokens: 40, output_tokens: 20, calls: 2 },
  });
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1]?.body)).toContain('Repair');
  expect(JSON.stringify(result)).not.toContain('not-json');
});

it('accepts one structured repair, not a bespoke role fallback', async () => {
  const f = service(['not-json', sample('analyst')]);
  const result = await f.service.call(
    'Analyst',
    { text: 'Synthetic input.' },
    context,
  );
  expect(result.ok).toBe(true);
  expect(result.usage?.calls).toBe(2);
});

it('rejects /approve, excess confidence and unknown issues', async () => {
  const analyst = sample('analyst') as Record<string, unknown>;
  expect(
    analystSchema.safeParse({ ...analyst, proposed_command: '/approve' })
      .success,
  ).toBe(false);
  expect(
    analystSchema.safeParse({ ...analyst, confidence: 1.001 }).success,
  ).toBe(false);
  const f = service([
    { ...analyst, issue: 999 },
    { ...analyst, issue: 999 },
  ]);
  expect(
    await f.service.call('Analyst', { text: 'Synthetic input.' }, context),
  ).toMatchObject({ ok: false, error: { code: 'invalid-output' } });
});

it('changes illegal semantic proposals to none with a warning via the core state machine', async () => {
  const analyst = sample('analyst') as Record<string, unknown>;
  const f = service([
    { ...analyst, proposed_command: '/validate', result: 'fail' },
  ]);
  expect(
    await f.service.call(
      'Analyst',
      { text: 'Synthetic failing check.' },
      context,
    ),
  ).toMatchObject({
    ok: true,
    value: { proposed_command: 'none' },
    warnings: [expect.stringMatching(/illegal|semantic/i)],
  });
  const done = service([{ ...analyst, proposed_command: '/start' }]);
  expect(
    await done.service.call(
      'Analyst',
      { text: 'Synthetic input.' },
      {
        ...context,
        issues: [{ number: 1, state: stateSchema.parse({ status: 'done' }) }],
      },
    ),
  ).toMatchObject({ ok: true, value: { proposed_command: 'none' } });
});

it('allows a reviewable human /confirm proposal without granting an agent command authority', async () => {
  const f = service([
    { ...(sample('analyst') as object), proposed_command: '/confirm' },
  ]);
  expect(
    await f.service.call(
      'Analyst',
      { text: 'Synthetic triage observation.' },
      context,
    ),
  ).toMatchObject({
    ok: true,
    value: { proposed_command: '/confirm' },
  });
});

it('treats prompt-injection fixtures and verbal approvals as data, never command authority', async () => {
  const injection = sample('prompt-injection') as {
    text: string;
    output: unknown;
  };
  const f = service([injection.output, injection.output]);
  const result = await f.service.call(
    'Analyst',
    { text: injection.text },
    context,
  );
  expect(result.ok).toBe(false);
  const instructions = JSON.stringify(f.requests[0]?.body);
  expect(instructions).toContain('untrusted_data');
  expect(instructions).toContain('never instructions');
  const verbal = service([
    {
      ...(sample('analyst') as object),
      verbal_decision: {
        type: 'approve',
        speaker: 'Fictional reviewer',
        quote: 'Looks good',
        at: '00:02',
      },
    },
  ]);
  expect(
    await verbal.service.call(
      'Analyst',
      { text: 'Synthetic meeting.' },
      context,
    ),
  ).toMatchObject({
    ok: true,
    value: { verbal_decision: { type: 'approve' } },
  });
});

it('bounds image data URLs, accepts reviewed data only and never fetches an arbitrary image URL', async () => {
  const f = service([sample('analyst')]);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  expect(
    await f.service.call(
      'Analyst',
      { text: 'Synthetic image.', image_data_url: image, image_reviewed: true },
      context,
    ),
  ).toMatchObject({ ok: true });
  expect(JSON.stringify(f.requests[0]?.body)).toContain('input_image');
  expect(
    await f.service.call(
      'Analyst',
      {
        text: '',
        image_data_url: 'https://attacker.invalid/image',
        image_reviewed: true,
      },
      context,
    ),
  ).toMatchObject({ ok: false, error: { code: 'input' } });
  expect(
    await f.service.call(
      'Analyst',
      { text: '', image_data_url: image },
      context,
    ),
  ).toMatchObject({ ok: false, error: { code: 'input' } });
});

it('filters unsupported Coach references and requires Scribe recap human review', async () => {
  const coach = service([
    {
      ...(sample('coach') as object),
      references: ['https://attacker.invalid/invented'],
    },
  ]);
  expect(
    await coach.service.call('Coach', { text: 'Synthetic question.' }, context),
  ).toMatchObject({
    ok: true,
    value: { references: [] },
    warnings: [expect.stringMatching(/reference/i)],
  });
  const scribe = service([
    { ...(sample('scribe') as object), requires_human_review: false },
    { ...(sample('scribe') as object), requires_human_review: false },
  ]);
  expect(
    await scribe.service.call('Scribe', { text: 'Synthetic recap.' }, context),
  ).toMatchObject({ ok: false, error: { code: 'invalid-output' } });
});

it('uploads the complete finalized WebM as chunk.webm with Zod-validated transcription', async () => {
  const f = service([
    {
      text: 'Synthetic transcript.',
      usage: {
        type: 'tokens',
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
      },
    },
  ]);
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(28)]);
  expect(await f.service.transcribe(bytes, 'en')).toMatchObject({
    ok: true,
    value: { text: 'Synthetic transcript.' },
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  expect(f.requests[0]?.url).toContain('/audio/transcriptions');
  const form = f.requests[0]?.body;
  const file = form instanceof FormData ? form.get('file') : null;
  if (!(file instanceof File)) throw new Error('Expected complete WebM upload');
  expect(file.name).toBe('chunk.webm');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  expect(form instanceof FormData ? form.get('prompt') : '').toMatch(
    /CVE.*CVSS.*EPSS.*SARIF/s,
  );
  expect(await f.service.transcribe(new Uint8Array([1, 2, 3]))).toMatchObject({
    ok: false,
    error: { code: 'input' },
  });
  expect(await f.service.transcribe(bytes, 'invalid-language')).toMatchObject({
    ok: false,
    error: { code: 'input' },
  });
});

it('retains the complete bounded batch transcript rather than silently truncating it', async () => {
  const text = 'Synthetic transcript. '.repeat(600);
  const f = service([{ text }]);
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(28)]);
  const result = await f.service.transcribe(bytes);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.text).toHaveLength(text.length);
    expect(result.value.text).toBe(text);
  }
});

it('returns safe transport errors without prompts, outputs or keys', async () => {
  const parsed = foundryConfig(environment);
  if (!parsed.ok) throw new Error('Bad fixture');
  const client = createFoundryClient(parsed.value, {
    fetch: async () => {
      throw new Error('private upstream message');
    },
  });
  const result = await new FoundryService(client, parsed.value).call(
    'Analyst',
    { text: 'private untrusted input' },
    context,
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(JSON.stringify(result)).not.toMatch(/private|noncredential/);
});

it('exports bounded main-only realtime connection settings without provisioning', async () => {
  const f = service([]);
  const create = vi
    .spyOn(OpenAIRealtimeWS, 'create')
    .mockRejectedValueOnce(new Error('private websocket error'));
  const result = await f.service.openRealtime();
  expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(create).toHaveBeenCalledWith(
    f.client,
    expect.objectContaining({
      intent: 'transcription',
      options: expect.objectContaining({
        maxPayload: 1048576,
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      }),
    }),
  );
  create.mockRestore();
});

async function within<T>(promise: Promise<T>): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), 250);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

it('honors already-aborted caller signals without sending role/audio/realtime data', async () => {
  const controller = new AbortController();
  controller.abort('private context');
  const f = service([sample('analyst'), { text: 'Synthetic audio.' }]);
  expect(
    await f.service.call(
      'Analyst',
      { text: 'Synthetic.' },
      context,
      controller.signal,
    ),
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(28)]);
  expect(
    await f.service.transcribe(bytes, 'en', controller.signal),
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  const create = vi
    .spyOn(OpenAIRealtimeWS, 'create')
    .mockRejectedValue(new Error('must not connect'));
  try {
    expect(
      await f.service.openRealtime(undefined, controller.signal),
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
  }
  expect(f.requests).toHaveLength(0);
});

it('cancels pending SDK requests immediately and never performs a structured repair after Stop', async () => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: (value: Response) => void = () => {};
  let requestSignal: AbortSignal | null | undefined;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    requestSignal = init?.signal;
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const f = service([], fetcher);
  const pending = f.service.call(
    'Analyst',
    { text: 'Synthetic.' },
    context,
    controller.signal,
  );
  try {
    await ready;
    controller.abort('private context');
    expect(await within(pending)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify(sample('analyst')),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await pending;
  }
});

it('bounds pending credential resolution with the operation deadline and caller cancellation', async () => {
  const loaded = foundryConfig({
    ...environment,
    AZURE_FOUNDRY_API_KEY: '',
    AZURE_AUTH_MODE: 'identity',
  });
  if (!loaded.ok) throw new Error('Missing fixture config');
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: (value: string) => void = () => {};
  const token = new Promise<string>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
  );
  const client = createFoundryClient(loaded.value, {
    fetch: fetcher,
    tokenProvider: async () => {
      started();
      return token;
    },
  });
  const controller = new AbortController();
  const pending = new FoundryService(client, loaded.value).call(
    'Analyst',
    { text: 'Synthetic.' },
    context,
    controller.signal,
  );
  try {
    await ready;
    controller.abort();
    expect(await within(pending)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    release('test-only-bearer');
    await pending;
  }
});

it('cancels a pending realtime credential/connection factory without exposing its error', async () => {
  const f = service([]);
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  let reject: (error: Error) => void = () => {};
  const create = vi
    .spyOn(OpenAIRealtimeWS, 'create')
    .mockImplementation(async () => {
      started();
      return new Promise<OpenAIRealtimeWS>((_resolve, fail) => {
        reject = fail;
      });
    });
  const controller = new AbortController();
  const pending = f.service.openRealtime(undefined, controller.signal);
  try {
    await ready;
    controller.abort('private context');
    const result = await within(pending);
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(JSON.stringify(result)).not.toContain('private context');
  } finally {
    reject(new Error('private upstream error'));
    await pending;
    create.mockRestore();
  }
});

it('enforces the 45-second role deadline even when credential resolution never settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const loaded = foundryConfig({
    ...environment,
    AZURE_FOUNDRY_API_KEY: '',
    AZURE_AUTH_MODE: 'identity',
  });
  if (!loaded.ok) throw new Error('Missing fixture');
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: (value: string) => void = () => {};
  const token = new Promise<string>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  const client = createFoundryClient(loaded.value, {
    fetch: fetcher,
    tokenProvider: async () => {
      started();
      return token;
    },
  });
  const pending = new FoundryService(client, loaded.value).call(
    'Analyst',
    { text: 'Synthetic.' },
    context,
  );
  try {
    await ready;
    await vi.advanceTimersByTimeAsync(45000);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    release('test-only-bearer');
    await pending;
    vi.useRealTimers();
  }
});

it('enforces the 15-second realtime factory deadline without waiting for credentials', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = service([]);
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reject: (error: Error) => void = () => {};
  const create = vi
    .spyOn(OpenAIRealtimeWS, 'create')
    .mockImplementation(async () => {
      started();
      return new Promise<OpenAIRealtimeWS>((_resolve, fail) => {
        reject = fail;
      });
    });
  const pending = f.service.openRealtime();
  try {
    await ready;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  } finally {
    reject(new Error('private upstream error'));
    await pending;
    create.mockRestore();
    vi.useRealTimers();
  }
});

it('redacts every outbound issue-context string while retaining typed governance and original proposal legality', async () => {
  const sentinel = ['never', 'publish', 'opaque'].join('-');
  const state = stateSchema.parse({
    status: 'blocked',
    previous_status: 'todo',
    severity: 'high',
    blocked_reason: `password=${sentinel} C:\\synthetic-private\\notes.txt`,
    dispute_reason: `secret=${sentinel}`,
    last_reject_reason: `token=${sentinel}`,
    validation_requested_by: `api_key=${sentinel}`,
    validation_requested_at: '2026-11-20T12:00:00Z',
    assignees: ['worker'],
    pr_authors: ['fixer'],
    evidence_required: true,
    risk_until: '2026-12-20',
  });
  const f = service([sample('analyst')]);
  const result = await f.service.call(
    'Analyst',
    { text: 'Synthetic context.' },
    {
      ...context,
      issues: [{ number: 1, state }],
      references: [
        ...context.references,
        `https://docs.github.com/en/code-security?token=${sentinel}`,
      ],
    },
  );
  expect(result).toMatchObject({
    ok: true,
    value: { proposed_command: '/start' },
  });
  expect(JSON.stringify(f.requests)).not.toContain(sentinel);
  expect(JSON.stringify(f.requests)).not.toContain('synthetic-private');
  const request = z
    .object({
      input: z.array(
        z.object({
          content: z.array(z.object({ type: z.string(), text: z.string() })),
        }),
      ),
    })
    .parse(f.requests[0]?.body);
  const outbound = z
    .object({
      issue_context: z.array(
        z.object({ number: z.number(), state: stateSchema }),
      ),
    })
    .parse(JSON.parse(request.input[0]?.content[0]?.text ?? '{}'));
  expect(outbound.issue_context[0]?.state).toMatchObject({
    status: 'blocked',
    previous_status: 'todo',
    severity: 'high',
    evidence_required: true,
    assignees: ['worker'],
    pr_authors: ['fixer'],
    risk_until: '2026-12-20',
  });
});
