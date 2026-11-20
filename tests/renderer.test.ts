import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The renderer is a plain script (no modules, no bundler), so the tests load the real index.html and
// renderer.ts into jsdom, stub `window.api`, and reach the script-scoped helpers through a hook object
// appended to the same eval (top-level `let`/`const` are not visible from outside otherwise).

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');

interface ProjectFixtureI {
  name: string;
  repoPath: string;
  envs: string[];
  deployTypes: string[];
  branchFilter: string;
  commitFormat: string;
  commitTemplate: string;
  fileContentFormat: string;
  fileContentTemplate: string;
  smartAppend: boolean;
  cicdFileName: string;
}

interface ConfigFixtureI {
  projects: ProjectFixtureI[];
}

interface DeployResultFixtureI {
  success: boolean;
  logs?: string[];
  error?: string;
}

interface ApiStubI {
  loadConfig: ReturnType<typeof vi.fn>;
  saveConfig: ReturnType<typeof vi.fn>;
  canDeploy: ReturnType<typeof vi.fn>;
  openDialogConfirm: ReturnType<typeof vi.fn>;
  startDeploy: ReturnType<typeof vi.fn>;
  showNotification: ReturnType<typeof vi.fn>;
  readLogFile: ReturnType<typeof vi.fn>;
  cancelDeploy: ReturnType<typeof vi.fn>;
  [key: string]: ReturnType<typeof vi.fn>;
}

