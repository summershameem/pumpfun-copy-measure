import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv } from './src/csv.js';
import { RULES } from './src/rows.js';

const finite = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function selectRows(rows, { minCopierSol15 } = {}) {
  if (minCopierSol15 === undefined) return rows;
  return rows.filter((row) => {
    const flow = finite(row.copier_sol_15);
    return flow !== null && flow > minCopierSol15;
  });
}

export function summarize(rows, { includeIncomplete = false } = {}) {
  const eligible = rows.filter((row) => includeIncomplete || row.data_quality === 'ok');
  const rules = Object.fromEntries(RULES.map(({ key }) => {
    const values = eligible.map((row) => finite(row[`${key}_net_multiple`]))
      .filter((value) => value !== null);
    return [key, {
      count: values.length, median: median(values), mean: mean(values),
      hitRate: values.length ? values.filter((n) => n > 1).length / values.length : null,
    }];
  }));
  return {
    count: rows.length,
    incompleteCount: rows.filter((row) => row.data_quality !== 'ok').length,
    eligibleCount: eligible.length,
    meanCopierSol15: mean(eligible.map((row) => finite(row.copier_sol_15))
      .filter((value) => value !== null)),
    rules,
  };
}

const decimal = (value, digits = 4) => value === null ? '—' : value.toFixed(digits);
const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

function printTable(rows, title, options) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('No leader buys in this group.'); return; }
  const wallets = [...new Set(rows.map((row) => row.leader_wallet))].sort();
  const groups = [['OVERALL', rows], ...wallets.map((wallet) => [
    wallet, rows.filter((row) => row.leader_wallet === wallet),
  ])];
  const output = groups.flatMap(([wallet, group]) => {
    const summary = summarize(group, options);
    return RULES.map(({ key, label }) => ({
      wallet, buys: summary.count, incomplete: summary.incompleteCount,
      rule: label, 'valid N': summary.rules[key].count,
      'median x': decimal(summary.rules[key].median),
      'mean x': decimal(summary.rules[key].mean),
      'hit >1.0x': percent(summary.rules[key].hitRate),
      'mean copier SOL +15s': decimal(summary.meanCopierSol15),
    }));
  });
  console.table(output);
}

export function main(args = process.argv.slice(2)) {
  const includeIncomplete = args.includes('--include-incomplete');
  const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--include-incomplete');
  const paths = args.filter((arg) => !arg.startsWith('--'));
  if (unknown.length || paths.length > 1) {
    throw new Error('Usage: node score.js [copy-log.csv] [--include-incomplete]');
  }
  const filePath = paths[0] ?? 'copy-log.csv';
  if (!fs.existsSync(filePath)) throw new Error(`No CSV found at ${filePath}; run the bot first`);
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const options = { includeIncomplete };
  console.log(`File: ${path.resolve(filePath)}`);
  console.log(includeIncomplete
    ? 'Includes finite outcomes from incomplete/degraded rows; unknown values remain excluded.'
    : 'Statistics require data_quality=ok; incomplete/degraded rows remain in buy counts.');
  console.log('Incomplete means data_quality is not ok. Valid N is per rule; hit rate is strictly >1.0x.');
  printTable(rows, 'All leader buys', options);
  printTable(selectRows(rows, { minCopierSol15: 1 }), 'Copier inflow in first 15 seconds >1 SOL', options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(`score: ${error.message}`); process.exitCode = 1; }
}
