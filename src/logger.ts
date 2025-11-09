import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

export const LOG_DIVIDER = '******************';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'system.log');
let logDirEnsured = false;

function ensureLogDir(): void {
  if (logDirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirEnsured = true;
  } catch (error) {
    // Surface the error but keep console logging functional.
    console.error('Failed to initialize system log directory:', error);
  }
}

async function appendToLog(lines: string[]): Promise<void> {
  ensureLogDir();
  try {
    await fsPromises.appendFile(LOG_FILE, `${lines.join('\n')}\n`);
  } catch (error) {
    console.error('Failed to write system log file:', error);
  }
}

export function logSection(...lines: string[]): void {
  const timestamp = new Date().toISOString();
  console.log(LOG_DIVIDER);
  for (const line of lines) {
    console.log(line);
  }

  const formattedLines = [
    LOG_DIVIDER,
    `[${timestamp}]`,
    ...lines,
  ];
  void appendToLog(formattedLines);
}
