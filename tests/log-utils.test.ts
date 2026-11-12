import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneOldLogs } from '../src/main/log-utils';

let dir: string;
const now = new Date(2026, 10, 12, 15, 30); // 2026-11-12 local

const touch = (name: string) => fs.writeFileSync(path.join(dir, name), 'x');
const remaining = () => fs.readdirSync(dir).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-utils-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('pruneOldLogs', () => {
  it('deletes logs older than the limit and keeps the rest', () => {
    // 2026-11-12 minus 90 days = 2026-08-14
    ['deploy-2026-08-13.log', 'deploy-2026-08-14.log', 'deploy-2026-11-12.log', 'deploy-2025-01-01.log'].forEach(touch);

    const deleted = pruneOldLogs(dir, 90, now);

    expect(deleted.sort()).toEqual(['deploy-2025-01-01.log', 'deploy-2026-08-13.log']);
    expect(remaining()).toEqual(['deploy-2026-08-14.log', 'deploy-2026-11-12.log']);
  });

  it('never touches files that do not match the log naming scheme', () => {
    ['notes.txt', 'deploy-2020-01-01.txt', 'deploy-old.log', 'backup-deploy-2020-01-01.log', 'deploy-2020-13-45.log'].forEach(touch);

    expect(pruneOldLogs(dir, 90, now)).toEqual([]);
    expect(remaining()).toHaveLength(5);
  });

  it('skips a directory that looks like an old log', () => {
    fs.mkdirSync(path.join(dir, 'deploy-2020-01-01.log'));

    expect(pruneOldLogs(dir, 90, now)).toEqual([]);
    expect(remaining()).toEqual(['deploy-2020-01-01.log']);
  });

  it('does not throw when the directory is missing', () => {
    expect(pruneOldLogs(path.join(dir, 'nope'), 90, now)).toEqual([]);
  });

  it('works across a year boundary', () => {
    touch('deploy-2025-12-31.log');
    touch('deploy-2026-01-01.log');

    // 2026-01-15 minus 14 days = 2026-01-01 (kept)
    expect(pruneOldLogs(dir, 14, new Date(2026, 0, 15))).toEqual(['deploy-2025-12-31.log']);
    expect(remaining()).toEqual(['deploy-2026-01-01.log']);
  });
});
