import { expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { evidencePath, validatePng } from './evidence.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);

it('validates PNGs and creates a collision-resistant issue-scoped evidence path', () => {
  expect(() => validatePng(png)).not.toThrow();
  expect(evidencePath(12, png, '2026-11-20T12:34:56.000Z')).toMatch(
    /^evidence\/12\/20261120T123456Z-[a-f0-9]{8}\.png$/,
  );
  expect(() => evidencePath(-1, png, '2026-11-20T12:34:56.000Z')).toThrow();
});

it('rejects non-PNGs and oversized images before upload', () => {
  expect(() => validatePng(Buffer.from('<svg/>'))).toThrow(/PNG/i);
  expect(() => validatePng(Buffer.alloc(11 * 1024 * 1024))).toThrow(
    /size|large/i,
  );
});

it('rejects fabricated header markers without any PNG image data', () => {
  const fake = Buffer.alloc(45);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(fake);
  fake.write('IHDR', 12);
  fake.writeUInt32BE(1, 16);
  fake.writeUInt32BE(1, 20);
  fake.write('IEND', 37);
  expect(() => validatePng(fake)).toThrow(/PNG/i);
});

it('rejects corruption of a PNG payload even when the outer markers remain intact', () => {
  const corrupted = Buffer.from(png);
  corrupted[45] = (corrupted[45] ?? 0) ^ 1;
  expect(() => validatePng(corrupted)).toThrow(/PNG/i);
});

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}

function image(header: Buffer, middle: Buffer[]): Buffer {
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', header),
    ...middle,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

it('accepts valid grayscale, indexed and Adam7-interlaced PNG payloads', () => {
  const gray = Buffer.from(png.subarray(16, 29));
  gray[9] = 0;
  expect(() =>
    validatePng(
      image(gray, [chunk('IDAT', deflateSync(Buffer.from([0, 42])))]),
    ),
  ).not.toThrow();
  const indexed = Buffer.from(gray);
  indexed[8] = 1;
  indexed[9] = 3;
  expect(() =>
    validatePng(
      image(indexed, [
        chunk('PLTE', Buffer.from([0, 0, 0])),
        chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
      ]),
    ),
  ).not.toThrow();
  const adam7 = Buffer.from(png.subarray(16, 29));
  adam7[12] = 1;
  expect(() =>
    validatePng(
      image(adam7, [
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
      ]),
    ),
  ).not.toThrow();
});

it('rejects malformed PNG chunk ordering, compressed data, filters and dimensions', () => {
  const header = Buffer.from(png.subarray(16, 29));
  const data = chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255])));
  const indexed = Buffer.from(header);
  indexed[9] = 3;
  const zero = Buffer.from(header);
  zero.writeUInt32BE(0);
  const huge = Buffer.from(header);
  huge.writeUInt32BE(8192);
  huge.writeUInt32BE(5000, 4);
  huge[8] = 16;
  const badFormat = Buffer.from(header);
  badFormat[10] = 1;
  const cases = [
    image(header, []),
    image(header, [chunk('IHDR', header), data]),
    image(header, [data, chunk('tEXt', Buffer.from('note')), data]),
    image(header, [chunk('ABCD', Buffer.alloc(0)), data]),
    image(indexed, [data]),
    image(indexed, [chunk('PLTE', Buffer.from([1, 2])), data]),
    image(header, [chunk('IDAT', Buffer.from('not a zlib stream'))]),
    image(header, [chunk('IDAT', deflateSync(Buffer.from([0])))]),
    image(header, [chunk('IDAT', deflateSync(Buffer.alloc(100)))]),
    image(header, [chunk('IDAT', deflateSync(Buffer.from([5, 0, 0, 0, 255])))]),
    image(zero, [data]),
    image(huge, [data]),
    image(badFormat, [data]),
    Buffer.concat([png, Buffer.from('trailing data')]),
  ];
  for (const invalid of cases)
    expect(() => validatePng(invalid)).toThrow(/PNG/i);
});

it('validates palette indices after scanline unfiltering and packed-bit decoding', () => {
  for (const depth of [1, 2, 4, 8]) {
    const header = Buffer.from(png.subarray(16, 29));
    header[8] = depth;
    header[9] = 3;
    const indexOne = 1 << (8 - depth);
    const invalid = image(header, [
      chunk('PLTE', Buffer.from([0, 0, 0])),
      chunk('IDAT', deflateSync(Buffer.from([0, indexOne]))),
    ]);
    expect(() => validatePng(invalid)).toThrow(/palette|index/i);
  }
  const header = Buffer.from(png.subarray(16, 29));
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[9] = 3;
  const filteredRows = [
    [0, 1, 1],
    [1, 1, 0],
    [2, 0, 0],
    [3, 1, 0],
    [4, 0, 0],
  ];
  for (const row of filteredRows) {
    const raw = Buffer.from([0, 1, 1, ...row]);
    expect(() =>
      validatePng(
        image(header, [
          chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
          chunk('IDAT', deflateSync(raw)),
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      validatePng(
        image(header, [
          chunk('PLTE', Buffer.from([0, 0, 0])),
          chunk('IDAT', deflateSync(raw)),
        ]),
      ),
    ).toThrow(/palette|index/i);
  }
  header[12] = 1;
  expect(() =>
    validatePng(
      image(header, [
        chunk('PLTE', Buffer.from([0, 0, 0])),
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 1, 0, 0, 0]))),
      ]),
    ),
  ).toThrow(/palette|index/i);
});
