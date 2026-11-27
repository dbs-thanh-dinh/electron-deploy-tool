import { describe, expect, it } from 'vitest';
import { buildUpdateProgressPayload, classifyUpdateError, isReleasePageUrl, toTaskbarProgress, toUpdateErrorMessage } from '../src/main/update-utils';

const MB = 1024 * 1024;

describe('buildUpdateProgressPayload', () => {
  it('converts bytes to MB and speed to MB/s, rounded to 2 decimals', () => {
    const payload = buildUpdateProgressPayload({
      percent: 33.3333,
      transferred: 10 * MB,
      total: 30 * MB,
      bytesPerSecond: 2.5 * MB
    });

    expect(payload).toEqual({
      percent: 33.33,
      downloadedMB: 10,
      totalMB: 30,
      speedMBps: 2.5,
      bytesPerSecond: 2.5 * MB,
      transferred: 10 * MB,
      total: 30 * MB
    });
  });

  it('keeps zero progress as zero', () => {
    const payload = buildUpdateProgressPayload({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });

    expect(payload.percent).toBe(0);
    expect(payload.downloadedMB).toBe(0);
    expect(payload.speedMBps).toBe(0);
  });
});

describe('toTaskbarProgress', () => {
  it('maps percent to the 0..1 range Electron expects', () => {
    expect(toTaskbarProgress(50)).toBe(0.5);
    expect(toTaskbarProgress(100)).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(toTaskbarProgress(-5)).toBe(0);
    expect(toTaskbarProgress(150)).toBe(1);
  });
});

describe('toUpdateErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(toUpdateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('net::ERR_INTERNET_DISCONNECTED');
  });

  it('falls back to a generic message for non-Error values and empty messages', () => {
    const generic = 'Đã xảy ra lỗi không xác định khi tải xuống cập nhật.';

    expect(toUpdateErrorMessage('boom')).toBe(generic);
    expect(toUpdateErrorMessage(new Error(''))).toBe(generic);
    expect(toUpdateErrorMessage(undefined)).toBe(generic);
  });
});

describe('classifyUpdateError', () => {
  it('recognises the unsigned-build error from electron-updater', () => {
    const error = new Error('New version 1.4.0-beta.1 is not signed by the application owner: publisherNames: CN=ThanhDC');

    const result = classifyUpdateError(error);

    expect(result.kind).toBe('signature');
    expect(result.message).toContain('chưa được ký số');
    expect(result.detail).toBe(error.message);
  });

  it('recognises the signature error by its error code as well', () => {
    const error = Object.assign(new Error('signature check failed'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' });

    expect(classifyUpdateError(error).kind).toBe('signature');
  });

  it('recognises a missing file on GitHub (HTTP 404)', () => {
    const result = classifyUpdateError(new Error('Cannot download "https://github.com/x/y/releases/download/v1/a.exe", status 404: Not Found'));

    expect(result.kind).toBe('download');
    expect(result.message).toContain('GitHub Releases');
  });

  it('recognises network failures', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).kind).toBe('network');
    expect(classifyUpdateError(new Error('socket hang up')).kind).toBe('network');
  });

  it('falls back to unknown and keeps the raw text as detail', () => {
    const result = classifyUpdateError(new Error('something else'));

    expect(result.kind).toBe('unknown');
    expect(result.message).toBe('something else');
    expect(result.detail).toBe('something else');
  });

  it('handles non-Error values without throwing', () => {
    expect(classifyUpdateError('boom')).toEqual({
      kind: 'unknown',
      message: 'Đã xảy ra lỗi không xác định khi tải xuống cập nhật.',
      detail: 'boom'
    });
    expect(classifyUpdateError(undefined).detail).toBe('');
  });
});

describe('isReleasePageUrl', () => {
  const owner = 'dbs-thanh-dinh';
  const repo = 'electron-deploy-tool';

  it('accepts a release page of the configured repository', () => {
    expect(isReleasePageUrl(`https://github.com/${owner}/${repo}/releases/tag/v1.4.0-beta.1`, owner, repo)).toBe(true);
  });

  it('rejects other repositories, other hosts, non-release pages and non-strings', () => {
    expect(isReleasePageUrl(`https://github.com/someone/${repo}/releases/tag/v1`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(`https://evil.example/${owner}/${repo}/releases/tag/v1`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(`https://github.com/${owner}/${repo}/issues`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(`http://github.com/${owner}/${repo}/releases/tag/v1`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(undefined, owner, repo)).toBe(false);
    expect(isReleasePageUrl(42, owner, repo)).toBe(false);
  });

  it('rejects URLs containing whitespace or control characters', () => {
    expect(isReleasePageUrl(`https://github.com/${owner}/${repo}/releases/tag/v1 evil`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(`https://github.com/${owner}/${repo}/releases/tag/v1\n`, owner, repo)).toBe(false);
    expect(isReleasePageUrl(`https://github.com/${owner}/${repo}/releases/tag/v1\x00`, owner, repo)).toBe(false);
  });
});
