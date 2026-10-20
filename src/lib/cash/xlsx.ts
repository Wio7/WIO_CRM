import { strToU8, zipSync } from 'fflate';
import type { CashAudit, CashEntry } from './model';

const xml = (value: unknown) => String(value ?? '').replace(/[<>&"']/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[char] ?? char);

function sheet(rows: (string | number)[][]) {
  const body = rows.map((row, index) => `<row r="${index + 1}">${row.map((cell, column) => {
    let n = column + 1;
    let letter = '';
    while (n) { n--; letter = String.fromCharCode(65 + n % 26) + letter; n = Math.floor(n / 26); }
    const ref = `${letter}${index + 1}`;
    return typeof cell === 'number' && Number.isFinite(cell)
      ? `<c r="${ref}"><v>${cell}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${xml(cell)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function cashWorkbook(entries: CashEntry[], audit: CashAudit[]) {
  const movementRows: (string | number)[][] = [
    ['ID', 'Tipo', 'Monto S/', 'Concepto', 'Proveedor / origen', 'Fecha del movimiento', 'Responsable', 'Creado (UTC)', 'Último cambio (UTC)', 'ID presupuesto', 'Anula a'],
    ...entries.map((e) => [e.id, e.kind === 'income' ? 'Ingreso' : 'Gasto', e.amount_cents / 100,
      e.concept, e.counterparty, e.occurred_on, e.actor_name, e.created_at, e.updated_at ?? e.created_at,
      e.budget_id ?? '', e.reversal_of ?? '']),
  ];
  const auditRows: (string | number)[][] = [
    ['ID movimiento', 'Acción', 'Fecha y hora (UTC)', 'Responsable', 'Motivo', 'Monto anterior S/', 'Monto nuevo S/', 'Concepto anterior', 'Concepto nuevo', 'Proveedor anterior', 'Proveedor nuevo', 'Fecha anterior', 'Fecha nueva'],
    ...audit.map((h) => [h.entry_id, h.action, h.changed_at, h.actor_name, h.reason ?? '',
      h.before_data ? h.before_data.amount_cents / 100 : '', h.after_data.amount_cents / 100,
      h.before_data?.concept ?? '', h.after_data.concept, h.before_data?.counterparty ?? '', h.after_data.counterparty,
      h.before_data?.occurred_on ?? '', h.after_data.occurred_on]),
  ];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Movimientos" sheetId="1" r:id="rId1"/><sheet name="Historial de cambios" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet(movementRows)),
    'xl/worksheets/sheet2.xml': strToU8(sheet(auditRows)),
  };
  return zipSync(files);
}