interface HooksI {
  classifyLogEntry(entry: string): string;
  groupLogEntries(lines: string[]): string[];
  renderLogLines(container: HTMLElement, lines: string[]): void;
  appendLogLine(container: HTMLElement, line: string, forceNewEntry?: boolean): void;
  clearLogContainer(container: HTMLElement): void;
  getLogText(container: HTMLElement): string;
  showToast(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
  showConfirmModal(options: { title: string; message: string; confirmText?: string; danger?: boolean }): Promise<boolean>;
  deleteProject(index: number): Promise<void>;
  editProject(index: number): void;
  saveProject(): Promise<void>;
  loadDeployConfig(): Promise<void>;
  loadProjectsConfig(): Promise<void>;
  runDeploy(): Promise<void>;
  handleDeploy(): Promise<void>;
  applyDeployStep(event: { step: string; status: string }): void;
  resetDeployProgress(): void;
  handleCancelDeploy(): Promise<void>;
  isProjectDeploying(name: string): boolean;
  setActiveDeployments(value: string[]): void;
  getPendingConfigRefresh(): boolean;
  getPendingDeployConfigRefresh(): boolean;
  appendDeployLogLine(line: string): void;
  setupDeployEventListeners(): void;
  selectLogFile(filename: string): Promise<void>;
  renderProjectsList(): void;
  PROTECTED_BRANCH_RE: RegExp;
  setProjectsConfig(config: ConfigFixtureI | null): void;
  getProjectsConfig(): ConfigFixtureI | null;
  setCurrentConfig(config: ConfigFixtureI | null): void;
  setIsDeploying(value: boolean): void;
}

interface EnvI {
  window: Window & typeof globalThis;
  document: Document;
  hooks: HooksI;
  api: ApiStubI;
  timers: { fn: () => void; ms: number }[];
  run(code: string): void;
  init(): Promise<void>;
}

const HOOKS_SOURCE = `
;window.__hooks = {
  classifyLogEntry, groupLogEntries, renderLogLines, appendLogLine, clearLogContainer, getLogText,
  showToast, showConfirmModal, deleteProject, editProject, saveProject, loadDeployConfig, loadProjectsConfig,
  runDeploy, handleDeploy, appendDeployLogLine, setupDeployEventListeners, selectLogFile, renderProjectsList,
  applyDeployStep, resetDeployProgress, handleCancelDeploy, isProjectDeploying,
  PROTECTED_BRANCH_RE,
  setActiveDeployments(v) { activeDeployments = v; },
  getPendingConfigRefresh() { return pendingConfigRefresh; },
  getPendingDeployConfigRefresh() { return pendingDeployConfigRefresh; },
  setProjectsConfig(c) { projectsConfig = c; },
  getProjectsConfig() { return projectsConfig; },
  setCurrentConfig(c) { currentConfig = c; },
  setIsDeploying(v) { isDeploying = v; },
};`;

let html: string;
let rendererJs: string;
let holidayJs: string;
const openEnvs: EnvI[] = [];

afterEach(() => {
  openEnvs.splice(0).forEach((env) => env.window.close());
});

beforeAll(() => {
  html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const transpile = (file: string) =>
    ts.transpileModule(fs.readFileSync(path.join(RENDERER_DIR, 'scripts', file), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
  rendererJs = transpile('renderer.ts');
  holidayJs = transpile('holiday-theme-manager.ts');
});

const mkProject = (name: string, overrides: Partial<ProjectFixtureI> = {}): ProjectFixtureI => ({
  name,
  repoPath: 'C:/repo',
  envs: ['dev'],
  deployTypes: ['api'],
  branchFilter: '',
  commitFormat: 'v1',
  commitTemplate: 'deploy: {env}, {type}',
  fileContentFormat: 'default',
  fileContentTemplate: 'deploy: {env}, {type}',
  smartAppend: false,
  cicdFileName: 'CICD.txt',
  ...overrides,
});

const mkConfig = (...names: string[]): ConfigFixtureI => ({ projects: names.map((n) => mkProject(n)) });

async function createEnv(): Promise<EnvI> {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const window = dom.window as unknown as Window & typeof globalThis;
  // Let the initial DOMContentLoaded/load pass first so the script's own init handler never runs
  await new Promise<void>((resolve) => window.addEventListener('load', () => resolve()));

  const api: ApiStubI = {
    loadConfig: vi.fn(),
    saveConfig: vi.fn().mockResolvedValue({ success: true }),
    canDeploy: vi.fn().mockResolvedValue(true),
    openDialogConfirm: vi.fn().mockResolvedValue(true),
    startDeploy: vi.fn().mockResolvedValue({ success: true, logs: [] } as DeployResultFixtureI),
    showNotification: vi.fn(),
    readLogFile: vi.fn(),
    cancelDeploy: vi.fn().mockResolvedValue(true),
    onDeployStep: vi.fn(),
    // Wired up by the DOMContentLoaded init
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    onUpdateAvailable: vi.fn(),
    onConfigUpdated: vi.fn(),
    onDeployLog: vi.fn(),
    onDeploymentStatusChanged: vi.fn(),
    getActiveDeployments: vi.fn().mockResolvedValue([]),
    getLogFiles: vi.fn().mockResolvedValue([]),
    getLogDir: vi.fn().mockResolvedValue('C:/logs'),
    cancelGetBranches: vi.fn(),
  };
  // jsdom has no layout engine, so scrollIntoView does not exist
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const timers: { fn: () => void; ms: number }[] = [];
  Object.assign(window, {
    api,
    structuredClone,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  });
  // Run as classic scripts in one shared context, like the browser: top-level let/const/class are shared
  // between scripts, so a duplicate declaration across renderer.ts and holiday-theme-manager.ts would throw
  const context = dom.getInternalVMContext();
  const run = (code: string) => {
    new vm.Script(code).runInContext(context);
  };
  run(rendererJs + HOOKS_SOURCE);
  const hooks = (window as unknown as { __hooks: HooksI }).__hooks;
  const init = async () => {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    for (let i = 0; i < 5; i++) await flush();
  };
  const env: EnvI = { window, document: window.document, hooks, api, timers, run, init };
  openEnvs.push(env);
  return env;
}

const byId = <T extends HTMLElement>(env: EnvI, id: string): T => env.document.getElementById(id) as T;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setSelect(env: EnvI, id: string, value: string) {
  const select = byId<HTMLSelectElement>(env, id);
  select.innerHTML = '';
  const option = env.document.createElement('option');
  option.value = value;
  option.textContent = value;
  select.appendChild(option);
  select.value = value;
}

function setupDeployForm(env: EnvI, branch: string, dryRun = false) {
  env.hooks.setCurrentConfig(mkConfig('P'));
  setSelect(env, 'projectSelect', 'P');
  setSelect(env, 'branchSelect', branch);
  setSelect(env, 'envSelect', 'dev');
  setSelect(env, 'typeSelect', 'api');
  byId<HTMLInputElement>(env, 'dryRunCheck').checked = dryRun;
}

const toasts = (env: EnvI, selector = '.toast') => Array.from(env.document.querySelectorAll(selector));
const lastToast = (env: EnvI) => toasts(env).at(-1) as HTMLElement | undefined;
const logClasses = (env: EnvI, id: string) =>
  Array.from(env.document.querySelectorAll(`#${id} .log-line`)).map((el) => el.className);

describe('classifyLogEntry', () => {
  it.each([
    ['[2026-11-20 10:00:00] ❌ Deploy failed: boom', 'log-error'],
    ['[2026-11-20 10:00:00] Error: something', 'log-error'],
    ['[2026-11-20 10:00:00] fatal: not a git repository', 'log-error'],
    ['[2026-11-20 10:00:00] ⚠️ Running in DRY-RUN mode', 'log-warn'],
    ['[2026-11-20 10:00:00] ⚠ Local changes were stashed', 'log-warn'],
    ['[2026-11-20 10:00:00] ↩️ Rolling back CICD.txt', 'log-warn'],
    ['[2026-11-20 10:00:00] ⛔ Deploy cancelled by user', 'log-warn'],
    ['[2026-11-20 10:00:00] ✅ SUCCESS: Deploy completed!', 'log-success'],
    ['[2026-11-20 10:00:00] ✓ Rolled back CICD.txt', 'log-success'],
    ['[2026-11-20 10:00:00] $ git pull --ff-only', 'log-cmd'],
    ['[2026-11-20 10:00:00] ℹ️ Pull failed', 'log-info'],
    ['[2026-11-20 10:00:00] DRY-RUN: Skipping push step', 'log-info'],
    ['[2026-11-20 10:00:00] 🚀 Starting deploy', 'log-head'],
    ['[2026-11-20 10:00:00] =========================', 'log-head'],
    ['[2026-11-20 10:00:00] Repo path: C:/repo', ''],
    ['no timestamp ✅ not a marker at start', ''],
    ['✅ marker without timestamp', 'log-success'],
    ['', ''],
  ])('%s -> %s', async (entry, expected) => {
    const env = await createEnv();
    expect(env.hooks.classifyLogEntry(entry)).toBe(expected);
  });
});

describe('log rendering', () => {
  it('groupLogEntries merges lines without a timestamp into the previous entry', async () => {
    const env = await createEnv();
    expect(
      env.hooks.groupLogEntries(['[2026-11-20 10:00:00] a', 'continued', 'more', '[2026-11-20 10:00:01] b']),
    ).toEqual(['[2026-11-20 10:00:00] a\ncontinued\nmore', '[2026-11-20 10:00:01] b']);
  });

  it('groupLogEntries keeps a leading line without a timestamp as its own entry', async () => {
    const env = await createEnv();
    expect(env.hooks.groupLogEntries(['orphan', '[2026-11-20 10:00:00] a'])).toEqual(['orphan', '[2026-11-20 10:00:00] a']);
    expect(env.hooks.groupLogEntries([])).toEqual([]);
  });

  it('renderLogLines renders one coloured div per entry and replaces old content', async () => {
    const env = await createEnv();
    const container = byId(env, 'deployLog');
    env.hooks.renderLogLines(container, ['[2026-11-20 10:00:00] old']);
    env.hooks.renderLogLines(container, [
      '[2026-11-20 10:00:00] ❌ failed',
      'fatal: detail line',
      '[2026-11-20 10:00:01] ✅ ok',
      '[2026-11-20 10:00:02] ',
    ]);
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-error', 'log-line log-success', 'log-line']);
    expect(container.children[0].textContent).toBe('[2026-11-20 10:00:00] ❌ failed\nfatal: detail line');
  });

  it('renders content as text, never as HTML', async () => {
    const env = await createEnv();
    const container = byId(env, 'deployLog');
    env.hooks.renderLogLines(container, ['[2026-11-20 10:00:00] <img src=x onerror=alert(1)>']);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('getLogText joins the plain-text entries with newlines (so Copy keeps line breaks)', async () => {
    const env = await createEnv();
    const container = byId(env, 'deployLog');
    env.hooks.renderLogLines(container, ['[2026-11-20 10:00:00] a', 'cont', '[2026-11-20 10:00:01] b']);
    expect(env.hooks.getLogText(container)).toBe('[2026-11-20 10:00:00] a\ncont\n[2026-11-20 10:00:01] b');
    expect(env.hooks.getLogText(byId(env, 'logContent'))).toBe('');
  });

  it('appendLogLine adds new entries, merges timestamp-less lines, and forceNewEntry overrides merging', async () => {
    const env = await createEnv();
    const container = byId(env, 'deployLog');
    env.hooks.appendLogLine(container, 'first without timestamp'); // nothing to merge into
    env.hooks.appendLogLine(container, '[2026-11-20 10:00:00] ❌ boom');
    env.hooks.appendLogLine(container, 'extra detail');
    env.hooks.appendLogLine(container, 'Error: forced', true);
    expect(container.children).toHaveLength(3); // first, merged boom+detail, forced
    expect(container.children[1].textContent).toBe('[2026-11-20 10:00:00] ❌ boom\nextra detail');
    expect(container.children[1].className).toContain('log-error');
    expect(container.children[2].className).toContain('log-error');
    expect(env.hooks.getLogText(container)).toBe(
      'first without timestamp\n[2026-11-20 10:00:00] ❌ boom\nextra detail\nError: forced',
    );
  });

  it('clearLogContainer empties the DOM and the plain-text source', async () => {
    const env = await createEnv();
    const container = byId(env, 'deployLog');
    env.hooks.renderLogLines(container, ['[2026-11-20 10:00:00] a']);
    env.hooks.clearLogContainer(container);
    expect(container.children).toHaveLength(0);
    expect(env.hooks.getLogText(container)).toBe('');
    env.hooks.appendLogLine(container, '[2026-11-20 10:00:01] b'); // still usable afterwards
    expect(env.hooks.getLogText(container)).toBe('[2026-11-20 10:00:01] b');
  });

  describe('auto-scroll', () => {
    const withLayout = (el: HTMLElement, scrollTop: number) => {
      let top = scrollTop;
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    };

    it('follows new lines when the user is near the bottom', async () => {
      const env = await createEnv();
      const container = byId(env, 'deployLog');
      withLayout(container, 890); // 1000 - 890 - 100 = 10px from the bottom
      env.hooks.appendLogLine(container, '[2026-11-20 10:00:00] a');
      expect(container.scrollTop).toBe(1000);
    });

    it('does not jump when the user scrolled up', async () => {
      const env = await createEnv();
      const container = byId(env, 'deployLog');
      withLayout(container, 100); // 800px from the bottom
      env.hooks.appendLogLine(container, '[2026-11-20 10:00:00] a');
      expect(container.scrollTop).toBe(100);
    });

    it('renderLogLines scrolls to the bottom', async () => {
      const env = await createEnv();
      const container = byId(env, 'deployLog');
      withLayout(container, 0);
      env.hooks.renderLogLines(container, ['[2026-11-20 10:00:00] a']);
      expect(container.scrollTop).toBe(1000);
    });
  });
});

describe('showToast', () => {
  it.each([
    ['info', 4000, 'status'],
    ['success', 4000, 'status'],
    ['warning', 8000, 'status'],
    ['error', 12000, 'alert'],
  ] as const)('%s toast: class, role and %ims lifetime', async (type, ms, role) => {
    const env = await createEnv();
    env.hooks.showToast('hello', type);
    const toast = lastToast(env)!;
    expect(toast.className).toBe(`toast toast-${type}`);
    expect(toast.getAttribute('role')).toBe(role);
    expect(toast.querySelector('.toast-message')!.textContent).toBe('hello');
    expect(env.timers.map((t) => t.ms)).toEqual([ms]);
    env.timers[0].fn();
    expect(toasts(env)).toHaveLength(0);
  });

  it('defaults to the info type', async () => {
    const env = await createEnv();
    env.hooks.showToast('plain');
    expect(lastToast(env)!.className).toBe('toast toast-info');
  });

  it('close button dismisses only its own toast; later auto-dismiss is harmless', async () => {
    const env = await createEnv();
    env.hooks.showToast('one', 'error');
    env.hooks.showToast('two', 'error');
    (toasts(env)[0].querySelector('.toast-close') as HTMLButtonElement).click();
    expect(toasts(env)).toHaveLength(1);
    expect(toasts(env)[0].textContent).toContain('two');
    expect(() => env.timers[0].fn()).not.toThrow();
    expect(toasts(env)).toHaveLength(1);
  });

  it('renders the message as text, not HTML', async () => {
    const env = await createEnv();
    env.hooks.showToast('<b>bold</b>', 'info');
    expect(lastToast(env)!.querySelector('b')).toBeNull();
  });
});

describe('showConfirmModal', () => {
  const key = (env: EnvI, k: string) =>
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const open = (env: EnvI, extra: { confirmText?: string; danger?: boolean } = {}) =>
    env.hooks.showConfirmModal({ title: 'T', message: 'M', ...extra });

  it('shows title/message, defaults the label to OK, and focuses Cancel', async () => {
    const env = await createEnv();
    void open(env);
    expect(byId(env, 'confirmModal').style.display).toBe('flex');
    expect(byId(env, 'confirmModalTitle').textContent).toBe('T');
    expect(byId(env, 'confirmModalMessage').textContent).toBe('M');
    expect(byId(env, 'confirmModalOk').textContent).toBe('OK');
    expect(byId(env, 'confirmModalOk').className).toBe('btn btn-primary');
    expect(env.document.activeElement).toBe(byId(env, 'confirmModalCancel'));
  });

  it('uses the custom label and danger style', async () => {
    const env = await createEnv();
    void open(env, { confirmText: 'Delete', danger: true });
    expect(byId(env, 'confirmModalOk').textContent).toBe('Delete');
    expect(byId(env, 'confirmModalOk').className).toBe('btn btn-danger');
  });

  it('resolves true on OK and hides the modal', async () => {
    const env = await createEnv();
    const result = open(env);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await expect(result).resolves.toBe(true);
    expect(byId(env, 'confirmModal').style.display).toBe('none');
  });

  it('resolves false on Cancel', async () => {
    const env = await createEnv();
    const result = open(env);
    byId<HTMLButtonElement>(env, 'confirmModalCancel').click();
    await expect(result).resolves.toBe(false);
  });

  it('resolves false on Escape and restores the previous focus', async () => {
    const env = await createEnv();
    const trigger = byId<HTMLButtonElement>(env, 'addProjectBtn');
    trigger.focus();
    const result = open(env);
    key(env, 'Escape');
    await expect(result).resolves.toBe(false);
    expect(env.document.activeElement).toBe(trigger);
    expect(byId(env, 'confirmModal').style.display).toBe('none');
  });

  it('traps Tab between the two buttons', async () => {
    const env = await createEnv();
    void open(env);
    key(env, 'Tab');
    expect(env.document.activeElement).toBe(byId(env, 'confirmModalOk'));
    key(env, 'Tab');
    expect(env.document.activeElement).toBe(byId(env, 'confirmModalCancel'));
  });

  it('ignores unrelated keys', async () => {
    const env = await createEnv();
    void open(env);
    key(env, 'a');
    expect(byId(env, 'confirmModal').style.display).toBe('flex');
  });

  it('a newer modal resolves the older one as false and only the newer one answers OK', async () => {
    const env = await createEnv();
    const first = open(env);
    const second = open(env);
    await expect(first).resolves.toBe(false);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await expect(second).resolves.toBe(true);
  });

  it('removes its listeners: a later modal is not closed by a stale Escape/OK handler', async () => {
    const env = await createEnv();
    const first = open(env);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await first;
    const second = open(env);
    byId<HTMLButtonElement>(env, 'confirmModalCancel').click();
    await expect(second).resolves.toBe(false);
    key(env, 'Escape'); // no modal open: must not throw
    expect(byId(env, 'confirmModal').style.display).toBe('none');
  });
});

describe('deleteProject', () => {
  const names = (env: EnvI) => env.hooks.getProjectsConfig()!.projects.map((p) => p.name);
  const savedNames = (env: EnvI) => (env.api.saveConfig.mock.calls[0][0] as ConfigFixtureI).projects.map((p) => p.name);

  it('deletes the confirmed project, saves and re-renders', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B', 'C'));
    const done = env.hooks.deleteProject(1);
    expect(byId(env, 'confirmModalMessage').textContent).toContain('"B"');
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(savedNames(env)).toEqual(['A', 'C']);
    expect(env.document.querySelectorAll('#projectsList .project-card')).toHaveLength(2);
  });

  it('does nothing when cancelled', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    const done = env.hooks.deleteProject(0);
    byId<HTMLButtonElement>(env, 'confirmModalCancel').click();
    await done;
    expect(env.api.saveConfig).not.toHaveBeenCalled();
    expect(names(env)).toEqual(['A', 'B']);
  });

  it('re-locates by name when another window reordered the config while the modal was open', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B', 'C'));
    const done = env.hooks.deleteProject(1); // "B"
    env.hooks.setProjectsConfig(mkConfig('B', 'C', 'D')); // another window deleted A and added D
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(savedNames(env)).toEqual(['C', 'D']); // B removed, not the project now at index 1
  });

  it('warns and does not save when the project was already removed elsewhere', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    const done = env.hooks.deleteProject(1);
    env.hooks.setProjectsConfig(mkConfig('A'));
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(env.api.saveConfig).not.toHaveBeenCalled();
    expect(lastToast(env)!.className).toContain('toast-warning');
    expect(lastToast(env)!.textContent).toContain('"B" no longer exists');
    expect(names(env)).toEqual(['A']);
  });

  it('warns when the config is gone entirely', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    const done = env.hooks.deleteProject(0);
    env.hooks.setProjectsConfig(null);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(env.api.saveConfig).not.toHaveBeenCalled();
    expect(lastToast(env)!.textContent).toContain('no longer exists');
  });

  it('rolls the in-memory list back and reports when saving is rejected', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.api.saveConfig.mockResolvedValue({ success: false, error: 'invalid' });
    const done = env.hooks.deleteProject(0);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(names(env)).toEqual(['A', 'B']);
    expect(lastToast(env)!.className).toContain('toast-error');
    expect(lastToast(env)!.textContent).toContain('Failed to save config: invalid');
  });

