import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { ProjectI } from './interface';
import { applyCicdEntry, getCommitMsg, getFileContent, getGitErrorMessage, getLocalDate, getLocalTimestamp } from './deploy-utils';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface DeployOptions {
  project: ProjectI;
  branch: string;
  env: string;
  type: string;
  dryRun: boolean;
  commitTemplate: string;
  fileContentTemplate: string;
  isAutomatic?: boolean; // Flag for auto-deploy
}

export interface DeployResult {
  success: boolean;
  logs: string[];
  error?: string;
}

export class DeployService {
  private readonly userDataPath = app.getPath('userData');
  private readonly logDir = path.join(this.userDataPath, 'logs');

  constructor() {
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  private getLogFilePath(): string {
    return path.join(this.logDir, `deploy-${getLocalDate()}.log`);
  }

  private log(msg: string, logs: string[]): void {
    const line = `[${getLocalTimestamp()}] ${msg}`;
    logs.push(line);
    
    // Also write to file
    try {
      fs.appendFileSync(this.getLogFilePath(), line + '\n');
    } catch (err) {
      console.error('Failed to write log:', err);
    }
  }

  private getGitOptions(cwd: string) {
    return {
      cwd,
      encoding: 'utf8' as const,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      // Literal pathspecs: a CICD file name like "CICD[1].txt" must not be treated as a glob/magic by add/diff/checkout
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
    };
  }

  /** Runs git, logs the command and its output. Returns trimmed stdout, or null when git fails. */
  private async runGitOutput(args: string[], cwd: string, logs: string[]): Promise<string | null> {
    try {
      this.log(`$ git ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, logs);
      const { stdout } = await execFileAsync('git', args, this.getGitOptions(cwd));

      const output = stdout.toString().trim();
      if (output) {
        this.log(output, logs);
      }
      return output;
    } catch (err: unknown) {
      this.log(`❌ Error running: git ${args[0]}`, logs);
      // String() keeps the original output ("undefined") when the error carries no message
      this.log(String(getGitErrorMessage(err)), logs);
      return null;
    }
  }

  private async runGit(args: string[], cwd: string, logs: string[]): Promise<boolean> {
    return (await this.runGitOutput(args, cwd, logs)) !== null;
  }

  /** Hash of the newest stash entry ('' when there is none or git fails). Silent: not written to the log. */
  private async getTopStash(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['stash', 'list', '--format=%H', '-1'], this.getGitOptions(cwd));
      return stdout.toString().trim();
    } catch {
      return '';
    }
  }

  /**
   * `git diff --cached --quiet` exits 1 when there ARE staged changes, which is a normal result
   * (not an error), so it cannot go through runGit. Any other failure is rethrown.
   */
  private async hasStagedChanges(pathspec: string, cwd: string, logs: string[]): Promise<boolean> {
    this.log(`$ git diff --cached --quiet -- ${pathspec}`, logs);
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet', '--', pathspec], this.getGitOptions(cwd));
      return false;
    } catch (err: unknown) {
      if ((err as { code?: unknown }).code === 1) return true;
      throw err;
    }
  }

  /** Best-effort: restores the CICD file (index + worktree) to HEAD. Never throws. */
  private async rollbackCicdFile(pathspec: string, cwd: string, logs: string[]): Promise<void> {
    this.log(`↩️ Rolling back ${pathspec} to HEAD`, logs);
    const ok = await this.runGit(['checkout', 'HEAD', '--', pathspec], cwd, logs);
    this.log(ok ? `✓ Rolled back ${pathspec}` : `⚠️ Rollback failed, please check ${pathspec} manually`, logs);
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const logs: string[] = [];
    const { project, branch, env, type, dryRun, commitTemplate, fileContentTemplate } = options;
    const repoPath = project.repoPath;
    let cicdPathspec: string | null = null;
    let cicdWritten = false;
    let committed = false;

    try {
      this.log('=========================================================', logs);
      this.log(`🚀 Starting deploy for ${project.name} (${env}) [${type}]`, logs);
      this.log(`Repo path: ${repoPath}`, logs);
      this.log(`Branch: ${branch}`, logs);
      
      if (dryRun) {
        this.log('⚠️ Running in DRY-RUN mode (will not push to remote)', logs);
      }

      // Check if repo path exists
      if (!fs.existsSync(repoPath)) {
        throw new Error(`Repository path does not exist: ${repoPath}`);
      }

      if (!branch || branch.startsWith('-')) {
        throw new Error(`Invalid branch name: ${branch}`);
      }
      const cicdPath = path.resolve(repoPath, project.cicdFileName);
      const relativeCicd = path.relative(path.resolve(repoPath), cicdPath);
      if (!relativeCicd || relativeCicd.startsWith('..') || path.isAbsolute(relativeCicd)) {
        throw new Error(`Invalid CICD file name: ${project.cicdFileName}`);
      }

      // Same pathspec (forward slashes) for add / diff / checkout
      cicdPathspec = relativeCicd.split(path.sep).join('/');

      // Git operations
      const stashBefore = await this.getTopStash(repoPath);
      if (!(await this.runGit(['stash', 'save', 'Auto stash before deploy'], repoPath, logs))) {
        throw new Error('Git stash failed');
      }
      // Log-only warning: the stash is intentionally never popped (documented behavior).
      // Compare the top stash hash instead of parsing git's (localizable) output.
      const stashAfter = await this.getTopStash(repoPath);
      if (stashAfter && stashAfter !== stashBefore) {
        this.log('⚠ Local changes were stashed and NOT restored. Run `git stash pop` in the repo to get them back.', logs);
      }

      const currentBranch = await this.runGitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, logs);
      if (currentBranch === null) {
        throw new Error('Git rev-parse failed');
      }
      if (currentBranch === branch) {
        this.log(`Current branch: ${currentBranch}`, logs);
      } else if (!(await this.runGit(['checkout', branch], repoPath, logs))) {
        throw new Error('Git checkout failed');
      }

      // --ff-only: never create a merge commit or leave the repo in a conflicted state
      if (!(await this.runGit(['pull', '--ff-only'], repoPath, logs))) {
        this.log('ℹ️ Pull failed. Common causes: the local branch cannot fast-forward (e.g. unpushed local commits from a previous deploy or dry-run), no upstream branch, or a network/auth problem.', logs);
        throw new Error('Git pull failed');
      }

      // Update CICD.txt
      const cicdFileContent = getFileContent(fileContentTemplate, env, type);
      this.updateCICDFile(logs, project, cicdFileContent);
      cicdWritten = true;
      
      // Commit
      if (!(await this.runGit(['add', '--', cicdPathspec], repoPath, logs))) {
        throw new Error('Git add failed');
      }

      if (!(await this.hasStagedChanges(cicdPathspec, repoPath, logs))) {
        throw new Error(`Nothing to commit: ${cicdPathspec} has no changes`);
      }
      
      const commitMsg = getCommitMsg(commitTemplate, env, type);
      if (!(await this.runGit(['commit', '-m', commitMsg], repoPath, logs))) {
        throw new Error('Git commit failed');
      }
      committed = true;

      // Push (if not dry-run)
      if (dryRun) {
        this.log('DRY-RUN: Skipping push step', logs);
        this.log('✅ SUCCESS: Dry-run completed (no push)', logs);
      } else {
        if (!(await this.runGit(['push'], repoPath, logs))) {
          this.log('ℹ️ The commit was created locally but NOT pushed. Fix the push problem and push manually, or the next deploy will need to fast-forward.', logs);
          throw new Error('Git push failed');
        }
        this.log('✅ SUCCESS: Deploy completed!', logs);
      }

      return { success: true, logs };
    } catch (err: unknown) {
      const message = (err as Error).message;
      this.log(`❌ Deploy failed: ${message}`, logs);
      // Only roll back while nothing was committed; a created commit is left untouched
      if (cicdWritten && !committed && cicdPathspec) {
        await this.rollbackCicdFile(cicdPathspec, repoPath, logs);
      }
      return { success: false, logs, error: message };
    } finally {
      this.log('', logs);
    }
  }

  updateCICDFile(logs: string[], project: ProjectI, commitMsg: string) {
    const cicdPath = path.join(project.repoPath, project.cicdFileName);
    if (!fs.existsSync(cicdPath)) {
      throw new Error(`${project.cicdFileName} does not exist in repo`);
    }
    const content = fs.readFileSync(cicdPath, 'utf8');
    const result = applyCicdEntry(content, commitMsg, project.smartAppend);
    if (result.action === 'added') {
      this.log(`✓ Added to ${project.cicdFileName}: ${commitMsg}`, logs);
    } else if (result.action === 'appended') {
      this.log(`✓ Appended "+" to existing entry in ${project.cicdFileName}: "${result.previousLine}" -> "${result.newLine}"`, logs);
    }
    fs.writeFileSync(cicdPath, result.content);
  }

  getLogDir(): string {
    return this.logDir;
  }

  getLogFiles(): string[] {
    try {
      const files = fs.readdirSync(this.logDir);
      return files
        .filter(f => f.startsWith('deploy-') && f.endsWith('.log'))
        .sort()
        .reverse();
    } catch (err) {
      return [];
    }
  }

  readLogFile(filename: string): string {
    try {
      const safeName = path.basename(filename);
      if (safeName !== filename || !safeName.startsWith('deploy-') || !safeName.endsWith('.log')) {
        return 'Error reading log file: invalid file name';
      }
      const filePath = path.join(this.logDir, safeName);
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return `Error reading log file: ${err}`;
    }
  }
}