// csv.js - minimal, correct CSV read/write for the record schema.
// Columns match the original Python collector exactly: date,title,url,scraped_at
// so exports are a drop-in replacement for finsmes_master_urls.csv.

const COLUMNS = ['date', 'title', 'url', 'website', 'emails', 'scraped_at'];

function escapeField(v) {
  const s = (v == null ? '' : String(v));
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCSV(records) {
  const lines = [COLUMNS.join(',')];
  for (const r of records) {
    lines.push(COLUMNS.map((c) => escapeField(r[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function toJSON(records) {
  return JSON.stringify(records, null, 2);
}

// A small state-machine CSV parser that handles quoted fields, embedded
// commas, escaped quotes, and CRLF/LF line endings.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // trailing field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] != null ? cells[c] : '';
    out.push(obj);
  }
  return out;
}
