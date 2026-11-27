// Pure helpers for the update download flow. Must not import electron so it stays unit-testable.
import type { UpdateDownloadProgressI, UpdateErrorI } from './interface';

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

/**
 * Maps an updater error to a kind and a user-facing message. Matching uses the text electron-updater produces:
 * the unsigned-build check ("not signed by the application owner") and HTTP failures ("Cannot download ... status 404").
 */
export function classifyUpdateError(error: unknown): UpdateErrorI {
  const detail = error instanceof Error ? error.message : error == null ? '' : String(error);

  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /not signed by the application owner/i.test(detail)) {
    return {
      kind: 'signature',
      message: 'Bản cập nhật chưa được ký số nên Windows không cho phép tự động cài đặt.',
      detail
    };
  }
  if (/Cannot download .*status \d{3}/i.test(detail)) {
    return {
      kind: 'download',
      message: 'Không tìm thấy hoặc không tải được file cài đặt trên GitHub Releases.',
      detail
    };
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|socket hang up/i.test(detail)) {
    return {
      kind: 'network',
      message: 'Không kết nối được tới GitHub. Kiểm tra kết nối mạng rồi thử lại.',
      detail
    };
  }
  return {
    kind: 'unknown',
    message: toUpdateErrorMessage(error),
    detail
  };
}

/** True only for a release page of the given repository, so the renderer cannot make the app open arbitrary URLs. */
export function isReleasePageUrl(url: unknown, owner: string, repo: string): url is string {
  if (typeof url !== 'string' || !url.startsWith(`https://github.com/${owner}/${repo}/releases/`)) return false;
  // Reject whitespace and control characters (code points below 0x20 and DEL)
  return ![...url].some((ch) => /\s/.test(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}
