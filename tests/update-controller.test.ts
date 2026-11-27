import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IUpdaterPort, IUpdateSinkPort, UpdateController } from '../src/main/update-controller';

const MB = 1024 * 1024;

interface IUpdaterMock {
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
}

interface ISinkMock {
  broadcast: ReturnType<typeof vi.fn>;
  setTaskbarProgress: ReturnType<typeof vi.fn>;
  logInfo: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
}

let updater: IUpdaterMock;
let sink: ISinkMock;
let controller: UpdateController;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  updater = {
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined)
  };
  sink = {
    broadcast: vi.fn(),
    setTaskbarProgress: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn()
  };
  controller = new UpdateController(updater as IUpdaterPort, sink as IUpdateSinkPort);
});

describe('startDownload', () => {
  it('does nothing when no update has been announced', () => {
    controller.startDownload();

    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(sink.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts the announced version and starts exactly one download', () => {
    controller.setAvailableVersion('1.4.0-beta.1');

    controller.startDownload();
    controller.startDownload();

    expect(sink.broadcast).toHaveBeenCalledTimes(1);
    expect(sink.broadcast).toHaveBeenCalledWith('update-download-started', { version: '1.4.0-beta.1' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.isDownloading()).toBe(true);
  });

  it('a rejected downloadUpdate that already emitted an error is not reported twice', async () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    updater.downloadUpdate.mockImplementation(async () => {
      controller.onError(new Error('network down'));
      throw new Error('network down');
    });

    controller.startDownload();
    await flush();

    expect(sink.broadcast.mock.calls.filter(([channel]) => channel === 'update-error')).toHaveLength(1);
    expect(controller.isDownloading()).toBe(false);
  });

  it('a rejected downloadUpdate without an error event does not leave the state stuck', async () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    updater.downloadUpdate.mockRejectedValue(new Error('silent failure'));

    controller.startDownload();
    await flush();

    expect(sink.broadcast).toHaveBeenLastCalledWith('update-error', expect.objectContaining({ kind: 'unknown', detail: 'silent failure' }));
    expect(controller.isDownloading()).toBe(false);
  });

  it('a newer announced version replaces the earlier one for the next download', () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    controller.setAvailableVersion('1.4.0-beta.2');

    controller.startDownload();

    expect(sink.broadcast).toHaveBeenCalledWith('update-download-started', { version: '1.4.0-beta.2' });
  });
});

describe('onDownloadProgress', () => {
  it('broadcasts the converted payload and mirrors the percent on the taskbar', () => {
    controller.onDownloadProgress({ percent: 50, transferred: 5 * MB, total: 10 * MB, bytesPerSecond: MB });

    expect(sink.broadcast).toHaveBeenCalledWith('update-download-progress', expect.objectContaining({
      percent: 50,
      downloadedMB: 5,
      totalMB: 10,
      speedMBps: 1
    }));
    expect(sink.setTaskbarProgress).toHaveBeenCalledWith(0.5);
  });
});

describe('onDownloaded', () => {
  it('clears the taskbar, broadcasts completion and blocks further downloads and checks', () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    controller.startDownload();

    controller.onDownloaded('1.4.0-beta.1');
    controller.startDownload();
    controller.checkForUpdates();

    expect(sink.setTaskbarProgress).toHaveBeenLastCalledWith(-1);
    expect(sink.broadcast).toHaveBeenLastCalledWith('update-downloaded', { version: '1.4.0-beta.1' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(controller.isDownloaded()).toBe(true);
    expect(controller.isDownloading()).toBe(false);
  });
});

describe('onError', () => {
  it('during a download: resets the state, clears the taskbar and tells the user', () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    controller.startDownload();

    controller.onError(new Error('ECONNRESET'));

    expect(sink.logError).toHaveBeenCalledWith('Auto update failed', expect.any(Error));
    expect(sink.setTaskbarProgress).toHaveBeenLastCalledWith(-1);
    expect(sink.broadcast).toHaveBeenLastCalledWith('update-error', expect.objectContaining({ kind: 'network', detail: 'ECONNRESET' }));
    expect(controller.isDownloading()).toBe(false);
  });

  it('outside a download: only logs, so a failed background check is not shown to the user', () => {
    controller.onError(new Error('offline'));

    expect(sink.logError).toHaveBeenCalledTimes(1);
    expect(sink.broadcast).not.toHaveBeenCalled();
    expect(sink.setTaskbarProgress).not.toHaveBeenCalled();
  });

  it('allows a retry after a failed download', () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    controller.startDownload();
    controller.onError(new Error('ECONNRESET'));

    controller.startDownload();

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(controller.isDownloading()).toBe(true);
  });
});

describe('checkForUpdates', () => {
  it('asks electron-updater when idle', () => {
    controller.checkForUpdates();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('is skipped while a download is running, so an overlapping check cannot fail or reopen the popup', () => {
    controller.setAvailableVersion('1.4.0-beta.1');
    controller.startDownload();

    controller.checkForUpdates();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('logs a failing check without broadcasting anything', async () => {
    updater.checkForUpdates.mockRejectedValue(new Error('rate limited'));

    controller.checkForUpdates();
    await flush();

    expect(sink.logError).toHaveBeenCalledWith('Update check failed', expect.any(Error));
    expect(sink.broadcast).not.toHaveBeenCalled();
  });
});
