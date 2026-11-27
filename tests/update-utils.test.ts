import { describe, expect, it } from 'vitest';
import { buildUpdateProgressPayload, toTaskbarProgress, toUpdateErrorMessage } from '../src/main/update-utils';

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