  it('rolls back and reports when saving throws', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.api.saveConfig.mockRejectedValue(new Error('disk full'));
    const done = env.hooks.deleteProject(1);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(names(env)).toEqual(['A', 'B']);
    expect(lastToast(env)!.textContent).toContain('Error saving config: disk full');
  });

  it('closes an open edit form before deleting', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.editProject(0);
    expect(byId(env, 'projectFormContainer').style.display).toBe('block');
    const done = env.hooks.deleteProject(1);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(byId(env, 'projectFormContainer').style.display).toBe('none');
  });
});

describe('saveProject validation and feedback', () => {
  const fill = (env: EnvI, values: Record<string, string>) => {
    const defaults: Record<string, string> = {
      projectName: 'New',
      repoPath: 'C:/repo',
      envs: 'dev, stage',
      deployTypes: 'api',
      projectCICDFileName: 'CICD.txt',
    };
    Object.entries({ ...defaults, ...values }).forEach(([id, value]) => {
      byId<HTMLInputElement>(env, id).value = value;
    });
  };

  it('reports when the config is not loaded', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(null);
    await env.hooks.saveProject();
    expect(lastToast(env)!.className).toContain('toast-error');
    expect(lastToast(env)!.textContent).toContain('Configuration is not loaded');
  });

  it.each([['projectName'], ['repoPath'], ['envs'], ['deployTypes'], ['projectCICDFileName']])(
    'requires %s',
    async (field) => {
      const env = await createEnv();
      env.hooks.setProjectsConfig(mkConfig('A'));
      fill(env, { [field]: '' });
      await env.hooks.saveProject();
      expect(lastToast(env)!.className).toContain('toast-warning');
      expect(lastToast(env)!.querySelector('.toast-message')!.textContent).toBe('All fields are required');
      expect(env.api.saveConfig).not.toHaveBeenCalled();
    },
  );

  it('requires a template when the commit format is custom', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    fill(env, {});
    setSelect(env, 'projectCommitFormat', 'custom');
    byId<HTMLInputElement>(env, 'projectCommitTemplate').value = '';
    await env.hooks.saveProject();
    expect(lastToast(env)!.textContent).toContain('All fields are required');
  });

  it('requires at least one real environment and type (not just commas)', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    fill(env, { envs: ' , ' });
    await env.hooks.saveProject();
    expect(lastToast(env)!.textContent).toContain('at least one environment and one deploy type');
    expect(env.api.saveConfig).not.toHaveBeenCalled();
  });

  it('rejects a duplicate name', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    fill(env, { projectName: 'A' });
    await env.hooks.saveProject();
    expect(lastToast(env)!.textContent).toContain('Project with name "A" already exists');
    expect(env.api.saveConfig).not.toHaveBeenCalled();
  });

  it('saves a valid new project and hides the form', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    fill(env, {});
    await env.hooks.saveProject();
    const saved = env.api.saveConfig.mock.calls[0][0] as ConfigFixtureI;
    expect(saved.projects.map((p) => p.name)).toEqual(['A', 'New']);
    expect(saved.projects[1].envs).toEqual(['dev', 'stage']);
    expect(byId(env, 'projectFormContainer').style.display).toBe('none');
  });

  it('keeps the form open and restores the list when saving fails', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A'));
    env.api.saveConfig.mockResolvedValue({ success: false, error: 'projects[1] invalid' });
    byId(env, 'projectFormContainer').style.display = 'block';
    fill(env, {});
    await env.hooks.saveProject();
    expect(env.hooks.getProjectsConfig()!.projects.map((p) => p.name)).toEqual(['A']);
    expect(byId(env, 'projectFormContainer').style.display).toBe('block');
    expect(lastToast(env)!.textContent).toContain('Failed to save config: projects[1] invalid');
  });
});

