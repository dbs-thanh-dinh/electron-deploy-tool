import { contextBridge, ipcRenderer } from 'electron';
// `import type` is erased at compile time (preload runs sandboxed and cannot require main-process modules)
import type { ConfigI } from '../main/interface';
import type { DeployOptions } from '../main/deploy-service';

interface UpdateInfoI {
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  githubReleaseUrl?: string;
}

interface ConfirmDialogOptionsI {
  title: string;
  message: string;
  detail?: string;
}

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Update operations
  onUpdateAvailable: (callback: (data: UpdateInfoI) => void) => {
    ipcRenderer.on('update-available', (_event, data) => callback(data));
  },

  // Config operations
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config: ConfigI) => ipcRenderer.invoke('save-config', config),
  
  // Deploy operations
  canDeploy: (projectName: string) => ipcRenderer.invoke('can-deploy', projectName),
  getActiveDeployments: () => ipcRenderer.invoke('get-active-deployments'),
  startDeploy: (options: DeployOptions) => ipcRenderer.invoke('start-deploy', options),
  
  // Log operations
  getLogDir: () => ipcRenderer.invoke('get-log-dir'),
  getLogFiles: () => ipcRenderer.invoke('get-log-files'),
  readLogFile: (filename: string) => ipcRenderer.invoke('read-log-file', filename),
  
  // Git operations
  getBranches: (repoPath: string) => ipcRenderer.invoke('get-branches', repoPath),
  cancelGetBranches: () => ipcRenderer.invoke('cancel-get-branches'),

  // Notifications
  showNotification: (title: string, body: string) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  
  // Event listeners
  onDeploymentStatusChanged: (callback: (activeProjects: string[]) => void) => {
    ipcRenderer.on('deployment-status-changed', (event, activeProjects) => {
      callback(activeProjects);
    });
  },
  
  onDeployLog: (callback: (line: string) => void) => {
    ipcRenderer.on('deploy-log', (event, line: string) => {
      callback(line);
    });
  },

  onConfigUpdated: (callback: () => void) => {
    ipcRenderer.on('config-updated', () => {
      callback();
    });
  },
  
  onShowAbout: (callback: () => void) => {
    ipcRenderer.on('show-about', () => {
      callback();
    });
  },

  // Dialog operations
  openDialogConfirm: (options: ConfirmDialogOptionsI) => ipcRenderer.invoke('open-dialog-confirm', options),

  // File system
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),

  // Holidays
  loadHolidaysConfig: () => ipcRenderer.invoke('load-holidays-config'),
});