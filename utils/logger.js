import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runsDir = join(__dirname, '..', 'runs');

if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

function timestamp() {
  return new Date().toISOString();
}

function pad(d) {
  return String(d).padStart(2, '0');
}

function runFilename() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
}

class Logger {
  constructor() {
    this.entries = [];
    this.runFile = join(runsDir, runFilename());
  }

  _log(level, stage, message, data = null) {
    const entry = { timestamp: timestamp(), level, stage, message };
    if (data) entry.data = data;
    this.entries.push(entry);
    const prefix = `[${level.toUpperCase()}] [${stage}]`;
    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  info(stage, message, data) { this._log('info', stage, message, data); }
  warn(stage, message, data) { this._log('warn', stage, message, data); }
  error(stage, message, data) { this._log('error', stage, message, data); }
  success(message, data) { this._log('info', 'pipeline', message, data); }

  save() {
    writeFileSync(this.runFile, JSON.stringify(this.entries, null, 2));
    console.log(`[LOG] Run log saved to ${this.runFile}`);
  }

  saveDryRun(article) {
    const ts = timestamp().replace(/[:.]/g, '-');
    const file = join(runsDir, `dry-run-${ts}.json`);
    writeFileSync(file, JSON.stringify(article, null, 2));
    console.log(`[DRY-RUN] Output saved to ${file}`);
  }
}

export default new Logger();