describe('config loading errors', () => {
  it('loadDeployConfig shows the config error as a toast', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue({ error: 'bad json' });
    await env.hooks.loadDeployConfig();
    expect(lastToast(env)!.className).toContain('toast-error');
    expect(lastToast(env)!.textContent).toContain('Failed to load configuration: bad json');
  });

  it('loadDeployConfig toasts when loading throws', async () => {
    const env = await createEnv();
    vi.spyOn(env.window.console, 'error').mockImplementation(() => undefined);
    env.api.loadConfig.mockRejectedValue(new Error('ipc'));
    await env.hooks.loadDeployConfig();
    expect(lastToast(env)!.textContent).toContain('Failed to load configuration');
  });

  it('loadDeployConfig populates the project list on success', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('A', 'B'));
    await env.hooks.loadDeployConfig();
    expect(toasts(env)).toHaveLength(0);
    expect(Array.from(byId<HTMLSelectElement>(env, 'projectSelect').options).map((o) => o.value)).toEqual(['', 'A', 'B']);
  });

  it('loadProjectsConfig only logs a config error (no duplicate toast) but toasts when loading throws', async () => {
    const env = await createEnv();
    vi.spyOn(env.window.console, 'error').mockImplementation(() => undefined);
    env.api.loadConfig.mockResolvedValue({ error: 'bad json' });
    await env.hooks.loadProjectsConfig();
    expect(toasts(env)).toHaveLength(0);
    expect(env.hooks.getProjectsConfig()).toBeNull();

    env.api.loadConfig.mockRejectedValue(new Error('ipc'));
    await env.hooks.loadProjectsConfig();
    expect(lastToast(env)!.textContent).toContain('Failed to load configuration');
  });
});

