import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from 'electron';
import { WindowManager } from './window-manager';
import { registerIpcHandlers } from './ipc-handlers';
import path from 'node:path';
import fs from 'node:fs';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';
import { UpdateController } from './update-controller';
import { isReleasePageUrl } from './update-utils';

let windowManager: WindowManager;
let updateCheckTimer: NodeJS.Timeout | undefined;
let updateController: UpdateController;

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Deploy Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            windowManager.createWindow();
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    // TODO: Add Help menu later
    // {
    //   label: 'Help',
    //   submenu: [
    //     {
    //       label: 'About',
    //       click: () => {
    //         const win = BrowserWindow.getFocusedWindow();
    //         if (win) {
    //           win.webContents.send('show-about');
    //         }
    //       }
    //     }
    //   ]
    // }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function getGitHubConfig(): { owner: string; repo: string } | null {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    
    const publish = packageJson.build?.publish?.[0];
    if (publish?.provider === 'github' && publish.owner && publish.repo) {
      return {
        owner: publish.owner,
        repo: publish.repo
      };
    }
  } catch (error) {
    console.error('Failed to read GitHub config from package.json:', error);
  }
  return null;
}

function setTaskbarProgress(value: number) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.setProgressBar(value);
    }
  });
}

function initAutoUpdate() {
  const githubConfig = getGitHubConfig();
  // Updater activity is written to the electron-log file (see the log location in README)
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  // Only needed to test updates from an unpackaged dev run
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.allowPrerelease = true;

  updateController = new UpdateController(autoUpdater, {
    broadcast: (channel, payload) => windowManager.broadcast(channel, payload),
    setTaskbarProgress,
    logInfo: (message) => log.info(message),
    logError: (message, error) => log.error(message, error)
  });

  autoUpdater.on("update-available", (info) => {
    updateController.setAvailableVersion(info.version);

    // Construct GitHub release URL
    let githubReleaseUrl = '';
    if (githubConfig) {
      githubReleaseUrl = `https://github.com/${githubConfig.owner}/${githubConfig.repo}/releases/tag/v${info.version}`;
    }

    windowManager.broadcastUpdateAvailable({
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || '',
      githubReleaseUrl: githubReleaseUrl
    });
  });

  autoUpdater.on('download-progress', (progress) => updateController.onDownloadProgress(progress));
  autoUpdater.on('update-downloaded', (info) => updateController.onDownloaded(info.version));
  autoUpdater.on('error', (error) => updateController.onError(error));

  // Renderer asks to download the version announced by update-available
  ipcMain.handle('start-update-download', () => updateController.startDownload());

  // Opens the release page so the user can install manually; only this repository's release pages are allowed
  ipcMain.handle('open-release-page', async (_event, url: unknown) => {
    const githubConfig = getGitHubConfig();
    if (!githubConfig || !isReleasePageUrl(url, githubConfig.owner, githubConfig.repo)) {
      log.warn('Rejected open-release-page request for an unexpected URL');
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      log.error('Failed to open release page', error);
      return false;
    }
  });

  checkForUpdates();
}

function checkForUpdates() {
  updateController.checkForUpdates();
}

app.whenReady().then(() => {
  windowManager = new WindowManager();
  registerIpcHandlers(windowManager);
  createMenu();
  
  windowManager.createWindow();

  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow();
    }
  });

  // Check for updates every 4 hours
  updateCheckTimer = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('will-quit', () => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle notifications
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const iconPath = path.join(__dirname, '../../assets/icon.ico');
    const notification = new Notification({ title, body, icon: iconPath });
    notification.show();
  }
});