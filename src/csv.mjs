// A small, strict CSV reader for price imports: a header row naming the columns, then one item per line.
// Supports quoted fields with commas and doubled quotes. Unknown columns are ignored; sku and price are required.
const KNOWN = new Set(['sku', 'name', 'price', 'cost', 'category', 'description']);
export const MAX_CSV_BYTES = 64 * 1024;

export class CsvError extends Error {}

function splitLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (q) throw new CsvError('A quoted field is never closed.');
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new CsvError('The CSV is empty.');
  if (text.length > MAX_CSV_BYTES) throw new CsvError('The CSV is larger than 64 KB.');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  if (!header.includes('sku') || !header.includes('price')) throw new CsvError('The header row must include "sku" and "price".');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row = {};
    header.forEach((h, j) => { if (KNOWN.has(h) && cells[j] !== undefined && cells[j] !== '') row[h] = cells[j]; });
    rows.push(row);
  }
  if (!rows.length) throw new CsvError('The CSV has a header but no items.');
  return { columns: header.filter((h) => KNOWN.has(h)), rows };
}
