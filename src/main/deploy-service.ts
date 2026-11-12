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

  private async runGit(args: string[], cwd: string, logs: string[]): Promise<boolean> {
    try {
      this.log(`$ git ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, logs);
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      const output = stdout.toString().trim();
      if (output) {
        this.log(output, logs);
      }
      return true;
    } catch (err: unknown) {
      this.log(`❌ Error running: git ${args[0]}`, logs);
      // String() keeps the original output ("undefined") when the error carries no message
      this.log(String(getGitErrorMessage(err)), logs);
      return false;
    }
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const logs: string[] = [];
    const { project, branch, env, type, dryRun, commitTemplate, fileContentTemplate } = options;
    const repoPath = project.repoPath;

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

      // Git operations
      if (!(await this.runGit(['stash', 'save', 'Auto stash before deploy'], repoPath, logs))) {
        throw new Error('Git stash failed');
      }

      const { stdout: currentBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
        windowsHide: true,
      });
      const currentBranch = currentBranchOut.toString().trim();
      if (currentBranch === branch) {
        this.log(`Current branch: ${currentBranch}`, logs);
      } else if (!(await this.runGit(['checkout', branch], repoPath, logs))) {
        throw new Error('Git checkout failed');
      }

      if (!(await this.runGit(['pull'], repoPath, logs))) {
        throw new Error('Git pull failed');
      }

      // Update CICD.txt
      const cicdFileContent = getFileContent(fileContentTemplate, env, type);
      this.updateCICDFile(logs, project, cicdFileContent);
      
      // Commit
      if (!(await this.runGit(['add', '--', project.cicdFileName], repoPath, logs))) {
        throw new Error('Git add failed');
      }
      
      const commitMsg = getCommitMsg(commitTemplate, env, type);
      if (!(await this.runGit(['commit', '-m', commitMsg], repoPath, logs))) {
        throw new Error('Git commit failed');
      }

      // Push (if not dry-run)
      if (dryRun) {
        this.log('DRY-RUN: Skipping push step', logs);
        this.log('✅ SUCCESS: Dry-run completed (no push)', logs);
      } else {
        if (!(await this.runGit(['push'], repoPath, logs))) {
          throw new Error('Git push failed');
        }
        this.log('✅ SUCCESS: Deploy completed!', logs);
      }

      return { success: true, logs };
    } catch (err: unknown) {
      const message = (err as Error).message;
      this.log(`❌ Deploy failed: ${message}`, logs);
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