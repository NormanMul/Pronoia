import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { z } from 'zod';

export const evidenceSchema = z.object({
  file: z.string().regex(/^evidence\/[1-9]\d*\/\d{8}T\d{6}Z-[a-f0-9]{8}\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  captured_at: z.iso.datetime(),
  captured_by: z.string().min(1),
  source: z.string().max(300),
  session: z.string().max(200).default(''),
  step: z.string().max(200).default(''),
  note: z.string().max(10000).default(''),
});

export class EvidenceError extends Error {}

export function validatePng(buffer: Buffer): void {
  // shortcut: PNGs are capped at 10 MiB; use streamed/blob uploads for larger captures.
  if (buffer.length > 10 * 1024 * 1024) {
    throw new EvidenceError('PNG size exceeds the 10 MiB upload limit.');
  }
  if (
    buffer.length < 45 ||
    !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new EvidenceError('Evidence must be a complete PNG image.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 32768 ||
    height > 32768 ||
    width * height > 48_000_000
  ) {
    throw new EvidenceError('PNG dimensions are invalid or too large.');
  }
  const depth = buffer[24] ?? 0;
  const color = buffer[25] ?? -1;
  const validDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = [1, 0, 3, 1, 2, 0, 4][color];
  const interlace = buffer[28] ?? -1;
  if (
    !channels ||
    !validDepths[color]?.includes(depth) ||
    buffer[26] !== 0 ||
    buffer[27] !== 0 ||
    ![0, 1].includes(interlace)
  ) {
    throw new EvidenceError('PNG header uses an invalid pixel format.');
  }
  const compressed: Buffer[] = [];
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  let palette = false;
  let paletteEntries = 0;
  for (let offset = 8; offset < buffer.length;) {
    if (buffer.length - offset < 12)
      throw new EvidenceError('PNG chunk is truncated.');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length)
      throw new EvidenceError('PNG chunk length exceeds the file.');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(buffer.subarray(offset + 4, offset + 8 + length)) !==
        buffer.readUInt32BE(end - 4)
    ) {
      throw new EvidenceError('PNG chunk checksum or type is invalid.');
    }
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13)
        throw new EvidenceError('PNG must have one initial IHDR chunk.');
    } else if (type === 'PLTE') {
      if (
        sawData ||
        palette ||
        length === 0 ||
        length % 3 ||
        length > 768 ||
        [0, 4].includes(color) ||
        (color === 3 && length / 3 > 2 ** depth)
      ) {
        throw new EvidenceError('PNG palette is invalid.');
      }
      palette = true;
      paletteEntries = length / 3;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette))
        throw new EvidenceError('PNG image data order is invalid.');
      sawData = true;
      compressed.push(buffer.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      if (!sawData || length !== 0 || end !== buffer.length)
        throw new EvidenceError('PNG end or image data is missing.');
      sawEnd = true;
    } else {
      if (type[0] === type[0]?.toUpperCase())
        throw new EvidenceError('PNG has an unknown critical chunk.');
      if (sawData) dataEnded = true;
    }
    offset = end;
  }
  if (!sawEnd || !compressed.some((chunk) => chunk.length > 0)) {
    throw new EvidenceError('PNG has no complete image payload.');
  }
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1] as const]
      : ([
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ] as const);
  const rows = passes
    .map(([x, y, dx, dy]) => ({
      width: Math.max(0, Math.ceil((width - x) / dx)),
      height: Math.max(0, Math.ceil((height - y) / dy)),
    }))
    .filter((pass) => pass.width && pass.height)
    .map((pass) => ({
      height: pass.height,
      width: pass.width,
      bytes: Math.ceil((pass.width * channels * depth) / 8) + 1,
    }));
  const expected = rows.reduce((sum, row) => sum + row.height * row.bytes, 0);
  if (expected > 200 * 1024 * 1024)
    throw new EvidenceError('PNG decoded image exceeds the safety budget.');
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expected,
    });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      !/^(Z_|ERR_BUFFER_TOO_LARGE)/.test(String(error.code))
    )
      throw error;
    throw new EvidenceError(
      'PNG compressed image data is invalid or exceeds its dimensions.',
    );
  }
  if (decoded.length !== expected)
    throw new EvidenceError('PNG scanline size does not match its dimensions.');
  let offset = 0;
  for (const row of rows) {
    let previous = Buffer.alloc(row.bytes - 1);
    for (let i = 0; i < row.height; i += 1) {
      const filter = decoded[offset] ?? 255;
      if (filter > 4)
        throw new EvidenceError('PNG scanline filter is invalid.');
      if (color === 3) {
        const current = Buffer.from(
          decoded.subarray(offset + 1, offset + row.bytes),
        );
        for (let j = 0; j < current.length; j += 1) {
          const left = j ? current.readUInt8(j - 1) : 0;
          const up = previous.readUInt8(j);
          const corner = j ? previous.readUInt8(j - 1) : 0;
          let prediction = 0;
          if (filter === 1) prediction = left;
          if (filter === 2) prediction = up;
          if (filter === 3) prediction = Math.floor((left + up) / 2);
          if (filter === 4) {
            const p = left + up - corner;
            const a = Math.abs(p - left);
            const b = Math.abs(p - up);
            const c = Math.abs(p - corner);
            prediction = a <= b && a <= c ? left : b <= c ? up : corner;
          }
          current[j] = (current.readUInt8(j) + prediction) & 255;
        }
        const perByte = 8 / depth;
        for (let x = 0; x < row.width; x += 1) {
          const byte = current.readUInt8(Math.floor(x / perByte));
          const index =
            (byte >> (8 - depth - (x % perByte) * depth)) & ((1 << depth) - 1);
          if (index >= paletteEntries)
            throw new EvidenceError(
              'PNG pixel palette index is out of bounds.',
            );
        }
        previous = current;
      }
      offset += row.bytes;
    }
  }
}

export function evidencePath(
  issue: number,
  buffer: Buffer,
  capturedAt: string,
): string {
  z.number().int().positive().parse(issue);
  z.iso.datetime().parse(capturedAt);
  validatePng(buffer);
  const stamp = new Date(capturedAt)
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z');
  const sha = createHash('sha256').update(buffer).digest('hex');
  return `evidence/${issue}/${stamp}-${sha.slice(0, 8)}.png`;
}
