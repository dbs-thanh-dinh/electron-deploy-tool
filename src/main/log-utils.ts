// Log file housekeeping. Must not import electron so it stays unit-testable.
import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE_PATTERN = /^deploy-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * Deletes `deploy-YYYY-MM-DD.log` files whose date (taken from the file name, local time) is more than
 * `maxAgeDays` calendar days before today. Other files are never touched. Best effort: never throws,
 * a file that cannot be removed is skipped. Returns the names that were deleted.
 */
export function pruneOldLogs(logDir: string, maxAgeDays: number, now: Date = new Date()): string[] {
  const deleted: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return deleted;
  }

  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxAgeDays);
  for (const name of names) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) continue;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const fileDate = new Date(year, month - 1, day);
    // Reject impossible dates such as 2026-13-45 (Date would roll them over)
    if (fileDate.getFullYear() !== year || fileDate.getMonth() !== month - 1 || fileDate.getDate() !== day) continue;
    if (fileDate >= cutoff) continue;
    try {
      fs.rmSync(path.join(logDir, name), { force: true });
      deleted.push(name);
    } catch {
      // Locked or read-only: try again on the next start
    }
  }
  return deleted;
}
