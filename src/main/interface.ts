export interface ProjectI {
  name: string;
  repoPath: string;
  envs: string[];
  deployTypes: string[];
  branchFilter: string;
  commitFormat: string;
  commitTemplate: string;
  fileContentFormat: string;
  fileContentTemplate: string;
  smartAppend: boolean;
  cicdFileName: string;
}
export interface ConfigI {
  projects: ProjectI[];
}

export interface UpdateInfoI {
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  githubReleaseUrl?: string;
}
export interface UpdateDownloadStartedI {
  version: string;
}
export interface UpdateDownloadProgressI {
  percent: number;
  downloadedMB: number;
  totalMB: number;
  speedMBps: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}
export interface UpdateDownloadedI {
  version: string;
}
export type UpdateErrorKind = 'signature' | 'download' | 'network' | 'unknown';
export interface UpdateErrorI {
  kind: UpdateErrorKind;
  // User-facing message, in Vietnamese
  message: string;
  // Raw error text, shown as technical detail
  detail: string;
}
