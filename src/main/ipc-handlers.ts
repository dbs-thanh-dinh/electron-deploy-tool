import { app, ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { WindowManager } from './window-manager';
import { DeployService, DeployOptions } from './deploy-service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigI } from './interface';
import { applyProjectDefaults, saveConfigToFile } from './config-utils';

const execFileAsync = promisify(execFile);

interface ConfirmDialogOptionsI {
  title: string;
  message: string;
  detail?: string;
}
const deployService = new DeployService();
const userDataPath = app.getPath('userData');

const configDefault = {
  "projects": [
    {
      "name": "Project Name",
      "repoPath": "Repository Path",
      "envs": [
        "dev",
      ],
      "deployTypes": [
        "api",
        "webapp",
        "all"
      ]
    }
  ]
};

// Get app version from package.json
function getAppVersion(): string {
  try {
    const packagePath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'package.json')
      : path.join(__dirname, '../../package.json');
    
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      return packageJson.version || '1.0.0';
    }
  } catch (err) {
    console.error('Failed to read version:', err);
  }
  return '1.0.0';
}


function getExtraFilePath(filename: string): string {
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, "extra")
    : path.join(process.cwd(), "extra");

  const filePath = path.join(basePath, filename);

  if (!fs.existsSync(filePath)) {
    console.warn("[WARN] Extra file not found:", filePath);
  }

  return filePath;
}

function getScriptsPath(): string {
  return path.join(userDataPath, 'scripts.json');
}

export function registerIpcHandlers(windowManager: WindowManager) {
  // Get app version
  ipcMain.handle('get-app-version', async () => {
    return getAppVersion();
  });

  // Load configuration
  ipcMain.handle('load-config', async () => {
    try {
      const scriptsPath = getScriptsPath();
      if (!fs.existsSync(scriptsPath)) {
        const scriptsSamplePath = getExtraFilePath('scripts.json');
        if (fs.existsSync(scriptsSamplePath)) {
          fs.copyFileSync(scriptsSamplePath, scriptsPath);
          console.log('Sample scripts.json copied to user data directory', scriptsSamplePath);
        } else {
          console.warn('Sample scripts.json not found, using default config');
          fs.writeFileSync(scriptsPath, JSON.stringify(configDefault, null, 2), 'utf8');
        }
      }
      const config = fs.readFileSync(scriptsPath, 'utf8');
      const scripts: ConfigI = JSON.parse(config);
      scripts.projects = (scripts.projects || []).map(applyProjectDefaults);
      return scripts;
    } catch (err: unknown) {
      console.error('Error loading config:', err);
      return { error: (err as Error).message };
    }
  });

  // Save configuration
  ipcMain.handle('save-config', async (event, config: unknown) => {
    const result = await saveConfigToFile(getScriptsPath(), config);
    // Only tell the other windows when the file actually changed
    if (result.success) {
      windowManager.broadcastConfigUpdate(event.sender.id);
    }
    return result;
  });

  // Check if can deploy
  ipcMain.handle('can-deploy', async (event, projectName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    return windowManager.canDeploy(projectName, win.id);
  });

  // Get active deployments
  ipcMain.handle('get-active-deployments', async () => {
    return windowManager.getActiveDeployments();
  });

  // Start deployment
  ipcMain.handle('start-deploy', async (event, options: DeployOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }

    if (!windowManager.canDeploy(options.project.name, win.id)) {
      return { 
        success: false, 
        error: `Project ${options.project.name} is already being deployed in another window` 
      };
    }

    windowManager.setDeploymentActive(options.project.name, win.id);
    
    try {
      const result = await deployService.deploy(options);
      return result;
    } finally {
      windowManager.setDeploymentInactive(options.project.name);
    }
  });

  // Get log directory
  ipcMain.handle('get-log-dir', async () => {
    return deployService.getLogDir();
  });

  // Get log files
  ipcMain.handle('get-log-files', async () => {
    return deployService.getLogFiles();
  });

  // Read log file
  ipcMain.handle('read-log-file', async (event, filename: string) => {
    return deployService.readLogFile(filename);
  });

  // Get branches from git repo
  ipcMain.handle('get-branches', async (event, repoPath: string) => {
    try {
      const gitOptions = {
        cwd: repoPath,
        encoding: 'utf8' as const,
        timeout: 2 * 60 * 1000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      };

      // Fetch latest branches
      await execFileAsync('git', ['fetch', '--prune'], gitOptions);

      // Get the list of remote branches
      const { stdout } = await execFileAsync('git', ['branch', '-r'], gitOptions);

      // Parse branches
      const branches = stdout
        .split('\n')
        .map(b => b.trim().replace(/^origin\//, ''))
        .filter(b => b && !b.includes('->'))
        .sort();

      return branches;
    } catch (err: unknown) {
      console.error('Error getting branches:', err);
      return [];
    }
  });

  ipcMain.handle('open-dialog-confirm', async (event, options: ConfirmDialogOptionsI) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      title: options.title,
      message: options.message,
      detail: options.detail || '',
    });

    return result.response === 1; // OK button was pressed
  });

  ipcMain.handle('open-directory-dialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Repository Folder'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('load-holidays-config', async () => {
    try {
      const holidaysPath = getExtraFilePath('holidays-config.json'); 
      if (fs.existsSync(holidaysPath)) {
        const config = fs.readFileSync(holidaysPath, 'utf8');
        return JSON.parse(config);
      } else {
        return { holidays: [] };
      }
    } catch (err: unknown) {
      console.error('Error loading holidays config:', err);
      return { holidays: [] };
    }
  });
}