export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (closedQuote && char !== ',' && char !== '\r' && char !== '\n') {
      throw new Error('Invalid CSV: characters after a closing quote.');
    }
    if (char === '"') {
      if (field) throw new Error('Invalid CSV: quote in an unquoted field.');
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (char === '\r' || char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Invalid CSV: unterminated quoted field.');
  if (field || row.length || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = value == null ? '' : String(value);
            if (/^\s*[=+\-@]|^[\t\r]/.test(text)) text = `'${text}`;
            return /[",\r\n]/.test(text)
              ? `"${text.replaceAll('"', '""')}"`
              : text;
          })
          .join(','),
      )
      .join('\r\n') + (rows.length ? '\r\n' : '')
  );
}
