import fs from 'node:fs';
import path from 'node:path';
import { COLUMNS } from './rows.js';

function cell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function encodeRow(values) {
  return `${values.map(cell).join(',')}\n`;
}

function parseRecords(text) {
  const records = [];
  let row = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field); field = ''; closed = false; };
  const pushRow = () => { pushField(); records.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ',') pushField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (field !== '' || row.length || closed) pushRow();
  return records;
}

export function parseCsv(text) {
  const records = parseRecords(text.replace(/^\uFEFF/, ''));
  if (!records.length) return [];
  const [header, ...rows] = records;
  if (new Set(header).size !== header.length) throw new Error('Duplicate CSV column');
  return rows.filter((row) => row.length !== 1 || row[0] !== '').map((row, i) => {
    if (row.length !== header.length) {
      throw new Error(`CSV record ${i + 2}: expected ${header.length} fields, got ${row.length}`);
    }
    return Object.fromEntries(header.map((key, j) => [key, row[j]]));
  });
}

export class CsvWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    const exists = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    if (exists) {
      const content = fs.readFileSync(filePath, 'utf8');
      const header = parseRecords(content.replace(/^\uFEFF/, ''))[0];
      if (JSON.stringify(header) !== JSON.stringify(COLUMNS)) {
        throw new Error(`CSV header mismatch in ${filePath}; use a fresh output file`);
      }
      parseCsv(content);
      // A terminal newline is needed before the next append, including valid
      // manually edited CSV files that omit their final newline.
      this.fd = fs.openSync(filePath, 'a');
      if (!/[\r\n]$/.test(content)) fs.writeSync(this.fd, '\n');
    } else {
      this.fd = fs.openSync(filePath, 'a');
      fs.writeSync(this.fd, encodeRow(COLUMNS));
    }
    fs.fsyncSync(this.fd);
  }

  append(row) {
    if (this.fd === null) throw new Error('CSV writer is closed');
    fs.writeSync(this.fd, encodeRow(COLUMNS.map((key) => row[key])));
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd === null) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}
