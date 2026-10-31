import { beforeAll, describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { strToU8, zipSync } from 'fflate';

import {
  parseAudienceFile,
  parseAudienceRows,
  parseCsv,
  phoneDigits,
} from './parse-audience-file';

describe('phoneDigits', () => {
  it('expands scientific notation without losing digits', () => {
    expect(phoneDigits('5.1944585122E10')).toBe('51944585122');
    expect(phoneDigits('5.1944585122e+10')).toBe('51944585122');
    expect(phoneDigits(5.1944585122e10)).toBe('51944585122');
  });

  it('reads a number stored as text with a trailing .0', () => {
    expect(phoneDigits('51944585122.0')).toBe('51944585122');
  });

  it('adds 51 to 9-digit numbers that start with 9 (Peru)', () => {
    expect(phoneDigits('944585122')).toBe('51944585122');
    expect(phoneDigits('944 585 122')).toBe('51944585122');
    expect(phoneDigits(944585122)).toBe('51944585122');
  });

  it('keeps numbers that already have a country code', () => {
    expect(phoneDigits('+51 944 585 122')).toBe('51944585122');
    expect(phoneDigits('+1 (415) 555-0123')).toBe('14155550123');
  });
});

describe('parseAudienceRows', () => {
  it('finds columns ignoring case and accents', () => {
    const result = parseAudienceRows([
      ['NOMBRE', 'Teléfono'],
      ['Ana', '944585122'],
      ['Luis', 51987654321],
    ]);
    expect(result.valid).toEqual([
      { phone: '51944585122', name: 'Ana' },
      { phone: '51987654321', name: 'Luis' },
    ]);
  });

  it.each(['celular', 'Móvil', 'WhatsApp', 'Número', 'phone'])(
    'accepts "%s" as the phone column',
    (heading) => {
      const result = parseAudienceRows([[heading], ['51944585122']]);
      expect(result.valid).toEqual([{ phone: '51944585122' }]);
    },
  );

  it('removes duplicates after normalizing and counts them', () => {
    const result = parseAudienceRows([
      ['telefono'],
      ['944585122'],
      ['51944585122'],
      ['+51 944 585 122'],
      ['5.1944585122E10'],
      ['51987654321'],
    ]);
    expect(result.valid.map((r) => r.phone)).toEqual(['51944585122', '51987654321']);
    expect(result.duplicates).toBe(3);
  });

  it('reports invalid rows with their sheet row number and skips blank rows', () => {
    const result = parseAudienceRows([
      ['telefono', 'nombre'],
      ['abc', 'X'],
      ['', ''],
      ['12', 'Y'],
      ['051944585122', 'Z'],
      ['51944585122', 'Ok'],
    ]);
    expect(result.valid).toEqual([{ phone: '51944585122', name: 'Ok' }]);
    expect(result.invalid).toEqual([
      { row: 2, value: 'abc' },
      { row: 4, value: '12' },
      { row: 5, value: '051944585122' },
    ]);
  });

  it('gives a 5-row preview', () => {
    const rows: unknown[][] = [['telefono']];
    for (let i = 0; i < 8; i++) rows.push([`5198765432${i}`]);
    expect(parseAudienceRows(rows).preview).toHaveLength(5);
  });

  it('rejects files without a phone column', () => {
    expect(() => parseAudienceRows([['nombre'], ['Ana']])).toThrow(/columna de teléfono/);
  });

  it('rejects more than 5000 rows', () => {
    const rows: unknown[][] = [['telefono']];
    for (let i = 0; i < 5001; i++) rows.push([String(51900000000 + i)]);
    expect(() => parseAudienceRows(rows)).toThrow(/5000/);
    rows.pop();
    expect(parseAudienceRows(rows).valid).toHaveLength(5000);
  });
});

describe('parseCsv', () => {
  it('handles BOM, semicolons, quotes and CRLF', () => {
    const csv = '﻿Nombre;Teléfono\r\n"Pérez; Ana";944585122\r\n"Say ""hi""";5.1987654321E10\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Nombre', 'Teléfono'],
      ['Pérez; Ana', '944585122'],
      ['Say "hi"', '5.1987654321E10'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('name,phone\n"Doe, Jane",51944585122')[1]).toEqual([
      'Doe, Jane',
      '51944585122',
    ]);
  });
});

function csvFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/csv' });
}

// A minimal but valid .xlsx built with fflate, so the real
// read-excel-file code path is exercised without a binary fixture.
function xlsxFile(rows: (string | number)[][]): File {
  const strings: string[] = [];
  const cell = (value: string | number, r: number, c: number) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
    let index = strings.indexOf(value);
    if (index < 0) index = strings.push(value) - 1;
    return `<c r="${ref}" t="s"><v>${index}</v></c>`;
  };
  const sheetRows = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join('')}</row>`)
    .join('');
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((s) => `<si><t>${s}</t></si>`)
        .join('')}</sst>`,
    ),
  };
  const bytes = zipSync(files);
  return new File([bytes as BlobPart], 'audiencia.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('parseAudienceFile', () => {
  beforeAll(() => {
    // read-excel-file's browser build parses XML with the DOM's
    // DOMParser; node has none, so borrow the one it uses for Node.
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
  });

  it('reads a .csv file', async () => {
    const result = await parseAudienceFile(
      csvFile('lista.csv', 'nombre,celular\nAna,944585122\nLuis,5.1987654321E10\nAna,944585122\nX,abc\n'),
    );
    expect(result.valid).toEqual([
      { phone: '51944585122', name: 'Ana' },
      { phone: '51987654321', name: 'Luis' },
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual([{ row: 5, value: 'abc' }]);
  });

  it('reads a .xlsx file (numeric and text phone cells)', async () => {
    const result = await parseAudienceFile(
      xlsxFile([
        ['Nombre', 'Teléfono'],
        ['Ana', 944585122],
        ['Luis', 51987654321],
        ['Marta', '5.1912345678E10'],
        ['Dup', '51944585122'],
        ['Mala', 'nope'],
      ]),
    );
    expect(result.valid).toEqual([
      { phone: '51944585122', name: 'Ana' },
      { phone: '51987654321', name: 'Luis' },
      { phone: '51912345678', name: 'Marta' },
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual([{ row: 6, value: 'nope' }]);
  });

  it('rejects other file types', async () => {
    await expect(parseAudienceFile(new File(['x'], 'lista.txt'))).rejects.toThrow(/xlsx y .csv/);
  });
});

describe('column detection', () => {
  it('finds a heading that contains the word', () => {
    const out = parseAudienceRows([
      ['Nombre completo', 'Número de WhatsApp'],
      ['Ana', '944585122'],
    ]);
    expect(out.valid).toEqual([{ phone: '51944585122', name: 'Ana' }]);
  });

  it('prefers the exact heading', () => {
    const out = parseAudienceRows([
      ['Número de cliente', 'Celular'],
      ['12', '944585122'],
    ]);
    expect(out.valid[0].phone).toBe('51944585122');
  });
});
