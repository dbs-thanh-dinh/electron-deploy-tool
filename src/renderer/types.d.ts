// Type declarations for renderer process.
// NOTE: keep this file a global script (no top-level import/export), otherwise `Window` stops being global.
// Types shared with the main process are re-exposed through inline import() types.
type ProjectI = import('../main/interface').ProjectI;
type ConfigI = import('../main/interface').ConfigI;
type DeployOptions = import('../main/deploy-service').DeployOptions;
type BranchesResultI = import('../main/branch-utils').BranchesResultI;
type DeployStepEventI = import('../main/deploy-steps').DeployStepEventI;
// start-deploy can fail before running (e.g. duplicate deploy), in which case there are no logs
type StartDeployResult = Omit<import('../main/deploy-service').DeployResult, 'logs'> & { logs?: string[] };

type UpdateInfoI = import('../main/interface').UpdateInfoI;
type UpdateDownloadStartedI = import('../main/interface').UpdateDownloadStartedI;
type UpdateDownloadProgressI = import('../main/interface').UpdateDownloadProgressI;
type UpdateDownloadedI = import('../main/interface').UpdateDownloadedI;
type UpdateErrorI = import('../main/interface').UpdateErrorI;

// load-config resolves this instead of a config when reading/parsing scripts.json fails
interface ConfigErrorI {
  error: string;
}

interface ConfirmDialogOptionsI {
  title: string;
  message: string;
  detail?: string;
}

interface Window {
  api: {
    // App info
    getAppVersion: () => Promise<string>;

    // Update operations
    onUpdateAvailable: (callback: (data: UpdateInfoI) => void) => void;
    startUpdateDownload: () => Promise<void>;
    // Resolves false when the URL is not a release page of this repository
    openReleasePage: (url: string) => Promise<boolean>;
    onUpdateDownloadStarted: (callback: (data: UpdateDownloadStartedI) => void) => void;
    onUpdateDownloadProgress: (callback: (data: UpdateDownloadProgressI) => void) => void;
    onUpdateDownloaded: (callback: (data: UpdateDownloadedI) => void) => void;
    onUpdateError: (callback: (data: UpdateErrorI) => void) => void;

    // Config operations
    // Narrow with `'error' in result`
    loadConfig: () => Promise<ConfigI | ConfigErrorI>;
    saveConfig: (config: ConfigI) => Promise<{ success: boolean; error?: string }>;
    
    // Deploy operations
    canDeploy: (projectName: string) => Promise<boolean>;
    getActiveDeployments: () => Promise<string[]>;
    startDeploy: (options: DeployOptions) => Promise<StartDeployResult>;
    // Resolves false when there is nothing to cancel or it is too late (the commit already started)
    cancelDeploy: () => Promise<boolean>;

    // Log operations
    getLogDir: () => Promise<string>;
    getLogFiles: () => Promise<string[]>;
    readLogFile: (filename: string) => Promise<string>;
    
    // Git operations
    getBranches: (repoPath: string) => Promise<BranchesResultI>;
    cancelGetBranches: () => Promise<void>;
    
    // Notifications
    showNotification: (title: string, body: string) => void;
    
    // Event listeners
    onDeploymentStatusChanged: (callback: (activeProjects: string[]) => void) => void;
    onDeployLog: (callback: (line: string) => void) => void;
    onDeployStep: (callback: (event: DeployStepEventI) => void) => void;
    onConfigUpdated: (callback: () => void) => void;
    onShowAbout: (callback: () => void) => void;

    // Dialog operations
    openDialogConfirm: (options: ConfirmDialogOptionsI) => Promise<boolean>;

    // File system
    openDirectoryDialog: () => Promise<string | null>;

    // Holidays
    loadHolidaysConfig: () => Promise<HolidayConfig>;
  };
}
