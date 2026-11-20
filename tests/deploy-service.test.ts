import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployOptions, DeployService } from '../src/main/deploy-service';
import { DeployStepEventI } from '../src/main/deploy-steps';
import { ProjectI } from '../src/main/interface';

// DeployService reads app.getPath('userData') when constructed
const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));

// Real git on Windows can be slow (antivirus scanning, process spawn)
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const INITIAL_CICD = 'deploy: init\n';

let rootDir: string;
let savedEnv: NodeJS.ProcessEnv;
let remoteDir: string;
let workDir: string;
let service: DeployService;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function makeOptions(overrides: Partial<DeployOptions> = {}, projectOverrides: Partial<ProjectI> = {}): DeployOptions {
  const project: ProjectI = {
    name: 'test-project',
    repoPath: workDir,
    envs: ['dev'],
    deployTypes: ['api'],
    branchFilter: '',
    commitFormat: 'v1',
    commitTemplate: 'deploy: {env}, {type}',
    fileContentFormat: 'default',
    fileContentTemplate: 'deploy: {env}, {type}',
    smartAppend: false,
    cicdFileName: 'CICD.txt',
    ...projectOverrides,
  };
  return {
    project,
    branch: 'main',
    env: 'dev',
    type: 'api',
    dryRun: false,
    commitTemplate: 'deploy: {env}, {type}',
    fileContentTemplate: 'deploy: {env}, {type}',
    ...overrides,
  };
}

