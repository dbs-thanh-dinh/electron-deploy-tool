import { BrowserWindow } from 'electron';
import path from 'node:path';

export class WindowManager {
  private readonly windows: Set<BrowserWindow> = new Set();
  private readonly activeDeployments: Map<string, number> = new Map(); // projectName -> windowId

  createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1000,
      height: 800,
      minWidth: 1000,
      minHeight: 600,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      },
      icon: path.join(__dirname, '../../assets/icon.ico'),
      backgroundColor: '#1e1e1e',
      show: false
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));

    win.once('ready-to-show', () => {
      win.show();
    });

    win.on('closed', () => {
      this.windows.delete(win);
      // Active deployments are released by the start-deploy handler when the deploy finishes,
      // even if the window that started it is already closed
    });

    this.windows.add(win);
    return win;
  }

  broadcastUpdateAvailable(payload: unknown): void {
    this.windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('update-available', payload);
      }
    });
  }

  getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows);
  }

  canDeploy(projectName: string, _windowId?: number): boolean {
    // A project can only run one deploy at a time, regardless of which window started it
    return !this.activeDeployments.has(projectName);
  }

  setDeploymentActive(projectName: string, windowId: number): void {
    this.activeDeployments.set(projectName, windowId);
    this.broadcastDeploymentStatus();
  }

  setDeploymentInactive(projectName: string): void {
    this.activeDeployments.delete(projectName);
    this.broadcastDeploymentStatus();
  }

  getActiveDeployments(): string[] {
    return Array.from(this.activeDeployments.keys());
  }

  private broadcastDeploymentStatus(): void {
    const activeProjects = this.getActiveDeployments();
    this.windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('deployment-status-changed', activeProjects);
      }
    });
  }

  broadcastConfigUpdate(excludeWebContentsId?: number): void {
    this.windows.forEach(win => {
      if (!win.isDestroyed() && win.webContents.id !== excludeWebContentsId) {
        win.webContents.send('config-updated');
      }
    });
  }
}