describe('runDeploy', () => {
  const dialogDetail = (env: EnvI) => (env.api.openDialogConfirm.mock.calls[0][0] as { detail: string }).detail;

  it.each(['main', 'master', 'stage', 'Staging', 'prod', 'PRODUCTION'])(
    'warns before deploying to protected branch %s',
    async (branch) => {
      const env = await createEnv();
      setupDeployForm(env, branch);
      await env.hooks.runDeploy();
      expect(dialogDetail(env)).toContain(`"${branch}" is a protected/shared branch`);
    },
  );

  it.each(['feature/main', 'maintenance', 'develop', 'release/1.0'])('does not warn for branch %s', async (branch) => {
    const env = await createEnv();
    setupDeployForm(env, branch);
    await env.hooks.runDeploy();
    expect(dialogDetail(env)).toBe(`Branch: ${branch}`);
  });

  it('mentions dry run in the confirmation and passes the flag on', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop', true);
    await env.hooks.runDeploy();
    expect(dialogDetail(env)).toContain('DRY RUN (no push)');
    expect((env.api.startDeploy.mock.calls[0][0] as { dryRun: boolean }).dryRun).toBe(true);
  });

  it('does not deploy when another window already deploys the project', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.canDeploy.mockResolvedValue(false);
    await env.hooks.runDeploy();
    expect(env.api.openDialogConfirm).not.toHaveBeenCalled();
    expect(env.api.startDeploy).not.toHaveBeenCalled();
    expect(lastToast(env)!.className).toContain('toast-warning');
    expect(lastToast(env)!.textContent).toContain('Project P is already being deployed');
  });

  it('does not deploy when the project vanished from the config', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.hooks.setCurrentConfig(mkConfig('Other'));
    await env.hooks.runDeploy();
    expect(env.api.openDialogConfirm).not.toHaveBeenCalled();
    expect(env.api.startDeploy).not.toHaveBeenCalled();
  });

  it('does not deploy when the user declines the confirmation', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.openDialogConfirm.mockResolvedValue(false);
    await env.hooks.runDeploy();
    expect(env.api.startDeploy).not.toHaveBeenCalled();
    expect(byId(env, 'deployProgress').style.display).toBe('none'); // the stepper only appears once the deploy starts
  });

  it('renders the final log with colours and notifies on success', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.startDeploy.mockResolvedValue({
      success: true,
      logs: ['[2026-11-20 10:00:00] $ git push', '[2026-11-20 10:00:01] ✅ SUCCESS: Deploy completed!'],
    });
    await env.hooks.runDeploy();
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-cmd', 'log-line log-success']);
    expect(env.api.showNotification).toHaveBeenCalledWith('Deploy Completed', 'P deployed successfully to dev');
    expect(byId(env, 'cancelDeployBtn').style.display).toBe('none');
  });

  it('notifies a cancellation (and not a failure) when the result says cancelled', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.startDeploy.mockResolvedValue({
      success: false,
      cancelled: true,
      error: 'Deploy cancelled by user',
      logs: ['[2026-11-20 10:00:00] ⛔ Deploy cancelled by user'],
    });
    await env.hooks.runDeploy();
    expect(env.api.showNotification).toHaveBeenCalledTimes(1);
    expect(env.api.showNotification.mock.calls[0][0]).toBe('Deploy Cancelled');
    // Not every cancel rolls anything back (e.g. before the CICD file was written), so no claim about the file
    expect(env.api.showNotification.mock.calls[0][1]).toBe('P deploy was cancelled');
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-warn']);
  });

  it('decides from the result, not from a Cancel click: a cancel that came too late still reports success', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.startDeploy.mockImplementation(async () => {
      byId<HTMLButtonElement>(env, 'cancelDeployBtn').click();
      return { success: true, logs: [] };
    });
    env.api.cancelDeploy.mockResolvedValue(false);
    env.hooks.setupDeployEventListeners();
    await env.hooks.runDeploy();
    expect(env.api.cancelDeploy).toHaveBeenCalledTimes(1); // the click really happened mid-deploy
    expect(env.api.showNotification).toHaveBeenCalledTimes(1);
    expect(env.api.showNotification).toHaveBeenCalledWith('Deploy Completed', 'P deployed successfully to dev');
  });

  it('shows the stepper reset to pending when the deploy starts and keeps it visible afterwards', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    let during: string[] = [];
    env.api.startDeploy.mockImplementation(async () => {
      during = Array.from(env.document.querySelectorAll<HTMLElement>('.deploy-step')).map((el) => el.dataset.status!);
      expect(byId(env, 'deployProgress').style.display).toBe('block');
      expect(byId(env, 'cancelDeployBtn').style.display).toBe('');
      return { success: true, logs: [] };
    });
    // stale state from a previous deploy must not leak into the new one
    env.hooks.applyDeployStep({ step: 'stash', status: 'done' });
    await env.hooks.runDeploy();
    expect(during).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(byId(env, 'deployProgress').style.display).toBe('block');
  });

  it('moves a step left "running" to failed when startDeploy throws, and to cancelled when the result is cancelled', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.hooks.setIsDeploying(true);
    const stepStatuses = () =>
      Array.from(env.document.querySelectorAll<HTMLElement>('.deploy-step')).map((el) => `${el.dataset.step}:${el.dataset.status}`);

    env.api.startDeploy.mockImplementation(async () => {
      env.hooks.applyDeployStep({ step: 'stash', status: 'done' });
      env.hooks.applyDeployStep({ step: 'pull', status: 'running' });
      throw new Error('ipc down');
    });
    await env.hooks.runDeploy();
    expect(stepStatuses()).toEqual(['stash:done', 'checkout:pending', 'pull:failed', 'write:pending', 'commit:pending', 'push:pending']);

    env.api.startDeploy.mockImplementation(async () => {
      env.hooks.applyDeployStep({ step: 'pull', status: 'running' });
      return { success: false, cancelled: true, error: 'Deploy cancelled by user', logs: [] };
    });
    await env.hooks.runDeploy();
    expect(stepStatuses()[2]).toBe('pull:cancelled');
  });

  it('notifies with the error when the deploy fails', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.startDeploy.mockResolvedValue({ success: false, error: 'push rejected', logs: ['[2026-11-20 10:00:00] ❌ Deploy failed'] });
    await env.hooks.runDeploy();
    expect(env.api.showNotification).toHaveBeenCalledWith('Deploy Failed', 'push rejected');
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-error']);
  });

  it('falls back to a generic message when a failure has no error text', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.startDeploy.mockResolvedValue({ success: false });
    await env.hooks.runDeploy();
    expect(env.api.showNotification).toHaveBeenCalledWith('Deploy Failed', 'Unknown error occurred');
  });

  it('keeps coloured log lines and appends a separate error entry when startDeploy throws', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.hooks.setIsDeploying(true);
    env.hooks.appendDeployLogLine('[2026-11-20 10:00:00] 🚀 Starting deploy'); // streamed before the throw
    env.api.startDeploy.mockImplementation(async () => {
      env.hooks.appendDeployLogLine('[2026-11-20 10:00:01] $ git pull');
      throw new Error('boom');
    });
    await env.hooks.runDeploy();
    // runDeploy clears the log at start, so only lines streamed during startDeploy remain, plus the error entry
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-cmd', 'log-line log-error']);
    expect(byId(env, 'deployLog').lastElementChild!.textContent).toBe('Error: boom');
    expect(env.api.showNotification).toHaveBeenCalledWith('Deploy Error', 'boom');
    expect(byId(env, 'cancelDeployBtn').style.display).toBe('none');
    expect(byId<HTMLSelectElement>(env, 'projectSelect').disabled).toBe(false);
  });
});

describe('appendDeployLogLine', () => {
  it('ignores lines when this window is not deploying', async () => {
    const env = await createEnv();
    env.hooks.appendDeployLogLine('[2026-11-20 10:00:00] ❌ nope');
    expect(byId(env, 'deployLog').children).toHaveLength(0);
  });

  it('appends coloured lines while deploying', async () => {
    const env = await createEnv();
    env.hooks.setIsDeploying(true);
    env.hooks.appendDeployLogLine('[2026-11-20 10:00:00] ✅ done');
    expect(logClasses(env, 'deployLog')).toEqual(['log-line log-success']);
  });

  it('there is no blocking overlay any more', async () => {
    const env = await createEnv();
    expect(env.document.getElementById('loadingOverlay')).toBeNull();
  });
});