beforeAll(() => {
  savedEnv = { ...process.env };
  // Never let a surrounding git hook (GIT_DIR, GIT_INDEX_FILE, ...) point these tests at a real repo
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-tool-test-'));
  const emptyGlobalConfig = path.join(rootDir, 'empty-gitconfig');
  fs.writeFileSync(emptyGlobalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  state.userData = path.join(rootDir, 'userData');
});

afterAll(() => {
  process.env = savedEnv;
  rm(rootDir);
});

beforeEach(() => {
  const caseDir = fs.mkdtempSync(path.join(rootDir, 'case-'));
  remoteDir = path.join(caseDir, 'remote.git');
  workDir = path.join(caseDir, 'work');
  fs.mkdirSync(remoteDir);
  fs.mkdirSync(workDir);

  git(remoteDir, 'init', '--bare', '-b', 'main');
  git(workDir, 'init', '-b', 'main');
  git(workDir, 'config', 'user.name', 'Test');
  git(workDir, 'config', 'user.email', 'test@example.com');
  git(workDir, 'config', 'commit.gpgsign', 'false');
  git(workDir, 'config', 'core.autocrlf', 'false');
  git(workDir, 'config', 'core.hooksPath', path.join(workDir, '.git', 'hooks'));
  git(workDir, 'remote', 'add', 'origin', remoteDir);
  fs.writeFileSync(path.join(workDir, 'CICD.txt'), INITIAL_CICD);
  git(workDir, 'add', 'CICD.txt');
  git(workDir, 'commit', '-m', 'init');
  git(workDir, 'push', '-u', 'origin', 'main');

  service = new DeployService();
});

afterEach(() => {
  rm(path.dirname(workDir));
});

const readCicd = () => fs.readFileSync(path.join(workDir, 'CICD.txt'), 'utf8');
const headMessage = (cwd: string) => git(cwd, 'log', '-1', '--format=%s');
const joined = (logs: string[]) => logs.join('\n');

describe('DeployService.deploy', () => {
  it('dry-run commits locally and does not push', async () => {
    const remoteHeadBefore = git(remoteDir, 'rev-parse', 'main');

    const result = await service.deploy(makeOptions({ dryRun: true }));

    expect(result.success).toBe(true);
    expect(readCicd()).toBe('deploy: init\ndeploy: dev, api\n');
    expect(headMessage(workDir)).toBe('deploy: dev, api');
    expect(git(remoteDir, 'rev-parse', 'main')).toBe(remoteHeadBefore);
  });

  it('pushes the commit to the remote on a real deploy', async () => {
    const result = await service.deploy(makeOptions());

    expect(result.success).toBe(true);
    expect(headMessage(remoteDir)).toBe('deploy: dev, api');
  });

  it('logs the rev-parse command through the shared git runner', async () => {
    const result = await service.deploy(makeOptions({ dryRun: true }));

    expect(joined(result.logs)).toContain('$ git rev-parse --abbrev-ref HEAD');
    expect(joined(result.logs)).toContain('Current branch: main');
  });

  it('streams every log line to onLog as it is written, matching the returned logs', async () => {
    const streamed: string[] = [];

    const result = await service.deploy(makeOptions({ dryRun: true }), (line) => streamed.push(line));

    expect(result.success).toBe(true);
    expect(streamed).toEqual(result.logs);
  });

  it('keeps deploying when the onLog listener throws', async () => {
    const result = await service.deploy(makeOptions({ dryRun: true }), () => {
      throw new Error('window closed');
    });

    expect(result.success).toBe(true);
    expect(headMessage(workDir)).toBe('deploy: dev, api');
  });

  it('handles a CICD file in a sub-directory and a glob-like file name literally', async () => {
    fs.mkdirSync(path.join(workDir, 'ci'));
    fs.writeFileSync(path.join(workDir, 'ci', 'CICD[1].txt'), 'deploy: init\n');
    fs.writeFileSync(path.join(workDir, 'ci', 'CICD1.txt'), 'untouched\n');
    git(workDir, 'add', '-A');
    git(workDir, 'commit', '-m', 'add ci dir');
    git(workDir, 'push');

    const result = await service.deploy(makeOptions({ dryRun: true }, { cicdFileName: 'ci/CICD[1].txt' }));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'ci', 'CICD[1].txt'), 'utf8')).toBe('deploy: init\ndeploy: dev, api\n');
    // The glob "CICD[1].txt" would also match CICD1.txt; literal pathspecs must leave it alone
    expect(fs.readFileSync(path.join(workDir, 'ci', 'CICD1.txt'), 'utf8')).toBe('untouched\n');
    expect(git(workDir, 'show', '--name-only', '--format=', 'HEAD')).toBe('ci/CICD[1].txt');
  });

  it('warns in the log when local changes were stashed (and does not pop them)', async () => {
    fs.writeFileSync(path.join(workDir, 'CICD.txt'), 'dirty\n');

    const result = await service.deploy(makeOptions({ dryRun: true }));

    expect(result.success).toBe(true);
    expect(joined(result.logs)).toContain('NOT restored');
    expect(git(workDir, 'stash', 'list')).toContain('Auto stash before deploy');
  });

  it('does not warn about a stash when there were no local changes', async () => {
    const result = await service.deploy(makeOptions({ dryRun: true }));

    expect(joined(result.logs)).not.toContain('NOT restored');
  });

  it('does not warn when an older stash exists but nothing new was stashed', async () => {
    fs.writeFileSync(path.join(workDir, 'CICD.txt'), 'dirty\n');
    git(workDir, 'stash', 'save', 'older');

    const result = await service.deploy(makeOptions({ dryRun: true }));

    expect(result.success).toBe(true);
    expect(joined(result.logs)).not.toContain('NOT restored');
  });

  it('accepts a CICD file whose name starts with two dots, and rejects one outside the repo', async () => {
    fs.writeFileSync(path.join(workDir, '..cicd.txt'), 'deploy: init\n');
    git(workDir, 'add', '--', '..cicd.txt');
    git(workDir, 'commit', '-m', 'dotted name');
    git(workDir, 'push');

    const ok = await service.deploy(makeOptions({ dryRun: true }, { cicdFileName: '..cicd.txt' }));
    const outside = await service.deploy(makeOptions({ dryRun: true }, { cicdFileName: '../escape.txt' }));

    expect(ok.success).toBe(true);
    expect(fs.readFileSync(path.join(workDir, '..cicd.txt'), 'utf8')).toBe('deploy: init\ndeploy: dev, api\n');
    expect(outside.success).toBe(false);
    expect(outside.error).toContain('Invalid CICD file name');
  });

  it('checks out another branch before deploying', async () => {
    git(workDir, 'branch', 'release');
    git(workDir, 'push', '-u', 'origin', 'release'); // -u: pull needs an upstream

    const result = await service.deploy(makeOptions({ dryRun: true, branch: 'release' }));

    expect(result.success).toBe(true);
    expect(git(workDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('release');
    expect(headMessage(workDir)).toBe('deploy: dev, api');
    // main is untouched
    expect(git(workDir, 'log', '-1', '--format=%s', 'main')).toBe('init');
  });

  describe('nothing to commit', () => {
    it('fails with a clear error and creates no commit', async () => {
      // Empty file + empty template => the CICD file content does not change
      fs.writeFileSync(path.join(workDir, 'CICD.txt'), '');
      git(workDir, 'add', 'CICD.txt');
      git(workDir, 'commit', '-m', 'empty cicd');
      git(workDir, 'push');
      const headBefore = git(workDir, 'rev-parse', 'HEAD');

      const result = await service.deploy(makeOptions({ dryRun: true, fileContentTemplate: '' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nothing to commit');
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(readCicd()).toBe('');
    });
  });

  describe('rollback when the commit fails', () => {
    it('restores the CICD file and the index', async () => {
      const hook = path.join(workDir, '.git', 'hooks', 'pre-commit');
      // mode 0o755: git ignores non-executable hooks on Linux/macOS
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const headBefore = git(workDir, 'rev-parse', 'HEAD');

      const result = await service.deploy(makeOptions());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git commit failed');
      expect(readCicd()).toBe(INITIAL_CICD);
      expect(git(workDir, 'status', '--porcelain')).toBe('');
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(joined(result.logs)).toContain('✓ Rolled back CICD.txt');
    });
  });

  describe('push failure', () => {
    it('keeps the local commit, does not roll back, and tells the user it was not pushed', async () => {
      // Pull still works; only the push is rejected by the remote
      fs.writeFileSync(path.join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const result = await service.deploy(makeOptions());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git push failed');
      expect(headMessage(workDir)).toBe('deploy: dev, api');
      expect(readCicd()).toBe('deploy: init\ndeploy: dev, api\n');
      expect(joined(result.logs)).toContain('NOT pushed');
      expect(joined(result.logs)).not.toContain('Rolling back');
    });
  });

  describe('pull --ff-only', () => {
    it('fails without touching the repo when the branch has diverged', async () => {
      // Unpushed local commit
      fs.writeFileSync(path.join(workDir, 'local.txt'), 'local');
      git(workDir, 'add', 'local.txt');
      git(workDir, 'commit', '-m', 'local only');

      // Different commit pushed to the remote from another clone
      const other = path.join(path.dirname(workDir), 'other');
      git(path.dirname(workDir), 'clone', remoteDir, other);
      git(other, 'config', 'user.name', 'Other');
      git(other, 'config', 'user.email', 'other@example.com');
      git(other, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(other, 'remote.txt'), 'remote');
      git(other, 'add', 'remote.txt');
      git(other, 'commit', '-m', 'remote only');
      git(other, 'push');

      const headBefore = git(workDir, 'rev-parse', 'HEAD');

      const result = await service.deploy(makeOptions());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git pull failed');
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(readCicd()).toBe(INITIAL_CICD);
      // Failed before the CICD file was written, so there is nothing to roll back
      expect(joined(result.logs)).not.toContain('Rolling back');
      expect(joined(result.logs)).toContain('cannot fast-forward');
    });
  });
});

describe('DeployService.deploy steps and cancellation', () => {
  const collect = () => {
    const events: string[] = [];
    return { events, onStep: (e: DeployStepEventI) => events.push(`${e.step}:${e.status}`) };
  };
  const has = (events: string[], event: string) => events.includes(event);

  it('reports every step of a dry-run, skipping checkout (already on the branch) and push', async () => {
    const { events, onStep } = collect();
    const result = await service.deploy(makeOptions({ dryRun: true }), undefined, { onStep });
    expect(result.success).toBe(true);
    expect(events).toEqual([
      'stash:running', 'stash:done', 'checkout:running', 'checkout:skipped', 'pull:running', 'pull:done',
      'write:running', 'write:done', 'commit:running', 'commit:done', 'push:skipped',
    ]);
  });

  it('reports checkout and push as done on a real deploy to another branch', async () => {
    git(workDir, 'branch', 'release');
    git(workDir, 'push', '-u', 'origin', 'release');
    const { events, onStep } = collect();
    const result = await service.deploy(makeOptions({ branch: 'release' }), undefined, { onStep });
    expect(result.success).toBe(true);
    expect(events).toContain('checkout:done');
    expect(events.slice(-2)).toEqual(['push:running', 'push:done']);
    expect(result.cancelled).toBeUndefined();
  });

  it('marks the failing step and emits nothing after it', async () => {
    fs.writeFileSync(path.join(workDir, 'local.txt'), 'x');
    git(workDir, 'add', 'local.txt');
    git(workDir, 'commit', '-m', 'local only');
    const other = path.join(path.dirname(workDir), 'other');
    git(path.dirname(workDir), 'clone', remoteDir, other);
    git(other, 'config', 'user.name', 'O');
    git(other, 'config', 'user.email', 'o@example.com');
    git(other, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'x');
    git(other, 'add', 'remote.txt');
    git(other, 'commit', '-m', 'remote only');
    git(other, 'push');

    const { events, onStep } = collect();
    const result = await service.deploy(makeOptions(), undefined, { onStep });
    expect(result.success).toBe(false);
    expect(result.cancelled).toBeUndefined();
    expect(events.at(-1)).toBe('pull:failed');
    expect(events.some((e) => e.startsWith('write:'))).toBe(false);
  });

  it('emits no step event when validation fails before the first step', async () => {
    const { events, onStep } = collect();
    const result = await service.deploy(makeOptions({ branch: '-evil' }), undefined, { onStep });
    expect(result.success).toBe(false);
    expect(events).toEqual([]);
  });

  it('keeps deploying when the step listener throws', async () => {
    const result = await service.deploy(makeOptions({ dryRun: true }), undefined, {
      onStep: () => {
        throw new Error('window closed');
      },
    });
    expect(result.success).toBe(true);
  });

  it('works without hooks (old call style)', async () => {
    const result = await service.deploy(makeOptions({ dryRun: true }));
    expect(result.success).toBe(true);
  });

  describe('cancel before anything ran', () => {
    it('stops at the first boundary, touches nothing and reports a cancellation', async () => {
      const controller = new AbortController();
      controller.abort();
      const { events, onStep } = collect();
      const headBefore = git(workDir, 'rev-parse', 'HEAD');
      const result = await service.deploy(makeOptions(), undefined, { onStep, signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.error).toBe('Deploy cancelled by user');
      expect(events).toEqual(['stash:cancelled']);
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(workDir, 'stash', 'list')).toBe('');
      expect(readCicd()).toBe(INITIAL_CICD);
      expect(joined(result.logs)).toContain('⛔ Deploy cancelled by user');
      expect(joined(result.logs)).not.toContain('Deploy failed');
    });
  });

  describe('cancel at a step boundary after the CICD file was written', () => {
    it('rolls the file back and never commits', async () => {
      const controller = new AbortController();
      const events: string[] = [];
      const headBefore = git(workDir, 'rev-parse', 'HEAD');
      const result = await service.deploy(makeOptions(), undefined, {
        signal: controller.signal,
        onStep: (e) => {
          events.push(`${e.step}:${e.status}`);
          if (e.step === 'write' && e.status === 'done') controller.abort(); // user clicks Cancel here
        },
      });

      expect(result.cancelled).toBe(true);
      expect(events.at(-1)).toBe('commit:cancelled');
      expect(has(events, 'commit:running')).toBe(false);
      expect(readCicd()).toBe(INITIAL_CICD);
      expect(git(workDir, 'status', '--porcelain')).toBe('');
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(remoteDir, 'rev-parse', 'main')).toBe(headBefore);
      expect(joined(result.logs)).toContain('✓ Rolled back CICD.txt');
    });
  });

  describe('cancel while a git command that must not be killed is running', () => {
    it('lets the stash finish and stops at the next boundary (checkout)', async () => {
      const controller = new AbortController();
      const events: string[] = [];
      const result = await service.deploy(makeOptions(), undefined, {
        signal: controller.signal,
        onStep: (e) => {
          events.push(`${e.step}:${e.status}`);
          if (e.step === 'stash' && e.status === 'running') controller.abort();
        },
      });
      expect(result.cancelled).toBe(true);
      // stash was running when the abort came: it completes normally, the next boundary stops the deploy
      expect(events).toEqual(['stash:running', 'stash:done', 'checkout:cancelled']);
      expect(joined(result.logs)).toContain('git stash');
      expect(joined(result.logs)).not.toContain('interrupted');
      expect(readCicd()).toBe(INITIAL_CICD);
    });
  });

  describe('cancel when the rollback itself fails', () => {
    it('still reports the cancellation and tells the user to check the file', async () => {
      const controller = new AbortController();
      const result = await service.deploy(makeOptions(), undefined, {
        signal: controller.signal,
        onStep: (e) => {
          if (e.step === 'write' && e.status === 'done') {
            // A stale lock makes `git checkout HEAD -- <file>` (the rollback) fail
            fs.writeFileSync(path.join(workDir, '.git', 'index.lock'), '');
            controller.abort();
          }
        },
      });
      expect(result.cancelled).toBe(true);
      expect(joined(result.logs)).toContain('Rollback failed');
      expect(readCicd()).not.toBe(INITIAL_CICD); // the entry was written and could not be restored
    });
  });

  describe('cancel after the point of no return', () => {
    it('ignores an abort that arrives once the commit started: commit and push complete', async () => {
      const controller = new AbortController();
      const headBefore = git(workDir, 'rev-parse', 'HEAD');
      const result = await service.deploy(makeOptions(), undefined, {
        signal: controller.signal,
        onStep: (e) => {
          if (e.step === 'commit' && e.status === 'running') controller.abort();
        },
      });
      expect(result.success).toBe(true);
      expect(result.cancelled).toBeUndefined();
      expect(git(remoteDir, 'rev-parse', 'main')).not.toBe(headBefore);
      expect(git(remoteDir, 'log', '-1', '--format=%s', 'main')).toBe('deploy: dev, api');
    });
  });

  describe('cancel while git pull is running', () => {
    let hangingServer: net.Server;
    const sockets = new Set<net.Socket>();

    beforeEach(async () => {
      // Accepts connections and never answers, so `git pull` blocks on the network until it is killed
      hangingServer = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    });

    it('kills the pull, waits for it to exit, and leaves the repo usable', async () => {
      const { port } = hangingServer.address() as net.AddressInfo;
      git(workDir, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/repo.git`);
      const controller = new AbortController();
      const events: string[] = [];
      const headBefore = git(workDir, 'rev-parse', 'HEAD');
      const startedAt = Date.now();

      const result = await service.deploy(makeOptions(), undefined, {
        signal: controller.signal,
        onStep: (e) => {
          events.push(`${e.step}:${e.status}`);
          // Give git time to really connect, then cancel while it is blocked
          if (e.step === 'pull' && e.status === 'running') setTimeout(() => controller.abort(), 1500);
        },
      });

      expect(Date.now() - startedAt).toBeLessThan(25_000); // not the 5 minute git timeout
      expect(result.cancelled).toBe(true);
      expect(events.at(-1)).toBe('pull:cancelled');
      expect(joined(result.logs)).toContain('⛔ git pull interrupted');
      expect(joined(result.logs)).not.toContain('Pull failed. Common causes');
      expect(joined(result.logs)).not.toContain('Error running: git pull');
      // Nothing was written, committed or left locked
      expect(fs.existsSync(path.join(workDir, '.git', 'index.lock'))).toBe(false);
      expect(git(workDir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(readCicd()).toBe(INITIAL_CICD);
      expect(git(workDir, 'status', '--porcelain')).toBe('');
    });
  });
});
