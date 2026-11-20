import { expect, it } from 'vitest';
import { parseCsv, stringifyCsv } from './csv.js';

it('parses RFC-4180 quotes, multiline fields, BOM and trailing CRLF', () => {
  expect(
    parseCsv(
      '\uFEFFid,title\r\n1,"quoted ""name"", with comma"\r\n2,"line\r\nbreak"\r\n',
    ),
  ).toEqual([
    ['id', 'title'],
    ['1', 'quoted "name", with comma'],
    ['2', 'line\r\nbreak'],
  ]);
  expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  expect(parseCsv('')).toEqual([]);
  expect(parseCsv('a,,\n')).toEqual([['a', '', '']]);
});

it.each(['a,"unterminated', 'a,"quoted"x', 'a,b"quote'])(
  'rejects malformed CSV %s',
  (input) => {
    expect(() => parseCsv(input)).toThrow(/CSV/i);
  },
);

it('round trips safe cells and prevents spreadsheet formula execution', () => {
  const cells = [
    'plain',
    'comma,value',
    'quote"value',
    'line\nbreak',
    '=SUM(1)',
    '+1',
    '-1',
    '@cmd',
    '\t=1',
    '\r=1',
    '  =1',
  ];
  const result = parseCsv(stringifyCsv([cells]));
  expect(result).toEqual([
    cells.map((cell, index) => (index < 4 ? cell : `'${cell}`)),
  ]);
  expect(stringifyCsv([['header'], [true], [42], [null]])).toBe(
    'header\r\ntrue\r\n42\r\n\r\n',
  );
});