describe('deploy stepper and cancel', () => {
  const statuses = (env: EnvI) =>
    Object.fromEntries(Array.from(env.document.querySelectorAll<HTMLElement>('.deploy-step')).map((el) => [el.dataset.step, el.dataset.status]));

  it('lists the six steps in order', async () => {
    const env = await createEnv();
    expect(Array.from(env.document.querySelectorAll<HTMLElement>('.deploy-step')).map((el) => el.dataset.step)).toEqual([
      'stash', 'checkout', 'pull', 'write', 'commit', 'push',
    ]);
  });

  it('applies step events only while this window is deploying', async () => {
    const env = await createEnv();
    env.hooks.applyDeployStep({ step: 'stash', status: 'running' });
    expect(statuses(env).stash).toBe('pending');
    env.hooks.setIsDeploying(true);
    env.hooks.applyDeployStep({ step: 'stash', status: 'running' });
    env.hooks.applyDeployStep({ step: 'stash', status: 'done' });
    env.hooks.applyDeployStep({ step: 'checkout', status: 'skipped' });
    expect(statuses(env)).toMatchObject({ stash: 'done', checkout: 'skipped', pull: 'pending' });
  });

  it('ignores an unknown step name without throwing', async () => {
    const env = await createEnv();
    env.hooks.setIsDeploying(true);
    expect(() => env.hooks.applyDeployStep({ step: '"] , x[', status: 'done' })).not.toThrow();
    expect(Object.values(statuses(env)).every((v) => v === 'pending')).toBe(true);
  });

  it('locks the Cancel button and explains why once the commit starts', async () => {
    const env = await createEnv();
    env.hooks.setIsDeploying(true);
    env.hooks.resetDeployProgress();
    expect(byId<HTMLButtonElement>(env, 'cancelDeployBtn').disabled).toBe(false);
    env.hooks.applyDeployStep({ step: 'write', status: 'done' });
    expect(byId<HTMLButtonElement>(env, 'cancelDeployBtn').disabled).toBe(false);
    env.hooks.applyDeployStep({ step: 'commit', status: 'running' });
    expect(byId<HTMLButtonElement>(env, 'cancelDeployBtn').disabled).toBe(true);
    expect(byId(env, 'cancelDeployHint').textContent).toContain('can no longer cancel');
  });

  it('Cancel asks main to cancel and shows a pending state', async () => {
    const env = await createEnv();
    env.hooks.setupDeployEventListeners();
    env.hooks.setIsDeploying(true);
    env.hooks.resetDeployProgress();
    byId<HTMLButtonElement>(env, 'cancelDeployBtn').click();
    await flush();
    expect(env.api.cancelDeploy).toHaveBeenCalledTimes(1);
    expect(byId<HTMLButtonElement>(env, 'cancelDeployBtn').disabled).toBe(true);
    expect(byId(env, 'cancelDeployBtn').textContent).toBe('Cancelling...');
    expect(byId(env, 'cancelDeployHint').textContent).toContain('current git command');
  });

  it('warns "too late" when main refuses to cancel', async () => {
    const env = await createEnv();
    env.api.cancelDeploy.mockResolvedValue(false);
    env.hooks.setupDeployEventListeners();
    env.hooks.setIsDeploying(true);
    env.hooks.resetDeployProgress();
    byId<HTMLButtonElement>(env, 'cancelDeployBtn').click();
    await flush();
    expect(lastToast(env)!.className).toContain('toast-warning');
    expect(lastToast(env)!.textContent).toContain('Too late to cancel');
    expect(byId(env, 'cancelDeployBtn').textContent).toBe('Cancel deploy');
  });

  it('re-enables the button and reports when the cancel request itself fails', async () => {
    const env = await createEnv();
    env.api.cancelDeploy.mockRejectedValue(new Error('ipc down'));
    env.hooks.setupDeployEventListeners();
    env.hooks.setIsDeploying(true);
    env.hooks.resetDeployProgress();
    byId<HTMLButtonElement>(env, 'cancelDeployBtn').click();
    await flush();
    expect(byId<HTMLButtonElement>(env, 'cancelDeployBtn').disabled).toBe(false);
    expect(lastToast(env)!.className).toContain('toast-error');
    expect(lastToast(env)!.textContent).toContain('Failed to cancel: ipc down');
  });

  it('shows the pulsing dot on the Deploy nav item only while deploying, and registers the step listener at init', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('P'));
    await env.init();
    expect(env.api.onDeployStep).toHaveBeenCalledTimes(1);
    const nav = env.document.querySelector('.nav-item[data-page="deploy"]')!;
    setupDeployForm(env, 'develop');
    let during = false;
    env.api.startDeploy.mockImplementation(async () => {
      during = nav.classList.contains('deploying');
      return { success: true, logs: [] };
    });
    await env.hooks.handleDeploy();
    expect(during).toBe(true);
    expect(nav.classList.contains('deploying')).toBe(false);
  });
});

describe('projects being deployed are locked', () => {
  it('disables Edit and Delete only for the deploying project', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.setActiveDeployments(['B']);
    env.hooks.renderProjectsList();
    const disabled = (cls: string) => Array.from(env.document.querySelectorAll<HTMLButtonElement>(cls)).map((b) => b.disabled);
    expect(disabled('.edit-btn')).toEqual([false, true]);
    expect(disabled('.delete-btn')).toEqual([false, true]);
  });

  it('editProject and deleteProject refuse a deploying project', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.setActiveDeployments(['A']);
    env.hooks.editProject(0);
    expect(byId(env, 'projectFormContainer').style.display).not.toBe('block');
    expect(lastToast(env)!.textContent).toContain('being deployed');
    await env.hooks.deleteProject(0);
    expect(env.document.getElementById('confirmModal')!.style.display).toBe('none');
    expect(env.api.saveConfig).not.toHaveBeenCalled();
  });

  it('deleteProject aborts when the project starts deploying while the confirmation is open', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    const done = env.hooks.deleteProject(0);
    env.hooks.setActiveDeployments(['A']);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(env.api.saveConfig).not.toHaveBeenCalled();
    expect(env.hooks.getProjectsConfig()!.projects.map((p) => p.name)).toEqual(['A', 'B']);
    expect(lastToast(env)!.textContent).toContain('being deployed');
  });

  it('saveProject refuses to save the project that is being deployed (rename guard)', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.editProject(0);
    env.hooks.setActiveDeployments(['A']); // deploy started after the form was opened
    byId<HTMLInputElement>(env, 'projectName').value = 'A-renamed';
    await env.hooks.saveProject();
    expect(env.api.saveConfig).not.toHaveBeenCalled();
    expect(lastToast(env)!.textContent).toContain('being deployed');
  });

  it('a successful save while this window deploys schedules a refresh for afterwards', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.setIsDeploying(true);
    const done = env.hooks.deleteProject(1);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(env.hooks.getPendingDeployConfigRefresh()).toBe(true);
    expect(env.hooks.getPendingConfigRefresh()).toBe(false); // that one is for changes made in OTHER windows
  });

  it('after the deploy only the Deploy page is refreshed: an Edit form opened meanwhile stays open', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('A', 'B', 'C'));
    await env.init();
    env.hooks.setProjectsConfig(mkConfig('A', 'B', 'C'));
    setupDeployForm(env, 'develop');
    let release!: () => void;
    env.api.startDeploy.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ success: true, logs: [] }))));
    const deploying = env.hooks.handleDeploy();
    await flush();

    // while deploying: save a change (deleting B), then start editing C and type something
    const del = env.hooks.deleteProject(1);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await del;
    env.hooks.editProject(env.hooks.getProjectsConfig()!.projects.findIndex((p) => p.name === 'C'));
    byId<HTMLInputElement>(env, 'envs').value = 'half-typed';
    env.api.loadConfig.mockClear();

    release();
    await deploying;
    await flush();

    expect(env.api.loadConfig).toHaveBeenCalledTimes(1); // Deploy page refreshed with the saved config
    expect(byId(env, 'projectFormContainer').style.display).toBe('block');
    expect(byId<HTMLInputElement>(env, 'envs').value).toBe('half-typed');
    expect(env.hooks.getPendingDeployConfigRefresh()).toBe(false);
  });

  it('a change made in another window while deploying still refreshes everything afterwards', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('A', 'B'));
    await env.init();
    const onConfigUpdated = env.api.onConfigUpdated.mock.calls[0][0] as () => void;
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    setupDeployForm(env, 'develop');
    let release!: () => void;
    env.api.startDeploy.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ success: true, logs: [] }))));
    const deploying = env.hooks.handleDeploy();
    await flush();
    onConfigUpdated();
    expect(env.hooks.getPendingConfigRefresh()).toBe(true);
    env.hooks.editProject(0); // form open
    release();
    await deploying;
    await flush();
    expect(env.hooks.getPendingConfigRefresh()).toBe(false);
    expect(byId(env, 'projectFormContainer').style.display).toBe('none'); // old behaviour: indexes may have changed
  });

  it('does not schedule a refresh when saving while idle', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    const done = env.hooks.deleteProject(1);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await done;
    expect(env.hooks.getPendingConfigRefresh()).toBe(false);
  });

  it('re-renders the Projects list when the active deployments change', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('A', 'B'));
    await env.init();
    const onStatus = env.api.onDeploymentStatusChanged.mock.calls[0][0] as (projects: string[]) => void;
    expect(env.document.querySelectorAll<HTMLButtonElement>('.edit-btn:disabled')).toHaveLength(0);
    onStatus(['B']);
    expect(env.document.querySelectorAll<HTMLButtonElement>('.edit-btn:disabled')).toHaveLength(1);
    onStatus([]);
    expect(env.document.querySelectorAll<HTMLButtonElement>('.edit-btn:disabled')).toHaveLength(0);
  });
});

