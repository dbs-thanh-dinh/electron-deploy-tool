// State machine for the in-app update download. Must not import electron so it stays unit-testable.
import type { UpdateDownloadProgressI } from './interface';
import { buildUpdateProgressPayload, classifyUpdateError, toTaskbarProgress } from './update-utils';

/** The part of electron-updater's autoUpdater this controller uses. */
export interface IUpdaterPort {
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
}

/** Side effects (IPC to renderers, taskbar, logging) injected from main.ts. */
export interface IUpdateSinkPort {
  broadcast: (channel: string, payload: unknown) => void;
  setTaskbarProgress: (value: number) => void;
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

export class UpdateController {
  private availableVersion = '';
  private downloading = false;
  private downloaded = false;

  constructor(
    private readonly updater: IUpdaterPort,
    private readonly sink: IUpdateSinkPort
  ) {}

  /** Records the version announced by update-available. The popup itself is broadcast by the caller. */
  setAvailableVersion(version: string): void {
    this.availableVersion = version;
  }

  /**
   * Periodic or startup check. Skipped while a download is running or after one finished, so a failing
   * background check cannot be mistaken for a download error and cannot reopen the popup mid-download.
   */
  checkForUpdates(): void {
    if (this.downloading || this.downloaded) return;
    this.updater.checkForUpdates().catch((error: unknown) => {
      this.sink.logError('Update check failed', error);
    });
  }

  /** Called when the user clicks "Tải xuống ngay". Ignored if there is nothing to download or a download is active. */
  startDownload(): void {
    if (this.downloading || this.downloaded || !this.availableVersion) return;
    this.downloading = true;
    this.sink.broadcast('update-download-started', { version: this.availableVersion });
    // electron-updater normally reports failures through the 'error' event (onError) before rejecting.
    // This fallback keeps the state from getting stuck if a version rejects without emitting it.
    this.updater.downloadUpdate().catch((error: unknown) => {
      if (this.downloading) this.onError(error);
    });
  }

  onDownloadProgress(progress: Parameters<typeof buildUpdateProgressPayload>[0]): void {
    const payload: UpdateDownloadProgressI = buildUpdateProgressPayload(progress);
    this.sink.broadcast('update-download-progress', payload);
    this.sink.setTaskbarProgress(toTaskbarProgress(payload.percent));
  }

  onDownloaded(version: string): void {
    this.downloading = false;
    this.downloaded = true;
    this.sink.setTaskbarProgress(-1);
    this.sink.logInfo(`Update ${version} downloaded, it will be installed when the app quits`);
    this.sink.broadcast('update-downloaded', { version });
  }

  onError(error: unknown): void {
    this.sink.logError('Auto update failed', error);
    // Errors outside a download (e.g. a background check) are only logged
    if (!this.downloading) return;
    this.downloading = false;
    this.sink.setTaskbarProgress(-1);
    this.sink.broadcast('update-error', classifyUpdateError(error));
  }

  isDownloading(): boolean {
    return this.downloading;
  }

  isDownloaded(): boolean {
    return this.downloaded;
  }
}
