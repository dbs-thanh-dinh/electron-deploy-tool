import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployOptions, DeployService } from '../src/main/deploy-service';
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
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
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
      fs.writeFileSync(path.join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n');

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
      expect(joined(result.logs)).toContain('may have diverged');
    });
  });
});
