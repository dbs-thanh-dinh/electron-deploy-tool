// Config helpers for scripts.json. Must not import electron so they stay unit-testable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectI } from './interface';

/** Fills defaults for fields missing in a (possibly hand-edited) project. Mutates and returns it. */
export function applyProjectDefaults(project: ProjectI): ProjectI {
  if (!project.branchFilter) project.branchFilter = '';
  if (!project.commitFormat) project.commitFormat = 'v1';
  if (!project.commitTemplate) project.commitTemplate = 'deploy: {env}, {type}';
  if (!project.fileContentFormat) project.fileContentFormat = 'default';
  if (!project.fileContentTemplate) project.fileContentTemplate = project.commitTemplate;
  if (project.smartAppend === undefined) project.smartAppend = false;
  if (!project.cicdFileName) project.cicdFileName = 'CICD.txt';
  return project;
}

const OPTIONAL_STRING_FIELDS = [
  'branchFilter',
  'commitFormat',
  'commitTemplate',
  'fileContentFormat',
  'fileContentTemplate',
  'cicdFileName',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/**
 * Basic schema check used by save-config. Returns an error message that points at the
 * offending project/field, or null when valid. Unknown extra fields are allowed (and kept).
 * Note: load-config is intentionally more lenient than this check.
 */
export function validateConfig(config: unknown): string | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return 'config: must be an object';
  }
  const projects = (config as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    return 'config.projects: must be an array';
  }

  const seenNames = new Set<string>();
  for (let i = 0; i < projects.length; i++) {
    const project: unknown = projects[i];
    if (typeof project !== 'object' || project === null || Array.isArray(project)) {
      return `projects[${i}]: must be an object`;
    }
    const p = project as Record<string, unknown>;
    const label = `projects[${i}]${typeof p.name === 'string' ? ` ("${p.name}")` : ''}`;

    if (!isNonEmptyString(p.name)) return `${label}.name: must be a non-empty string`;
    if (!isNonEmptyString(p.repoPath)) return `${label}.repoPath: must be a non-empty string`;
    if (!isNonEmptyStringArray(p.envs)) return `${label}.envs: must be a non-empty array of non-empty strings`;
    if (!isNonEmptyStringArray(p.deployTypes)) {
      return `${label}.deployTypes: must be a non-empty array of non-empty strings`;
    }
    for (const field of OPTIONAL_STRING_FIELDS) {
      if (p[field] !== undefined && typeof p[field] !== 'string') return `${label}.${field}: must be a string`;
    }
    if (p.smartAppend !== undefined && typeof p.smartAppend !== 'boolean') {
      return `${label}.smartAppend: must be a boolean`;
    }

    // Exact match, same as the renderer's duplicate check
    if (seenNames.has(p.name)) return `${label}.name: duplicate project name`;
    seenNames.add(p.name);
  }
  return null;
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface WriteFileAtomicOptions {
  /** Rename attempts (Windows antivirus/editors can briefly lock the target). Default 5. */
  retries?: number;
  /** Base delay between attempts in ms, multiplied by the attempt number. Default 100. */
  retryDelayMs?: number;
}

/**
 * Writes `data` to a unique temp file in the same directory, flushes it, then renames it over
 * `filePath`. The old file is left intact if anything fails, and the temp file is always removed.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  { retries = 5, retryDelayMs = 100 }: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, data, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= retries || !code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  } finally {
    // After a successful rename the temp file no longer exists
    fs.rmSync(tmpPath, { force: true });
  }
}
