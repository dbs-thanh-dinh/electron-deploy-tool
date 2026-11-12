import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectDefaults, saveConfigToFile, validateConfig, writeFileAtomic } from '../src/main/config-utils';
import { ProjectI } from '../src/main/interface';

function validProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Pass',
    repoPath: 'C:\\repo\\pass',
    envs: ['dev', 'stage'],
    deployTypes: ['api', 'all'],
    branchFilter: '',
    commitFormat: 'v1',
    commitTemplate: 'deploy: {env}, {type}',
    fileContentFormat: 'default',
    fileContentTemplate: 'deploy: {env}, {type}',
    smartAppend: false,
    cicdFileName: 'CICD.txt',
    ...overrides,
  };
}

const config = (...projects: Record<string, unknown>[]) => ({ projects });

describe('applyProjectDefaults', () => {
  it('fills every missing field', () => {
    const project = applyProjectDefaults({ name: 'p', repoPath: 'r', envs: ['dev'], deployTypes: ['api'] } as ProjectI);

    expect(project).toMatchObject({
      branchFilter: '',
      commitFormat: 'v1',
      commitTemplate: 'deploy: {env}, {type}',
      fileContentFormat: 'default',
      fileContentTemplate: 'deploy: {env}, {type}',
      smartAppend: false,
      cicdFileName: 'CICD.txt',
    });
  });

  it('defaults fileContentTemplate to the (possibly custom) commitTemplate', () => {
    const project = applyProjectDefaults({ commitTemplate: 'release {env}' } as ProjectI);

    expect(project.fileContentTemplate).toBe('release {env}');
  });

  it('keeps existing values, including smartAppend true, and extra fields', () => {
    const input = { commitTemplate: 'x', smartAppend: true, cicdFileName: 'ci.txt', commitPrefix: 'p' } as unknown as ProjectI;

    const project = applyProjectDefaults(input) as ProjectI & { commitPrefix: string };

    expect(project.smartAppend).toBe(true);
    expect(project.cicdFileName).toBe('ci.txt');
    expect(project.commitPrefix).toBe('p');
  });
});

describe('validateConfig', () => {
  it('accepts a valid config and an empty project list', () => {
    expect(validateConfig(config(validProject()))).toBeNull();
    expect(validateConfig({ projects: [] })).toBeNull();
  });

  it('accepts extra fields such as commitPrefix', () => {
    expect(validateConfig(config(validProject({ commitPrefix: '' })))).toBeNull();
  });

  it('accepts a project that only has the required fields', () => {
    expect(validateConfig(config({ name: 'p', repoPath: 'r', envs: ['dev'], deployTypes: ['api'] }))).toBeNull();
  });

  it.each([null, undefined, 'text', 42, [], {}, { projects: 'x' }, { projects: {} }])('rejects a non-config value %j', (value) => {
    expect(validateConfig(value)).not.toBeNull();
  });

  it('rejects a non-object project', () => {
    expect(validateConfig({ projects: [null] })).toBe('projects[0]: must be an object');
    expect(validateConfig({ projects: [[]] })).toBe('projects[0]: must be an object');
  });

  it('points at the offending project and field', () => {
    const result = validateConfig(config(validProject(), validProject({ name: 'Token', envs: [] })));

    expect(result).toBe('projects[1] ("Token").envs: must be a non-empty array of non-empty strings');
  });

  it.each([
    ['name', ''],
    ['name', '   '],
    ['name', 5],
    ['repoPath', ''],
    ['repoPath', undefined],
    ['envs', 'dev'],
    ['envs', []],
    ['envs', ['dev', '']],
    ['envs', ['dev', 1]],
    ['deployTypes', []],
    ['deployTypes', [null]],
    ['cicdFileName', 123],
    ['commitTemplate', {}],
    ['branchFilter', false],
    ['smartAppend', 'true'],
  ])('rejects %s = %j', (field, value) => {
    expect(validateConfig(config(validProject({ [field]: value })))).toContain(`.${field}:`);
  });

  it('rejects duplicate project names (exact match)', () => {
    expect(validateConfig(config(validProject(), validProject()))).toBe('projects[1] ("Pass").name: duplicate project name');
    expect(validateConfig(config(validProject(), validProject({ name: 'pass' })))).toBeNull();
  });
});

describe('writeFileAtomic', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-utils-test-'));
    target = path.join(dir, 'scripts.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('creates the file and leaves no temp file behind', async () => {
    await writeFileAtomic(target, '{"projects":[]}');

    expect(fs.readFileSync(target, 'utf8')).toBe('{"projects":[]}');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('replaces an existing file', async () => {
    fs.writeFileSync(target, 'old');

    await writeFileAtomic(target, 'new');

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('keeps the old file and removes the temp file when rename fails for good', async () => {
    fs.writeFileSync(target, 'old');
    const error = Object.assign(new Error('boom'), { code: 'EIO' });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw error;
    });

    await expect(writeFileAtomic(target, 'new')).rejects.toBe(error);

    expect(rename).toHaveBeenCalledTimes(1); // EIO is not retryable
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('retries a locked target (EPERM) and then succeeds', async () => {
    fs.writeFileSync(target, 'old');
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      realRename(from, to);
    });

    await writeFileAtomic(target, 'new', { retryDelayMs: 1 });

    expect(calls).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('gives up after the retry limit and keeps the old file', async () => {
    fs.writeFileSync(target, 'old');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });

    await expect(writeFileAtomic(target, 'new', { retries: 3, retryDelayMs: 1 })).rejects.toThrow('locked');

    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });
});

describe('writeFileAtomic failures before rename', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-utils-test-'));
    target = path.join(dir, 'scripts.json');
    fs.writeFileSync(target, 'old');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('removes the temp file and keeps the old file when fsync throws', async () => {
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('disk full');

    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('removes the temp file and keeps the old file when the write throws', async () => {
    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('write failed');
    });

    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('write failed');

    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });
});

describe('saveConfigToFile', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-utils-test-'));
    target = path.join(dir, 'scripts.json');
    fs.writeFileSync(target, 'old');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes pretty JSON and keeps extra fields', async () => {
    const cfg = config(validProject({ commitPrefix: 'x' }));

    expect(await saveConfigToFile(target, cfg)).toEqual({ success: true });

    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(cfg, null, 2));
  });

  it('does not touch the file when validation fails', async () => {
    const result = await saveConfigToFile(target, config(validProject({ envs: [] })));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid config: projects[0] ("Pass").envs: must be a non-empty array of non-empty strings');
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['scripts.json']);
  });

  it('returns the write error instead of throwing', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    });

    const result = await saveConfigToFile(target, config(validProject()));

    expect(result).toEqual({ success: false, error: 'read-only' });
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
  });
});
