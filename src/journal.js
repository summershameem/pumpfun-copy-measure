import fs from 'node:fs';
import { parseCsv } from './csv.js';

// A write-ahead journal protects detected buys before their 5-minute CSV row exists.
export class Journal {
  constructor(path, csvPath, writer, log) {
    const done = new Set(fs.existsSync(csvPath) ? parseCsv(fs.readFileSync(csvPath, 'utf8')).map(r => r.id) : []);
    const pending = new Map();
    if (fs.existsSync(path)) {
      const lines = fs.readFileSync(path, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        let entry;
        try { entry = JSON.parse(lines[i]); }
        catch {
          if (i >= lines.length - 2) { log('Ignoring torn final journal line'); break; }
          throw new Error('Journal corruption before final line; preserve pending.jsonl for inspection');
        }
        if (entry.done) pending.delete(entry.done); else pending.set(entry.row.id, entry.row);
      }
    }
    for (const [id, row] of pending) if (!done.has(id)) {
      // Unknown observations must remain blank, including copier flow.
      for (const key of Object.keys(row)) if (/^copier_/.test(key)) delete row[key];
      writer.append({ ...row, status: 'interrupted', data_quality: 'incomplete',
        quality_notes: 'process_interrupted_before_completion' });
      log(`Recovered interrupted observation ${id}`);
    }
    this.fd = fs.openSync(path, 'w'); fs.fsyncSync(this.fd);
  }
  write(value) { fs.writeSync(this.fd, JSON.stringify(value) + '\n'); fs.fsyncSync(this.fd); }
  begin(row) { this.write({ row }); }
  done(id) { this.write({ done: id }); }
  close() { fs.closeSync(this.fd); }
}

export function acquireLock(path) {
  try {
    const fd = fs.openSync(path, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('run.lock exists. Stop the other bot; if it crashed, remove run.lock before restarting.');
    throw error;
  }
  return () => fs.unlinkSync(path);
}
