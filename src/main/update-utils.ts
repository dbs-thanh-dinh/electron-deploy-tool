// Pure helpers for the update download flow. Must not import electron so it stays unit-testable.
import type { UpdateDownloadProgressI } from './interface';

const BYTES_PER_MB = 1024 * 1024;

/** Round to 2 decimal places so the renderer receives stable, readable numbers. */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts the electron-updater `download-progress` payload into the shape sent to the renderer.
 * Sizes are reported in MB and speed in MB/s; the raw byte values are kept for consumers that need them.
 */
export function buildUpdateProgressPayload(progress: {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}): UpdateDownloadProgressI {
  return {
    percent: roundTo2(progress.percent),
    downloadedMB: roundTo2(progress.transferred / BYTES_PER_MB),
    totalMB: roundTo2(progress.total / BYTES_PER_MB),
    speedMBps: roundTo2(progress.bytesPerSecond / BYTES_PER_MB),
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total
  };
}

/** Taskbar progress value for Electron's `setProgressBar`: 0..1 while downloading, -1 to hide it. */
export function toTaskbarProgress(percent: number): number {
  return Math.min(Math.max(percent / 100, 0), 1);
}

/** Message shown in the update error modal. Falls back to a generic text for non-Error values. */
export function toUpdateErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Đã xảy ra lỗi không xác định khi tải xuống cập nhật.';
}
