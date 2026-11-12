import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { ProjectI } from './interface';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getLocalDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getLocalTimestamp(now: Date = new Date()): string {
  return `${getLocalDate(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

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
    } catch (err: any) {
      this.log(`❌ Error running: git ${args[0]}`, logs);
      const errorMsg = err.stderr?.toString() || err.message;
      this.log(errorMsg, logs);
      return false;
    }
  }

  private getCommitMsg(commitTemplate: string, env: string, type: string): string {
    let commitMessage = commitTemplate;
    if (type === 'all') {
      commitMessage = commitMessage.replace(/\{type\}\s*,\s*|\s*,\s*\{type\}/gi, "");
    }

    return commitMessage
      .replace(/\{env\}/g, () => env)
      .replace(/\{type\}/g, () => type);
  }

  private getFileContent(fileContentTemplate: string, env: string, type: string): string {
    let fileContent = fileContentTemplate;
    if (type === 'all') {
      fileContent = fileContent.replace(/\{type\}\s*,\s*|\s*,\s*\{type\}/gi, "");
    }
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());
    return fileContent
      .replace(/\{date:y-m-d\}/g, () => `${yyyy}-${mm}-${dd}`)
      .replace(/\{date:y\/m\/d\}/g, () => `${yyyy}/${mm}/${dd}`)
      .replace(/\{date:d-m-y\}/g, () => `${dd}-${mm}-${yyyy}`)
      .replace(/\{date:d\/m\/y\}/g, () => `${dd}/${mm}/${yyyy}`)
      .replace(/\{env\}/g, () => env)
      .replace(/\{type\}/g, () => type);
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
      const cicdFileContent = this.getFileContent(fileContentTemplate, env, type);
      this.updateCICDFile(logs, project, cicdFileContent);
      
      // Commit
      if (!(await this.runGit(['add', '--', project.cicdFileName], repoPath, logs))) {
        throw new Error('Git add failed');
      }
      
      const commitMsg = this.getCommitMsg(commitTemplate, env, type);
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
    } catch (err: any) {
      this.log(`❌ Deploy failed: ${err.message}`, logs);
      return { success: false, logs, error: err.message };
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
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);

    const updateCommitMsg = (lines: string[], index: number, commitMsg: string) => {
      const line = lines[index];
      const lineBase = line.replace(/\s*\++\s*$/, '').trim();
      if (!project.smartAppend || lineBase !== commitMsg.trim()) {
        // Add new line with commitMsg
        this.log(`✓ Added to ${project.cicdFileName}: ${commitMsg}`, logs);
        lines.splice(index + 1, 0, commitMsg);
      } else {
        // Append "+" to line
        lines.splice(index, 1, line + '+');
        this.log(`✓ Appended "+" to existing entry in ${project.cicdFileName}: "${line}" -> "${lines[index]}"`, logs);
      }
    }

    // File empty
    if (lines.length === 1 && lines[0] === '') {
      fs.writeFileSync(cicdPath, commitMsg);
    } else {
      const lastLine = lines.at(-1) as string;
      // Remove existing "+" from lastLine for comparison
      if (lastLine.trim() === '') {
        // Last line is empty, just add new line
        updateCommitMsg(lines, lines.length - 2, commitMsg);
      } else {
        updateCommitMsg(lines, lines.length - 1, commitMsg);
      }
      fs.writeFileSync(cicdPath, lines.join(eol));
    }
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