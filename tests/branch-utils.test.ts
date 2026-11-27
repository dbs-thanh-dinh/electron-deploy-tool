import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRemoteBranches, parseRemoteBranches, pickRemote } from '../src/main/branch-utils';

// Real git on Windows can be slow (antivirus scanning, process spawn)
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let rootDir: string;
let savedEnv: NodeJS.ProcessEnv;
let caseDir: string;
let remoteDir: string;
let workDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

beforeAll(() => {
  savedEnv = { ...process.env };
  // Never let a surrounding git hook (GIT_DIR, ...) point these tests at a real repo
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-utils-test-'));
  const emptyGlobalConfig = path.join(rootDir, 'empty-gitconfig');
  fs.writeFileSync(emptyGlobalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterAll(() => {
  process.env = savedEnv;
  rm(rootDir);
});

/** A work repo whose only remote is called `remoteName`, with branches main and release/1.0 on the remote. */
function setupRepo(remoteName: string): void {
  caseDir = fs.mkdtempSync(path.join(rootDir, 'case-'));
  remoteDir = path.join(caseDir, 'remote.git');
  workDir = path.join(caseDir, 'work');
  fs.mkdirSync(remoteDir);
  fs.mkdirSync(workDir);

  git(remoteDir, 'init', '--bare', '-b', 'main');
  git(workDir, 'init', '-b', 'main');
  git(workDir, 'config', 'user.name', 'Test');
  git(workDir, 'config', 'user.email', 'test@example.com');
  git(workDir, 'config', 'commit.gpgsign', 'false');
  git(workDir, 'remote', 'add', remoteName, remoteDir);
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'a');
  git(workDir, 'add', 'a.txt');
  git(workDir, 'commit', '-m', 'init');
  git(workDir, 'push', '-u', remoteName, 'main');
  git(workDir, 'branch', 'release/1.0');
  git(workDir, 'push', remoteName, 'release/1.0');
}

afterEach(() => {
  if (caseDir) rm(caseDir);
  caseDir = '';
});

describe('pickRemote', () => {
  it('prefers the upstream remote, then origin, then the first remote', () => {
    expect(pickRemote(['origin', 'fork'], 'fork')).toBe('fork');
    expect(pickRemote(['fork', 'origin'], null)).toBe('origin');
    expect(pickRemote(['fork', 'other'], null)).toBe('fork');
    expect(pickRemote(['fork', 'origin'], 'gone')).toBe('origin');
  });

  it('returns null without usable remotes and skips option-like names', () => {
    expect(pickRemote([], null)).toBeNull();
    expect(pickRemote([''], null)).toBeNull();
    expect(pickRemote(['-evil', 'ok'], '-evil')).toBe('ok');
  });
});

describe('parseRemoteBranches', () => {
  it('keeps only the given remote, strips its prefix, skips HEAD pointers and sorts', () => {
    const out = '  origin/HEAD -> origin/main\n  origin/release/1.0\n  origin/main\n  fork/other\n  origin/origin/x\n';

    expect(parseRemoteBranches(out, 'origin')).toEqual(['main', 'origin/x', 'release/1.0']);
    expect(parseRemoteBranches(out, 'fork')).toEqual(['other']);
  });
});

describe('getRemoteBranches', () => {
  beforeEach(() => setupRepo('origin'));

  it('lists the branches of origin', async () => {
    expect(await getRemoteBranches(workDir)).toEqual({ branches: ['main', 'release/1.0'] });
  });

  it('works when the only remote is not called origin', async () => {
    rm(caseDir);
    setupRepo('upstream');

    expect(await getRemoteBranches(workDir)).toEqual({ branches: ['main', 'release/1.0'] });
  });

  it('uses the remote of the current branch when there are several remotes', async () => {
    git(workDir, 'remote', 'add', 'fork', remoteDir);
    git(workDir, 'push', 'fork', 'main:only-on-fork');
    git(workDir, 'config', 'branch.main.remote', 'fork');

    const result = await getRemoteBranches(workDir);

    expect(result.error).toBeUndefined();
    expect(result.branches).toContain('only-on-fork');
  });

  it('prunes branches deleted on the remote', async () => {
    git(workDir, 'fetch', 'origin');
    git(remoteDir, 'branch', '-D', 'release/1.0');

    expect((await getRemoteBranches(workDir)).branches).toEqual(['main']);
  });

  it('reports an empty path', async () => {
    expect(await getRemoteBranches('  ')).toEqual({ branches: [], error: 'Repository path is empty' });
  });

  it('reports a path that does not exist', async () => {
    const result = await getRemoteBranches(path.join(caseDir, 'missing'));

    expect(result.branches).toEqual([]);
    expect(result.error).toContain('does not exist');
  });

  it('reports a directory that is not a git repository', async () => {
    const plain = path.join(caseDir, 'plain');
    fs.mkdirSync(plain);

    const result = await getRemoteBranches(plain);

    expect(result.branches).toEqual([]);
    expect(result.error).toContain('Not a git repository');
  });

  it('reports a repository without remotes', async () => {
    git(workDir, 'remote', 'remove', 'origin');

    const result = await getRemoteBranches(workDir);

    expect(result.branches).toEqual([]);
    expect(result.error).toContain('No git remote');
  });

  it('keeps the cached branches and reports the problem when the fetch fails', async () => {
    await getRemoteBranches(workDir); // populate refs/remotes
    rm(remoteDir);

    const result = await getRemoteBranches(workDir);

    expect(result.branches).toEqual(['main', 'release/1.0']);
    expect(result.error).toContain('Could not fetch from "origin"');
  });

  it('resolves with an empty list and no error when aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await getRemoteBranches(workDir, controller.signal)).toEqual({ branches: [] });
  });
});
