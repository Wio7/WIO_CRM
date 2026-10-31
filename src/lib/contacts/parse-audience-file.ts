import readXlsxFile from 'read-excel-file';

export interface AudienceFileRow {
  phone: string;
  name?: string;
}

export interface AudienceFileResult {
  valid: AudienceFileRow[];
  invalid: Array<{ row: number; value: string }>;
  duplicates: number;
  /** First 5 valid rows, for the on-screen preview. */
  preview: AudienceFileRow[];
}

export const MAX_AUDIENCE_ROWS = 5000;

const PHONE_HEADERS = ['telefono', 'celular', 'movil', 'whatsapp', 'numero', 'phone'];
const NAME_HEADERS = ['nombre', 'name'];

/** Lowercase, accent-free, trimmed: "Teléfono " -> "telefono". */
function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Digits of a phone cell, without ever rounding through a JS number.
 * Spreadsheets love to turn 51944585122 into "5.1944585122E10"; that is
 * expanded textually so no digit is lost. A 9-digit number starting with
 * 9 is a Peruvian mobile and gets the 51 country code.
 */
export function phoneDigits(value: unknown): string {
  let text = String(value ?? '').trim();

  const scientific = /^\+?(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(text);
  if (scientific) {
    const [, whole, fraction = '', exponentText] = scientific;
    const digits = whole + fraction;
    const point = whole.length + Number(exponentText);
    if (point >= digits.length) {
      text = digits + '0'.repeat(point - digits.length);
    } else {
      // The exponent leaves decimals; a phone number has none.
      text = digits.slice(0, point);
    }
  } else if (/^\d+\.0*$/.test(text)) {
    // "51944585122.0" (a number cell exported as text).
    text = text.slice(0, text.indexOf('.'));
  }

  const digits = text.replace(/\D/g, '');
  return digits.length === 9 && digits.startsWith('9') ? `51${digits}` : digits;
}

/** Exact heading first, then one that contains it ("Número de WhatsApp"). */
function findColumn(headings: string[], names: string[]): number {
  const exact = headings.findIndex((h) => names.includes(h));
  if (exact >= 0) return exact;
  return headings.findIndex((h) =>
    h.split(/[^a-z0-9]+/).some((word) => names.includes(word)),
  );
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((cell) => String(cell ?? '').trim() === '');
}

/** Turns spreadsheet rows (first row = headers) into a clean audience. */
export function parseAudienceRows(allRows: unknown[][]): AudienceFileResult {
  const empty: AudienceFileResult = { valid: [], invalid: [], duplicates: 0, preview: [] };
  if (allRows.length === 0) return empty;

  const headings = allRows[0].map(normalizeHeader);
  const phoneColumn = findColumn(headings, PHONE_HEADERS);
  const nameColumn = findColumn(headings, NAME_HEADERS);
  if (phoneColumn < 0) {
    throw new Error(
      'No encontramos una columna de teléfono (teléfono, celular, móvil, WhatsApp, número o phone).',
    );
  }

  // Keep the original sheet row number for the "invalid" report.
  const body = allRows
    .slice(1)
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(({ row }) => !isBlankRow(row));
  if (body.length > MAX_AUDIENCE_ROWS) {
    throw new Error(`El archivo tiene más de ${MAX_AUDIENCE_ROWS} filas.`);
  }

  const valid: AudienceFileRow[] = [];
  const invalid: AudienceFileResult['invalid'] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const { row, sheetRow } of body) {
    const raw = row[phoneColumn];
    const phone = phoneDigits(raw);
    // E.164: 7-15 digits, no leading zero (what Meta accepts).
    if (!/^[1-9]\d{6,14}$/.test(phone)) {
      invalid.push({ row: sheetRow, value: String(raw ?? '') });
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);
    const name = nameColumn >= 0 ? String(row[nameColumn] ?? '').trim() : '';
    valid.push({ phone, ...(name ? { name } : {}) });
  }

  return { valid, invalid, duplicates, preview: valid.slice(0, 5) };
}

/**
 * Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines
 * inside quotes. The delimiter (comma, semicolon or tab, as Excel in
 * Spanish locales exports) is picked from the header line.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t']
    .map((d) => ({ d, count: firstLine.split(d).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

export async function parseAudienceFile(file: File): Promise<AudienceFileResult> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'csv') {
    return parseAudienceRows(parseCsv(await file.text()));
  }
  if (extension === 'xlsx') {
    return parseAudienceRows(await readXlsxFile(file));
  }
  throw new Error('Solo se admiten archivos .xlsx y .csv.');
}