describe('deploy page controls', () => {
  it('Copy writes the plain log (with line breaks) to the clipboard and confirms', async () => {
    const env = await createEnv();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    env.hooks.setupDeployEventListeners();
    env.hooks.renderLogLines(byId(env, 'deployLog'), ['[2026-11-20 10:00:00] a', '[2026-11-20 10:00:01] b']);
    byId<HTMLButtonElement>(env, 'copyLogBtn').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('[2026-11-20 10:00:00] a\n[2026-11-20 10:00:01] b');
    expect(lastToast(env)!.className).toContain('toast-success');
  });

  it('Copy warns when the log is empty and does not touch the clipboard', async () => {
    const env = await createEnv();
    const writeText = vi.fn();
    Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    env.hooks.setupDeployEventListeners();
    byId<HTMLButtonElement>(env, 'copyLogBtn').click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(lastToast(env)!.className).toContain('toast-warning');
  });

  it('Copy reports a clipboard failure', async () => {
    const env = await createEnv();
    const writeText = vi.fn().mockRejectedValue(new Error('document not focused'));
    Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    env.hooks.setupDeployEventListeners();
    env.hooks.renderLogLines(byId(env, 'deployLog'), ['[2026-11-20 10:00:00] a']);
    byId<HTMLButtonElement>(env, 'copyLogBtn').click();
    await flush();
    expect(lastToast(env)!.className).toContain('toast-error');
    expect(lastToast(env)!.textContent).toContain('Failed to copy log: document not focused');
  });

  it('Clear empties the log and Copy then reports it empty', async () => {
    const env = await createEnv();
    const writeText = vi.fn();
    Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    env.hooks.setupDeployEventListeners();
    env.hooks.renderLogLines(byId(env, 'deployLog'), ['[2026-11-20 10:00:00] a']);
    byId<HTMLButtonElement>(env, 'clearLogBtn').click();
    expect(byId(env, 'deployLog').children).toHaveLength(0);
    expect(env.hooks.getLogText(byId(env, 'deployLog'))).toBe('');
    byId<HTMLButtonElement>(env, 'copyLogBtn').click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(lastToast(env)!.className).toContain('toast-warning');
    expect(lastToast(env)!.textContent).toContain('Log is empty');
  });

  it('shows the DRY RUN badge only while Dry Run is ticked', async () => {
    const env = await createEnv();
    env.hooks.setupDeployEventListeners();
    const badge = byId(env, 'dryRunBadge');
    const check = byId<HTMLInputElement>(env, 'dryRunCheck');
    expect(badge.style.display).toBe('none');
    check.click();
    expect(badge.style.display).toBe('inline-block');
    check.click();
    expect(badge.style.display).toBe('none');
  });

  it('the badge starts visible if Dry Run is already ticked when the page is set up', async () => {
    const env = await createEnv();
    byId<HTMLInputElement>(env, 'dryRunCheck').checked = true;
    env.hooks.setupDeployEventListeners();
    expect(byId(env, 'dryRunBadge').style.display).toBe('inline-block');
  });
});

describe('selectLogFile (History)', () => {
  it('renders the file as coloured entries without a trailing blank line', async () => {
    const env = await createEnv();
    env.api.readLogFile.mockResolvedValue('[2026-11-20 10:00:00] ❌ boom\r\ndetail\r\n[2026-11-20 10:00:01] ✅ ok\r\n');
    await env.hooks.selectLogFile('deploy-2026-11-20.log');
    expect(logClasses(env, 'logContent')).toEqual(['log-line log-error', 'log-line log-success']);
    expect(byId(env, 'logContent').children[0].textContent).toBe('[2026-11-20 10:00:00] ❌ boom\ndetail');
  });

  it('handles a file without a trailing newline and an empty file', async () => {
    const env = await createEnv();
    env.api.readLogFile.mockResolvedValue('[2026-11-20 10:00:00] a');
    await env.hooks.selectLogFile('a.log');
    expect(byId(env, 'logContent').children).toHaveLength(1);
    env.api.readLogFile.mockResolvedValue('');
    await env.hooks.selectLogFile('b.log');
    expect(byId(env, 'logContent').children).toHaveLength(0);
  });

  it('logs and keeps the previous content when reading fails', async () => {
    const env = await createEnv();
    const consoleError = vi.spyOn(env.window.console, 'error').mockImplementation(() => undefined);
    env.api.readLogFile.mockResolvedValueOnce('[2026-11-20 10:00:00] ✅ previous');
    await env.hooks.selectLogFile('ok.log');
    env.api.readLogFile.mockRejectedValue(new Error('gone'));
    await expect(env.hooks.selectLogFile('x.log')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    expect(logClasses(env, 'logContent')).toEqual(['log-line log-success']);
    expect(byId(env, 'logContent').textContent).toBe('[2026-11-20 10:00:00] ✅ previous');
  });
});

describe('saveProject: editing an existing project', () => {
  const fillEdit = (env: EnvI, values: Record<string, string>) => {
    Object.entries(values).forEach(([id, value]) => {
      byId<HTMLInputElement>(env, id).value = value;
    });
  };
  const saved = (env: EnvI) => env.api.saveConfig.mock.calls[0][0] as ConfigFixtureI;

  it('replaces the edited project at its index and keeps its own name without a duplicate error', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B', 'C'));
    env.hooks.editProject(1);
    expect(byId<HTMLInputElement>(env, 'projectName').value).toBe('B');
    fillEdit(env, { envs: 'prod, stage' });
    await env.hooks.saveProject();
    expect(toasts(env, '.toast-warning')).toHaveLength(0);
    expect(saved(env).projects.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect(saved(env).projects[1].envs).toEqual(['prod', 'stage']);
    expect(saved(env).projects[0].envs).toEqual(['dev']);
    expect(byId(env, 'projectFormContainer').style.display).toBe('none');
  });

  it('rejects renaming onto another project name', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.hooks.editProject(1);
    fillEdit(env, { projectName: 'A' });
    await env.hooks.saveProject();
    expect(lastToast(env)!.textContent).toContain('Project with name "A" already exists');
    expect(env.api.saveConfig).not.toHaveBeenCalled();
  });

  it('restores the original project and keeps the form open when saving fails', async () => {
    const env = await createEnv();
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    env.api.saveConfig.mockResolvedValue({ success: false, error: 'nope' });
    env.hooks.editProject(1);
    fillEdit(env, { envs: 'prod' });
    await env.hooks.saveProject();
    expect(env.hooks.getProjectsConfig()!.projects[1].envs).toEqual(['dev']);
    expect(byId(env, 'projectFormContainer').style.display).toBe('block');
    expect(lastToast(env)!.textContent).toContain('Failed to save config: nope');
  });
});

