// Remote branch lookup for the deploy form. Must not import electron so it stays unit-testable.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getGitErrorMessage } from './deploy-utils';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 2 * 60 * 1000;

export interface BranchesResultI {
  branches: string[];
  /** Why the list is missing or possibly stale. Never set when the request was aborted. */
  error?: string;
}

/** Picks the remote to list: the current branch's upstream remote, else `origin`, else the first remote. */
export function pickRemote(remotes: string[], upstreamRemote: string | null): string | null {
  // A name starting with "-" would be read as an option by `git fetch`
  const usable = remotes.filter((r) => r && !r.startsWith('-'));
  if (upstreamRemote && usable.includes(upstreamRemote)) return upstreamRemote;
  if (usable.includes('origin')) return 'origin';
  return usable[0] ?? null;
}

/** Parses `git branch -r` output into branch names of `remote` (prefix removed, symbolic refs skipped). */
export function parseRemoteBranches(stdout: string, remote: string): string[] {
  const prefix = `${remote}/`;
  return stdout
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.includes('->') && b.startsWith(prefix))
    .map((b) => b.slice(prefix.length))
    .filter(Boolean)
    .sort();
}

/**
 * Fetches (with --prune) and lists the branches of the repo's remote. Never throws:
 * problems come back in `error`; a failed fetch still returns the cached branches.
 * An aborted request resolves with an empty list and no error.
 */
export async function getRemoteBranches(repoPath: string, signal?: AbortSignal): Promise<BranchesResultI> {
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    return { branches: [], error: 'Repository path is empty' };
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(repoPath).isDirectory();
  } catch {
    // handled below
  }
  if (!isDirectory) {
    return { branches: [], error: `Repository path does not exist or is not a directory: ${repoPath}` };
  }

  const gitOptions = {
    cwd: repoPath,
    encoding: 'utf8' as const,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
  const git = async (...args: string[]): Promise<string> => (await execFileAsync('git', args, gitOptions)).stdout.toString().trim();

  try {
    try {
      await git('rev-parse', '--is-inside-work-tree');
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      return { branches: [], error: `Not a git repository: ${repoPath}` };
    }

    const remotes = (await git('remote')).split('\n').map((r) => r.trim());
    let upstreamRemote: string | null = null;
    try {
      const current = await git('rev-parse', '--abbrev-ref', 'HEAD');
      if (current && current !== 'HEAD') {
        const configured = await git('config', '--get', `branch.${current}.remote`);
        if (configured && configured !== '.') upstreamRemote = configured;
      }
    } catch (err: unknown) {
      // No commits yet or no upstream configured: fall back to origin / first remote
      if (signal?.aborted) throw err;
    }

    const remote = pickRemote(remotes, upstreamRemote);
    if (!remote) return { branches: [], error: 'No git remote is configured for this repository' };

    let error: string | undefined;
    try {
      await git('fetch', '--prune', remote);
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      error = `Could not fetch from "${remote}", showing cached branches: ${String(getGitErrorMessage(err)).trim()}`;
    }

    const branches = parseRemoteBranches(await git('branch', '-r'), remote);
    return error ? { branches, error } : { branches };
  } catch (err: unknown) {
    // Aborted by the user or superseded by a newer request: not an error
    if (signal?.aborted) return { branches: [] };
    return { branches: [], error: String(getGitErrorMessage(err)).trim() };
  }
}
