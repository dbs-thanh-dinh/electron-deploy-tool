import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  applyCicdEntry,
  resolveCicdFile,
  getCommitMsg,
  getFileContent,
  getGitErrorMessage,
  getLocalDate,
  getLocalTimestamp,
} from '../src/main/deploy-utils';

const NOW = new Date(2026, 0, 5, 7, 8, 9); // 2026-01-05 07:08:09 local

describe('getLocalDate / getLocalTimestamp', () => {
  it('zero-pads month, day and time', () => {
    expect(getLocalDate(NOW)).toBe('2026-01-05');
    expect(getLocalTimestamp(NOW)).toBe('2026-01-05 07:08:09');
  });
});

describe('getCommitMsg', () => {
  it('replaces {env} and {type}', () => {
    expect(getCommitMsg('deploy: {env}, {type}', 'dev', 'api')).toBe('deploy: dev, api');
  });

  it('drops {type} and its adjacent comma when type is "all"', () => {
    expect(getCommitMsg('deploy: {env}, {type}', 'dev', 'all')).toBe('deploy: dev');
    expect(getCommitMsg('deploy: {type}, {env}', 'dev', 'all')).toBe('deploy: dev');
  });

  it('does not interpret "$" patterns in values', () => {
    expect(getCommitMsg('{env}', '$&', 'api')).toBe('$&');
  });
});

describe('getFileContent', () => {
  it('replaces all date placeholder formats', () => {
    expect(getFileContent('{date:y-m-d}', 'dev', 'api', NOW)).toBe('2026-01-05');
    expect(getFileContent('{date:y/m/d}', 'dev', 'api', NOW)).toBe('2026/01/05');
    expect(getFileContent('{date:d-m-y}', 'dev', 'api', NOW)).toBe('05-01-2026');
    expect(getFileContent('{date:d/m/y}', 'dev', 'api', NOW)).toBe('05/01/2026');
  });

  it('combines env, type and date', () => {
    expect(getFileContent('{date:d/m/y} {env}, {type}', 'uat', 'web', NOW)).toBe('05/01/2026 uat, web');
  });

  it('drops {type} when type is "all"', () => {
    expect(getFileContent('{env}, {type}', 'dev', 'all', NOW)).toBe('dev');
  });
});

describe('applyCicdEntry', () => {
  it('writes the entry as-is (no EOL) for an empty file', () => {
    expect(applyCicdEntry('', 'deploy: dev', false)).toEqual({ content: 'deploy: dev', action: 'empty' });
  });

  it('adds a new line after the last line (LF)', () => {
    expect(applyCicdEntry('a\nb', 'c', false)).toEqual({ content: 'a\nb\nc', action: 'added' });
  });

  it('keeps CRLF line endings', () => {
    expect(applyCicdEntry('a\r\nb', 'c', false).content).toBe('a\r\nb\r\nc');
  });

  it('keeps a trailing newline when the last line is empty', () => {
    expect(applyCicdEntry('a\nb\n', 'c', false).content).toBe('a\nb\nc\n');
  });

  it('inserts after the blank line when the file ends with "\\n\\n" (index = length - 2)', () => {
    expect(applyCicdEntry('abc\n\n', 'x', false).content).toBe('abc\n\nx\n');
  });

  it('handles a file containing only a newline', () => {
    expect(applyCicdEntry('\n', 'x', false).content).toBe('\nx\n');
  });

  it('does not append "+" when smartAppend is off, even if the last line matches', () => {
    expect(applyCicdEntry('same', 'same', false)).toEqual({ content: 'same\nsame', action: 'added' });
  });

  it('appends "+" when smartAppend is on and the last line matches', () => {
    expect(applyCicdEntry('a\nsame', 'same', true)).toEqual({
      content: 'a\nsame+',
      action: 'appended',
      previousLine: 'same',
      newLine: 'same+',
    });
  });

  it('appends another "+" to an entry that already has some', () => {
    const result = applyCicdEntry('same++', 'same', true);
    expect(result.content).toBe('same+++');
    expect(result.action).toBe('appended');
  });

  it('adds a new line when smartAppend is on but the last line differs', () => {
    expect(applyCicdEntry('a\nb', 'c', true)).toEqual({ content: 'a\nb\nc', action: 'added' });
  });

  it('compares against the entry ignoring surrounding whitespace', () => {
    expect(applyCicdEntry('same  ', 'same', true).action).toBe('appended');
  });
});

describe('getGitErrorMessage', () => {
  it('prefers stderr over message', () => {
    expect(getGitErrorMessage({ stderr: 'fatal: nope', message: 'Command failed' })).toBe('fatal: nope');
  });

  it('falls back to message when stderr is empty or missing', () => {
    expect(getGitErrorMessage({ stderr: '', message: 'Command failed' })).toBe('Command failed');
    expect(getGitErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns undefined for values without a message', () => {
    expect(getGitErrorMessage('plain string')).toBeUndefined();
    expect(getGitErrorMessage(null)).toBeUndefined();
  });
});

describe('resolveCicdFile', () => {
  const repo = path.resolve('some', 'repo');

  it('resolves a plain name and a nested path to a forward-slash pathspec', () => {
    expect(resolveCicdFile(repo, 'CICD.txt')).toEqual({ absolutePath: path.join(repo, 'CICD.txt'), pathspec: 'CICD.txt' });
    expect(resolveCicdFile(repo, 'ci/deploy/CICD.txt')?.pathspec).toBe('ci/deploy/CICD.txt');
  });

  it('accepts names that merely start with two dots', () => {
    expect(resolveCicdFile(repo, '..cicd.txt')?.pathspec).toBe('..cicd.txt');
    expect(resolveCicdFile(repo, 'ci/..cicd.txt')?.pathspec).toBe('ci/..cicd.txt');
  });

  it('accepts a path that goes up and comes back into the repo', () => {
    expect(resolveCicdFile(repo, 'ci/../CICD.txt')?.pathspec).toBe('CICD.txt');
  });

  it.each(['', '.', '..', '../CICD.txt', '../../x', 'ci/../../x', path.resolve('elsewhere', 'CICD.txt')])(
    'rejects %j (empty, the repo itself, or outside the repo)',
    (name) => {
      expect(resolveCicdFile(repo, name)).toBeNull();
    },
  );
});