describe('config replaced by another window while a save is in flight', () => {
  const deferred = () => {
    let resolve!: (value: { success: boolean; error?: string }) => void;
    const promise = new Promise<{ success: boolean; error?: string }>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('deleteProject leaves the newer config untouched when its own save fails', async () => {
    const env = await createEnv();
    const pending = deferred();
    env.api.saveConfig.mockReturnValue(pending.promise);
    env.hooks.setProjectsConfig(mkConfig('A', 'B'));
    const done = env.hooks.deleteProject(0);
    byId<HTMLButtonElement>(env, 'confirmModalOk').click();
    await flush();
    const newer = mkConfig('X', 'Y');
    env.hooks.setProjectsConfig(newer);
    pending.resolve({ success: false, error: 'late failure' });
    await done;
    expect(env.hooks.getProjectsConfig()).toBe(newer);
    expect(newer.projects.map((p) => p.name)).toEqual(['X', 'Y']);
    expect(env.document.querySelectorAll('#projectsList .project-card')).toHaveLength(2);
  });

  it('saveProject leaves the newer config untouched when its own save fails', async () => {
    const env = await createEnv();
    const pending = deferred();
    env.api.saveConfig.mockReturnValue(pending.promise);
    env.hooks.setProjectsConfig(mkConfig('A'));
    byId<HTMLInputElement>(env, 'projectName').value = 'New';
    byId<HTMLInputElement>(env, 'repoPath').value = 'C:/repo';
    byId<HTMLInputElement>(env, 'envs').value = 'dev';
    byId<HTMLInputElement>(env, 'deployTypes').value = 'api';
    byId<HTMLInputElement>(env, 'projectCICDFileName').value = 'CICD.txt';
    const done = env.hooks.saveProject();
    await flush();
    const newer = mkConfig('X', 'Y');
    env.hooks.setProjectsConfig(newer);
    pending.resolve({ success: false, error: 'late failure' });
    await done;
    expect(env.hooks.getProjectsConfig()).toBe(newer);
    expect(newer.projects.map((p) => p.name)).toEqual(['X', 'Y']);
  });
});

describe('startup wiring and handleDeploy', () => {
  it('init registers the live log listener once and loads the project list', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('P', 'Q'));
    await env.init();
    expect(env.api.onDeployLog).toHaveBeenCalledTimes(1);
    expect(env.api.onConfigUpdated).toHaveBeenCalledTimes(1);
    expect(env.api.onDeploymentStatusChanged).toHaveBeenCalledTimes(1);
    expect(Array.from(byId<HTMLSelectElement>(env, 'projectSelect').options).map((o) => o.value)).toEqual(['', 'P', 'Q']);
    expect(env.document.querySelector('.app-version')!.textContent).toBe('1.0.0');
  });

  it('streamed lines reach the log only while a deploy started from this window runs', async () => {
    const env = await createEnv();
    env.api.loadConfig.mockResolvedValue(mkConfig('P'));
    await env.init();
    const onLine = env.api.onDeployLog.mock.calls[0][0] as (line: string) => void;

    onLine('[2026-11-20 10:00:00] ❌ stray line from before');
    expect(byId(env, 'deployLog').children).toHaveLength(0);

    setupDeployForm(env, 'develop');
    let streamed: string[] = [];
    env.api.startDeploy.mockImplementation(async () => {
      onLine('[2026-11-20 10:00:01] 🚀 Starting deploy');
      onLine('[2026-11-20 10:00:02] ⚠ careful');
      streamed = logClasses(env, 'deployLog');
      expect(byId(env, 'deployBtn').querySelector('.btn-text')!.textContent).toBe('Deploying...');
      return { success: true, logs: ['[2026-11-20 10:00:01] 🚀 Starting deploy', '[2026-11-20 10:00:02] ⚠ careful'] };
    });
    await env.hooks.handleDeploy();
    expect(streamed).toEqual(['log-line log-head', 'log-line log-warn']);

    // deploy finished: isDeploying is reset, so late lines are ignored again
    onLine('[2026-11-20 10:00:03] ❌ late');
    expect(byId(env, 'deployLog').children).toHaveLength(2);
  });

  it('ignores a second handleDeploy while one is running', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    let release!: () => void;
    env.api.startDeploy.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ success: true, logs: [] }))),
    );
    const first = env.hooks.handleDeploy();
    await flush();
    await env.hooks.handleDeploy(); // returns immediately
    expect(env.api.startDeploy).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('resets the deploying flag even when runDeploy throws', async () => {
    const env = await createEnv();
    setupDeployForm(env, 'develop');
    env.api.canDeploy.mockRejectedValue(new Error('ipc down'));
    await expect(env.hooks.handleDeploy()).rejects.toThrow('ipc down');
    env.hooks.appendDeployLogLine('[2026-11-20 10:00:00] ❌ after'); // ignored => flag was reset
    expect(byId(env, 'deployLog').children).toHaveLength(0);
    env.api.canDeploy.mockResolvedValue(true);
    await env.hooks.handleDeploy(); // can deploy again
    expect(env.api.startDeploy).toHaveBeenCalledTimes(1);
  });
});

describe('scripts sharing one global scope', () => {
  it('holiday-theme-manager.ts loads next to renderer.ts without top-level name clashes', async () => {
    const env = await createEnv();
    expect(() => env.run(holidayJs)).not.toThrow();
  });
});

describe('PROTECTED_BRANCH_RE', () => {
  it.each(['main', 'master', 'stage', 'staging', 'prod', 'production', 'MAIN', 'Production'])('matches %s', async (b) => {
    const env = await createEnv();
    expect(env.hooks.PROTECTED_BRANCH_RE.test(b)).toBe(true);
  });

  it.each(['feature/main', 'main2', 'maintenance', 'my-prod', 'release/prod', 'develop', ''])('does not match %s', async (b) => {
    const env = await createEnv();
    expect(env.hooks.PROTECTED_BRANCH_RE.test(b)).toBe(false);
  });
});

describe('markup contract', () => {
  it('has every element the new UI code looks up', async () => {
    const env = await createEnv();
    [
      'toastContainer', 'confirmModal', 'confirmModalTitle', 'confirmModalMessage', 'confirmModalOk',
      'confirmModalCancel', 'dryRunBadge', 'copyLogBtn', 'clearLogBtn', 'deployLog', 'logContent',
      'deployProgress', 'cancelDeployBtn', 'cancelDeployHint',
    ].forEach((id) => expect(env.document.getElementById(id), id).not.toBeNull());
    expect(byId(env, 'toastContainer').getAttribute('aria-live')).toBe('polite');
    expect(env.document.querySelector('#confirmModal [role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
  });
});

describe('theme colours', () => {
  const css = fs.readFileSync(path.join(RENDERER_DIR, 'styles', 'themes.css'), 'utf8');
  const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
  const variable = (selector: string, name: string) =>
    new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block(selector))![1];

  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each(['.light-theme', '.dark-theme'])('%s: --warning meets WCAG AA (4.5:1) on both backgrounds', (selector) => {
    const warning = variable(selector, '--warning');
    expect(contrast(warning, variable(selector, '--bg-primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warning, variable(selector, '--bg-secondary'))).toBeGreaterThanOrEqual(4.5);
  });

  const mainCss = fs.readFileSync(path.join(RENDERER_DIR, 'styles', 'main.css'), 'utf8');
  const ruleBody = (selector: string) => {
    const start = mainCss.indexOf(`\n${selector} {`);
    expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
    return mainCss.slice(start, mainCss.indexOf('}', start));
  };

  it('.btn-danger text is readable on the danger background in both themes (WCAG AA)', () => {
    // Light theme: the base rule uses white text; dark theme overrides it with the page background colour
    expect(ruleBody('.btn-danger')).toMatch(/color:\s*white;/);
    expect(contrast('#ffffff', variable('.light-theme', '--danger'))).toBeGreaterThanOrEqual(4.5);

    expect(ruleBody('.dark-theme .btn-danger')).toMatch(/color:\s*var\(--bg-primary\)/);
    expect(contrast(variable('.dark-theme', '--bg-primary'), variable('.dark-theme', '--danger'))).toBeGreaterThanOrEqual(4.5);
  });

  it('.btn-danger keeps the danger background on hover, beating .btn-small:hover (same specificity, so it must come later)', () => {
    // Delete buttons are `btn btn-small btn-danger`; without this the hover background becomes --bg-hover and
    // the dark-theme text colour (--bg-primary) is nearly invisible on it. Limitation: this is a textual check of
    // the stylesheet, jsdom cannot evaluate :hover or var().
    expect(ruleBody('.btn-danger:hover')).toMatch(/background-color:\s*var\(--danger\)/);
    expect(mainCss.indexOf('\n.btn-danger:hover {')).toBeGreaterThan(mainCss.indexOf('\n.btn-small:hover {'));
  });

  // Every colour used for log text (.log-line.log-*) must be readable on the log background
  it.each(['.light-theme', '.dark-theme'])('%s: log text colours meet WCAG AA (4.5:1)', (selector) => {
    ['--danger', '--warning', '--success', '--info'].forEach((name) => {
      expect(contrast(variable(selector, name), variable(selector, '--bg-secondary')), name).toBeGreaterThanOrEqual(4.5);
    });
  });
});
