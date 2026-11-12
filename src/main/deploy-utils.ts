// Pure helpers for DeployService. Must not import electron so they stay unit-testable.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getLocalDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function getLocalTimestamp(now: Date = new Date()): string {
  return `${getLocalDate(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

export function getCommitMsg(commitTemplate: string, env: string, type: string): string {
  let commitMessage = commitTemplate;
  if (type === 'all') {
    commitMessage = commitMessage.replace(/\{type\}\s*,\s*|\s*,\s*\{type\}/gi, "");
  }

  return commitMessage
    .replace(/\{env\}/g, () => env)
    .replace(/\{type\}/g, () => type);
}

export function getFileContent(
  fileContentTemplate: string,
  env: string,
  type: string,
  now: Date = new Date(),
): string {
  let fileContent = fileContentTemplate;
  if (type === 'all') {
    fileContent = fileContent.replace(/\{type\}\s*,\s*|\s*,\s*\{type\}/gi, "");
  }
  const yyyy = String(now.getFullYear());
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  return fileContent
    .replace(/\{date:y-m-d\}/g, () => `${yyyy}-${mm}-${dd}`)
    .replace(/\{date:y\/m\/d\}/g, () => `${yyyy}/${mm}/${dd}`)
    .replace(/\{date:d-m-y\}/g, () => `${dd}-${mm}-${yyyy}`)
    .replace(/\{date:d\/m\/y\}/g, () => `${dd}/${mm}/${yyyy}`)
    .replace(/\{env\}/g, () => env)
    .replace(/\{type\}/g, () => type);
}

export type CicdEntryAction = 'empty' | 'added' | 'appended';

export interface CicdEntryResult {
  content: string;
  action: CicdEntryAction;
  // Set for 'appended': the line before and after the "+" was added
  previousLine?: string;
  newLine?: string;
}

/**
 * Computes the new CICD file content after adding `entry`.
 * Behavior is intentionally identical to the original DeployService.updateCICDFile.
 */
export function applyCicdEntry(content: string, entry: string, smartAppend: boolean): CicdEntryResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  // File empty
  if (lines.length === 1 && lines[0] === '') {
    return { content: entry, action: 'empty' };
  }

  const lastLine = lines.at(-1) as string;
  // If last line is empty, the entry goes after the line before it
  const index = lastLine.trim() === '' ? lines.length - 2 : lines.length - 1;

  const line = lines[index];
  const lineBase = line.replace(/\s*\++\s*$/, '').trim();
  if (!smartAppend || lineBase !== entry.trim()) {
    lines.splice(index + 1, 0, entry);
    return { content: lines.join(eol), action: 'added' };
  }

  lines.splice(index, 1, line + '+');
  return { content: lines.join(eol), action: 'appended', previousLine: line, newLine: lines[index] };
}

/** Mirrors the original `err.stderr?.toString() || err.message` used when a git command fails. */
export function getGitErrorMessage(err: unknown): string | undefined {
  const e = err as { stderr?: { toString(): string }; message?: string } | null | undefined;
  return e?.stderr?.toString() || e?.message;
}
