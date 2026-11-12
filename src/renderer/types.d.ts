// Type declarations for renderer process.
// NOTE: keep this file a global script (no top-level import/export), otherwise `Window` stops being global.
// Types shared with the main process are re-exposed through inline import() types.
type ProjectI = import('../main/interface').ProjectI;
type ConfigI = import('../main/interface').ConfigI;
type DeployOptions = import('../main/deploy-service').DeployOptions;
// start-deploy can fail before running (e.g. duplicate deploy), in which case there are no logs
type StartDeployResult = Omit<import('../main/deploy-service').DeployResult, 'logs'> & { logs?: string[] };

interface UpdateInfoI {
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  githubReleaseUrl?: string;
}

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

    // Config operations
    // Narrow with `'error' in result`
    loadConfig: () => Promise<ConfigI | ConfigErrorI>;
    saveConfig: (config: ConfigI) => Promise<{ success: boolean; error?: string }>;
    
    // Deploy operations
    canDeploy: (projectName: string) => Promise<boolean>;
    getActiveDeployments: () => Promise<string[]>;
    startDeploy: (options: DeployOptions) => Promise<StartDeployResult>;
    
    // Log operations
    getLogDir: () => Promise<string>;
    getLogFiles: () => Promise<string[]>;
    readLogFile: (filename: string) => Promise<string>;
    
    // Git operations
    getBranches: (repoPath: string) => Promise<string[]>;
    
    // Notifications
    showNotification: (title: string, body: string) => void;
    
    // Event listeners
    onDeploymentStatusChanged: (callback: (activeProjects: string[]) => void) => void;
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
