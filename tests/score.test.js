import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeRow, parseCsv, CsvWriter } from '../src/csv.js';
import { COLUMNS } from '../src/rows.js';
import { summarize, selectRows } from '../score.js';

test('CSV roundtrip preserves commas, quotes, multiline text, blanks and Unicode', () => {
  const values = ['a,b', 'A "quote"', 'line 1\r\nline 2', '', '✓'];
  const headers = ['a', 'b', 'c', 'd', 'e'];
  const rows = parseCsv(encodeRow(headers) + encodeRow(values));
  assert.deepEqual(rows, [Object.fromEntries(headers.map((key, i) => [key, values[i]]))]);
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);
});

test('malformed CSV fails rather than silently shifting outcome columns', () => {
  assert.throws(() => parseCsv('a,b\n1\n'), /expected 2 fields/);
  assert.throws(() => parseCsv('a,b\n"unfinished,2'), /Unterminated/);
  assert.throws(() => parseCsv('a,b\n"ok"junk,2'), /Malformed/);
});

test('writer appends compatible rows and rejects incompatible headers', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-paper-csv-'));
  const file = path.join(directory, 'log.csv');
  try {
    let writer = new CsvWriter(file);
    writer.append({ id: 'one', quality_notes: 'Note, "quoted"\nNext line' });
    writer.close();
    writer = new CsvWriter(file);
    writer.append({ id: 'two', r30_net_multiple: 1.2 });
    writer.close();
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].quality_notes, 'Note, "quoted"\nNext line');
    assert.equal(rows[1].r30_net_multiple, '1.2');
    assert.deepEqual(Object.keys(rows[0]), COLUMNS);
    fs.writeFileSync(file, 'wrong,header\n');
    assert.throws(() => new CsvWriter(file), /header mismatch/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('summary excludes unknowns, computes mean/median and strict hit rate', () => {
  const rows = [
    { data_quality: 'ok', copier_sol_15: '0', r30_net_multiple: '0.5' },
    { data_quality: 'ok', copier_sol_15: '1', r30_net_multiple: '1' },
    { data_quality: 'ok', copier_sol_15: '2', r30_net_multiple: '2' },
    { data_quality: 'ok', copier_sol_15: '', r30_net_multiple: '' },
    { data_quality: 'degraded', copier_sol_15: '100', r30_net_multiple: '10' },
  ];
  const result = summarize(rows);
  assert.equal(result.count, 5);
  assert.equal(result.incompleteCount, 1);
  assert.equal(result.eligibleCount, 4);
  assert.equal(result.meanCopierSol15, 1);
  assert.deepEqual(result.rules.r30, { count: 3, median: 1, mean: 3.5 / 3, hitRate: 1 / 3 });
  assert.deepEqual(result.rules.r60, { count: 0, median: null, mean: null, hitRate: null });
  const withIncomplete = summarize(rows, { includeIncomplete: true });
  assert.equal(withIncomplete.rules.r30.count, 4);
  assert.equal(withIncomplete.rules.r30.mean, 13.5 / 4);
});

test('flow cohort is strictly greater than 1 SOL and excludes missing values', () => {
  const rows = ['', undefined, 'NaN', '0.99', '1', '1.0001', '2'].map((copier_sol_15) => ({ copier_sol_15 }));
  assert.deepEqual(selectRows(rows, { minCopierSol15: 1 }).map((row) => row.copier_sol_15), ['1.0001', '2']);
  assert.deepEqual(summarize([]).rules.r30, { count: 0, median: null, mean: null, hitRate: null });
});
