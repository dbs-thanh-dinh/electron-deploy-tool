// Main renderer script - handles navigation and theme

// Initialize all pages
document.addEventListener("DOMContentLoaded", () => {
  displayAppVersion();
  initAutoUpdateHandlers();
  initNavigation();
  initTheme();
  initDeployPage();
  initProjectsPage();
  initHistoryPage();
  initSettingsPage();

  // Listen for config updates from other windows
  window.api.onConfigUpdated(() => {
    console.log("Config updated from another window, refreshing...");
    refreshConfigFromOtherWindow();
  });

  // Live deploy log: only this window's own deploy sends these lines
  window.api.onDeployLog((line) => appendDeployLogLine(line));
  window.api.onDeployStep((event) => applyDeployStep(event));
});

function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();

      const pageName = item.getAttribute("data-page");
      if (!pageName) return;

      // Update active nav item
      navItems.forEach((nav) => nav.classList.remove("active"));
      item.classList.add("active");

      // Show corresponding page
      pages.forEach((page) => page.classList.remove("active"));
      const targetPage = document.getElementById(`${pageName}-page`);
      if (targetPage) {
        targetPage.classList.add("active");
        switch (pageName) {
          case "deploy":
            if (!isDeploying) refreshDeployConfig();
            break;
          case "projects":
            loadProjectsConfig().then(() => renderProjectsList());
            break;
          case "history":
            loadLogFiles();
            break;
        }
      }
    });
  });
}

function initTheme() {
  const themeToggle1 = document.getElementById("themeToggle") as HTMLInputElement;
  const themeToggle2 = document.getElementById("themeToggle2") as HTMLInputElement;
  const body = document.body;

  // Load saved theme preference
  const savedTheme = localStorage.getItem("theme") || "dark";
  if (savedTheme === "light") {
    body.classList.remove("dark-theme");
    body.classList.add("light-theme");
    themeToggle1.checked = false;
    themeToggle2.checked = false;
  } else {
    body.classList.remove("light-theme");
    body.classList.add("dark-theme");
    themeToggle1.checked = true;
    themeToggle2.checked = true;
  }

  // Sync both toggles
  const toggleTheme = (isDark: boolean) => {
    if (isDark) {
      body.classList.remove("light-theme");
      body.classList.add("dark-theme");
      themeToggle1.checked = true;
      themeToggle2.checked = true;
      localStorage.setItem("theme", "dark");
    } else {
      body.classList.remove("dark-theme");
      body.classList.add("light-theme");
      themeToggle1.checked = false;
      themeToggle2.checked = false;
      localStorage.setItem("theme", "light");
    }
  };

  themeToggle1.addEventListener("change", () => {
    toggleTheme(themeToggle1.checked);
  });

  themeToggle2.addEventListener("change", () => {
    toggleTheme(themeToggle2.checked);
  });
}

// ===== DEPLOY PAGE =====
let currentConfig: ConfigI | null = null;

// A valid scripts.json may contain an unrelated top-level "error" key, so also require `projects` to be missing
function isConfigError(config: ConfigI | ConfigErrorI): config is ConfigErrorI {
  return typeof (config as ConfigErrorI).error === "string" && !Array.isArray((config as Partial<ConfigI>).projects);
}
let activeDeployments: string[] = [];
let allBranches: string[] = []; // Store all branches for filtering
let branchRequestSeq = 0; // Identifies the latest branch load; older results are dropped
let isDeploying = false; // A deploy started from this window is in progress
let pendingConfigRefresh = false; // Config changed elsewhere while deploying
let pendingDeployConfigRefresh = false; // This window saved the config while deploying: only the Deploy page needs a refresh

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== TOAST / CONFIRM MODAL =====
type ToastType = "info" | "success" | "warning" | "error";

function showToast(message: string, type: ToastType = "info") {
  const container = document.getElementById("toastContainer") as HTMLDivElement;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";

  const dismiss = () => toast.remove();
  closeBtn.addEventListener("click", dismiss);
  toast.append(text, closeBtn);
  container.appendChild(toast);

  // Errors stay longer so long messages can be read
  setTimeout(dismiss, type === "error" ? 12000 : type === "warning" ? 8000 : 4000);
}

interface ConfirmModalOptionsI {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}

let resolvePendingConfirm: ((result: boolean) => void) | null = null;

function showConfirmModal(options: ConfirmModalOptionsI): Promise<boolean> {
  // A newer modal supersedes an older one: resolve the old one as cancelled
  resolvePendingConfirm?.(false);

  const modal = document.getElementById("confirmModal") as HTMLDivElement;
  const okBtn = document.getElementById("confirmModalOk") as HTMLButtonElement;
  const cancelBtn = document.getElementById("confirmModalCancel") as HTMLButtonElement;
  (document.getElementById("confirmModalTitle") as HTMLElement).textContent = options.title;
  (document.getElementById("confirmModalMessage") as HTMLElement).textContent = options.message;
  okBtn.textContent = options.confirmText ?? "OK";
  okBtn.className = `btn ${options.danger ? "btn-danger" : "btn-primary"}`;

  const previousFocus = document.activeElement as HTMLElement | null;
  modal.style.display = "flex";
  cancelBtn.focus(); // safe default

  return new Promise<boolean>((resolve) => {
    const finish = (result: boolean) => {
      modal.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeydown, true);
      resolvePendingConfirm = null;
      previousFocus?.focus();
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Tab") {
        // Keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeydown, true);
    resolvePendingConfirm = finish;
  });
}

// ===== LOG RENDERING =====
const LOG_TIMESTAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s?/;
const logSources = new WeakMap<HTMLElement, string[]>(); // plain-text entries behind a log container

function classifyLogEntry(entry: string): string {
  const text = entry.replace(LOG_TIMESTAMP_RE, "").trim();
  if (text.startsWith("❌") || /^(Error|fatal)\b/i.test(text)) return "log-error";
  if (text.startsWith("⚠") || text.startsWith("↩") || text.startsWith("⛔")) return "log-warn";
  if (text.startsWith("✅") || text.startsWith("✓")) return "log-success";
  if (text.startsWith("$ ")) return "log-cmd";
  if (text.startsWith("ℹ") || text.startsWith("DRY-RUN")) return "log-info";
  if (text.startsWith("🚀") || text.startsWith("====")) return "log-head";
  return "";
}

function createLogEntryElement(entry: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `log-line ${classifyLogEntry(entry)}`.trim();
  el.textContent = entry;
  return el;
}

// Lines without a timestamp continue the previous entry (multi-line git output)
function groupLogEntries(lines: string[]): string[] {
  const entries: string[] = [];
  for (const line of lines) {
    if (entries.length > 0 && !LOG_TIMESTAMP_RE.test(line)) {
      entries[entries.length - 1] += `\n${line}`;
    } else {
      entries.push(line);
    }
  }
  return entries;
}

function renderLogLines(container: HTMLElement, lines: string[]) {
  const entries = groupLogEntries(lines);
  logSources.set(container, entries);
  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => fragment.appendChild(createLogEntryElement(entry)));
  container.replaceChildren(fragment);
  container.scrollTop = container.scrollHeight;
}

// Append one entry; stays pinned to the bottom only if the user was already there
function appendLogLine(container: HTMLElement, line: string, forceNewEntry = false) {
  const entries = logSources.get(container) ?? [];
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

  if (!forceNewEntry && entries.length > 0 && !LOG_TIMESTAMP_RE.test(line)) {
    entries[entries.length - 1] += `\n${line}`;
    (container.lastElementChild as HTMLElement).textContent = entries[entries.length - 1];
  } else {
    entries.push(line);
    container.appendChild(createLogEntryElement(line));
  }
  logSources.set(container, entries);
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function clearLogContainer(container: HTMLElement) {
  logSources.set(container, []);
  container.replaceChildren();
}

function getLogText(container: HTMLElement): string {
  return (logSources.get(container) ?? []).join("\n");
}

const PROTECTED_BRANCH_RE = /^(main|master|stage|staging|prod|production)$/i;

async function refreshConfigFromOtherWindow() {
  if (isDeploying) {
    // Apply once the running deploy finishes so its log is not lost
    pendingConfigRefresh = true;
    return;
  }
  pendingConfigRefresh = false;
  pendingDeployConfigRefresh = false;

  await refreshDeployConfig();
  await loadProjectsConfig();

  // Editing index may no longer point to the same project
  if (editingProjectIndex !== null) {
    hideForm();
  }
  renderProjectsList();
}

// Reload config for the deploy page while keeping the selected project and options when still valid
async function refreshDeployConfig() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const selectedName = projectSelect.value;

  await loadDeployConfig();

  const project = currentConfig?.projects?.find((p) => p.name === selectedName);
  if (project) {
    projectSelect.value = selectedName;
    populateProjectOptions(project, true);
  } else {
    resetDeployDependents();
  }
}

function resetDeployDependents() {
  // Drop any in-flight branch load: invalidate its result, hide the spinner, abort the git fetch
  branchRequestSeq++;
  const branchLoading = document.getElementById("branchLoading") as HTMLDivElement;
  branchLoading.style.display = "none";
  (document.getElementById("branchError") as HTMLDivElement).style.display = "none";
  (document.getElementById("projectOptionsWarning") as HTMLDivElement).style.display = "none";
  window.api.cancelGetBranches();

  const branchFilter = document.getElementById("branchFilter") as HTMLInputElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const commitTemplate = document.getElementById("commitTemplate") as HTMLInputElement;
  const fileContentTemplate = document.getElementById("fileContentTemplate") as HTMLInputElement;

  allBranches = [];
  branchFilter.value = "";
  branchFilter.disabled = true;
  branchSelect.innerHTML = '<option value="">Select branch...</option>';
  branchSelect.disabled = true;
  envSelect.innerHTML = '<option value="">Select environment...</option>';
  envSelect.disabled = true;
  typeSelect.innerHTML = '<option value="">Select type...</option>';
  typeSelect.disabled = true;
  commitTemplate.value = "";
  commitTemplate.disabled = true;
  fileContentTemplate.value = "";
  fileContentTemplate.disabled = true;
  updateDeployButtonState();
}

// Fill env / type / template controls for a project; keeps the current choice only when preserveSelection is set
function populateProjectOptions(project: ProjectI, preserveSelection = false) {
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const commitTemplate = document.getElementById("commitTemplate") as HTMLInputElement;
  const fileContentTemplate = document.getElementById("fileContentTemplate") as HTMLInputElement;
  const previousEnv = preserveSelection ? envSelect.value : "";
  const previousType = preserveSelection ? typeSelect.value : "";

  envSelect.innerHTML = '<option value="">Select environment...</option>';
  project.envs.forEach((env: string) => {
    const option = document.createElement("option");
    option.value = env;
    option.textContent = env;
    envSelect.appendChild(option);
  });
  if (project.envs.includes(previousEnv)) envSelect.value = previousEnv;
  envSelect.disabled = false;

  typeSelect.innerHTML = '<option value="">Select type...</option>';
  project.deployTypes.forEach((type: string) => {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    typeSelect.appendChild(option);
  });
  if (project.deployTypes.includes(previousType)) typeSelect.value = previousType;
  typeSelect.disabled = false;

  commitTemplate.value = project.commitTemplate;
  commitTemplate.disabled = false;
  fileContentTemplate.value = project.fileContentTemplate;
  fileContentTemplate.disabled = false;

  // A hand-edited project can have no environments/types; say why Deploy stays disabled
  const missing = [
    project.envs.length === 0 ? "environments" : "",
    project.deployTypes.length === 0 ? "deploy types" : "",
  ].filter(Boolean);
  const optionsWarning = document.getElementById("projectOptionsWarning") as HTMLDivElement;
  optionsWarning.textContent = missing.length
    ? `Project "${project.name}" has no ${missing.join(" or ")} configured. Edit it on the Projects page to enable deploying.`
    : "";
  optionsWarning.style.display = missing.length ? "block" : "none";

  updateDeployButtonState();
}

async function initDeployPage() {
  await loadDeployConfig();
  setupDeployEventListeners();

  // Listen for deployment status changes from other windows
  window.api.onDeploymentStatusChanged((projects: string[]) => {
    activeDeployments = projects;
    updateDeployButtonState();
    if (projectsConfig !== null || projectsConfigError !== null) renderProjectsList();
  });

  // Load initial active deployments
  activeDeployments = await window.api.getActiveDeployments();
  updateDeployButtonState();
}

async function loadDeployConfig() {
  try {
    const config = await window.api.loadConfig();
    if (isConfigError(config)) {
      // Alert only here: the projects page loads the same config and reports to the console
      currentConfig = null;
      console.error("Failed to load config:", config.error);
      showToast(`Failed to load configuration: ${config.error}`, "error");
    } else {
      currentConfig = config;
    }
    populateProjectSelect();
  } catch (err) {
    console.error("Failed to load config:", err);
    showToast("Failed to load configuration", "error");
  }
}

function populateProjectSelect() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  projectSelect.innerHTML = '<option value="">Select a project...</option>';

  if (currentConfig && currentConfig.projects) {
    currentConfig.projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.name;
      option.textContent = project.name;
      projectSelect.appendChild(option);
    });
  }
}

function setupDeployEventListeners() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchFilter = document.getElementById('branchFilter') as HTMLInputElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const deployBtn = document.getElementById("deployBtn") as HTMLButtonElement;
  const clearLogBtn = document.getElementById("clearLogBtn") as HTMLButtonElement;
  const commitTemplate = document.getElementById("commitTemplate") as HTMLInputElement;
  const fileContentTemplate = document.getElementById("fileContentTemplate") as HTMLInputElement;

  const branchLoading = document.getElementById("branchLoading") as HTMLDivElement;
  const cancelBranchesBtn = document.getElementById("cancelBranchesBtn") as HTMLButtonElement;

  cancelBranchesBtn.addEventListener("click", () => {
    // Back to "no project selected"; resetDeployDependents aborts the request and drops its result
    projectSelect.value = "";
    resetDeployDependents();
  });

  projectSelect.addEventListener("change", async () => {
    const projectName = projectSelect.value;
    if (!projectName) {
      resetDeployDependents();
      return;
    }

    // Clear and disable dependent selects
    const requestSeq = ++branchRequestSeq; // invalidates the previous project's load
    branchLoading.style.display = "none";
    (document.getElementById("branchError") as HTMLDivElement).style.display = "none";
    (document.getElementById("projectOptionsWarning") as HTMLDivElement).style.display = "none";
    branchSelect.disabled = true;
    envSelect.disabled = true;
    typeSelect.disabled = true;
    deployBtn.disabled = true;
    commitTemplate.disabled = true;
    fileContentTemplate.disabled = true;

    const project = currentConfig!.projects.find((p) => p.name === projectName);
    if (!project) return;

    // Load branches from git repo
    branchFilter.disabled = true;
    branchSelect.disabled = true;
    branchSelect.innerHTML = '<option value="">Loading branches...</option>';

    branchLoading.style.display = "flex";
    const { branches, error: branchesError } = await window.api.getBranches(project.repoPath);
    // Ignore stale result if the user picked another project (even A -> B -> A) or cancelled while loading
    if (requestSeq !== branchRequestSeq) return;
    branchLoading.style.display = "none";
    const branchError = document.getElementById("branchError") as HTMLDivElement;
    branchError.textContent = branchesError ?? "";
    branchError.style.display = branchesError ? "block" : "none";
    allBranches = branches; // Store for filtering

    // Populate branches
    populateBranchSelect(branches);
    branchFilter.disabled = false;
    branchSelect.disabled = false;
    
    if (project.branchFilter) {
      branchFilter.value = project.branchFilter;
      handleBranchFilter();
    } else {
      branchFilter.value = '';
    }

    populateProjectOptions(project);
  });

  branchFilter.addEventListener('input', handleBranchFilter);
  branchSelect.addEventListener("change", updateDeployButtonState);
  envSelect.addEventListener("change", updateDeployButtonState);
  typeSelect.addEventListener("change", updateDeployButtonState);

  deployBtn.addEventListener("click", handleDeploy);
  clearLogBtn.addEventListener("click", () => {
    clearLogOutput();
  });

  (document.getElementById("cancelDeployBtn") as HTMLButtonElement).addEventListener("click", handleCancelDeploy);

  const copyLogBtn = document.getElementById("copyLogBtn") as HTMLButtonElement;
  copyLogBtn.addEventListener("click", async () => {
    const text = getLogText(document.getElementById("deployLog") as HTMLDivElement);
    if (!text) {
      showToast("Log is empty", "warning");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("Log copied to clipboard", "success");
    } catch (err: unknown) {
      showToast(`Failed to copy log: ${(err as Error).message}`, "error");
    }
  });

  const dryRunCheck = document.getElementById("dryRunCheck") as HTMLInputElement;
  const dryRunBadge = document.getElementById("dryRunBadge") as HTMLSpanElement;
  const syncDryRunBadge = () => {
    dryRunBadge.style.display = dryRunCheck.checked ? "inline-block" : "none";
  };
  dryRunCheck.addEventListener("change", syncDryRunBadge);
  syncDryRunBadge();

}

function updateDeployButtonState() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const deployBtn = document.getElementById("deployBtn") as HTMLButtonElement;

  const projectName = projectSelect.value;
  const isProjectBeingDeployed = projectName && activeDeployments.includes(projectName);

  if (isDeploying) {
    deployBtn.disabled = true;
    deployBtn.querySelector(".btn-text")!.textContent = "Deploying...";
  } else if (isProjectBeingDeployed) {
    deployBtn.disabled = true;
    deployBtn.querySelector(".btn-text")!.textContent = `${projectName} is being deployed`;
  } else if (projectName && branchSelect.value && envSelect.value && typeSelect.value) {
    deployBtn.disabled = false;
    deployBtn.querySelector(".btn-text")!.textContent = "Start Deploy";
  } else {
    deployBtn.disabled = true;
    deployBtn.querySelector(".btn-text")!.textContent = "Start Deploy";
  }
}

function handleBranchFilter() {
  const branchFilter = document.getElementById('branchFilter') as HTMLInputElement;
  // Branch filter
  const filterText = branchFilter.value.toLowerCase().trim();
  
  if (filterText) {
    // Filter branches
    const filtered = allBranches.filter(branch => 
      branch.toLowerCase().includes(filterText)
    );
    populateBranchSelect(filtered);
    
    // Show count in placeholder if filtering
    if (filtered.length < allBranches.length) {
      branchFilter.placeholder = `Showing ${filtered.length} of ${allBranches.length} branches`;
    } else {
      branchFilter.placeholder = 'Filter branches...';
    }
  } else {
    // No filter, show all branches
    populateBranchSelect(allBranches);
    branchFilter.placeholder = 'Filter branches...';
  }
}

function populateBranchSelect(branches: string[]) {
  const branchSelect = document.getElementById('branchSelect') as HTMLSelectElement;
  const currentValue = branchSelect.value;
  
  branchSelect.innerHTML = '<option value="">Select branch...</option>';
  
  branches.forEach(branch => {
    const option = document.createElement('option');
    option.value = branch;
    option.textContent = branch;
    branchSelect.appendChild(option);
  });
  
  // Restore selection if still in filtered list
  if (currentValue && branches.includes(currentValue)) {
    branchSelect.value = currentValue;
  }
}

function appendDeployLogLine(line: string) {
  if (!isDeploying) return;
  const logOutput = document.getElementById("deployLog") as HTMLDivElement;
  appendLogLine(logOutput, line);
}

// ===== DEPLOY PROGRESS (stepper + cancel) =====
function getStepElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#deployProgress .deploy-step"));
}

function resetDeployProgress() {
  (document.getElementById("deployProgress") as HTMLDivElement).style.display = "block";
  getStepElements().forEach((el) => (el.dataset.status = "pending"));
  const cancelBtn = document.getElementById("cancelDeployBtn") as HTMLButtonElement;
  cancelBtn.style.display = "";
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancel deploy";
  (document.getElementById("cancelDeployHint") as HTMLSpanElement).textContent = "";
}

function applyDeployStep(event: DeployStepEventI) {
  if (!isDeploying) return;
  getStepElements()
    .filter((el) => el.dataset.step === event.step)
    .forEach((el) => (el.dataset.status = event.status));
  if (event.step === "commit" && event.status === "running") {
    // Past the point of no return: the commit and push always complete
    (document.getElementById("cancelDeployBtn") as HTMLButtonElement).disabled = true;
    (document.getElementById("cancelDeployHint") as HTMLSpanElement).textContent = "Commit started - can no longer cancel";
  }
}

function hideCancelButton() {
  (document.getElementById("cancelDeployBtn") as HTMLButtonElement).style.display = "none";
  (document.getElementById("cancelDeployHint") as HTMLSpanElement).textContent = "";
}

async function handleCancelDeploy() {
  const cancelBtn = document.getElementById("cancelDeployBtn") as HTMLButtonElement;
  const hint = document.getElementById("cancelDeployHint") as HTMLSpanElement;
  cancelBtn.disabled = true;
  cancelBtn.textContent = "Cancelling...";
  try {
    const accepted = await window.api.cancelDeploy();
    if (accepted) {
      hint.textContent = "Stops after the current git command (a running pull is interrupted)";
    } else {
      cancelBtn.textContent = "Cancel deploy";
      showToast("Too late to cancel: the commit has already started", "warning");
    }
  } catch (err: unknown) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = "Cancel deploy";
    showToast(`Failed to cancel: ${(err as Error).message}`, "error");
  }
}

function clearLogOutput() {
  clearLogContainer(document.getElementById("deployLog") as HTMLDivElement);
}

async function handleDeploy() {
  if (isDeploying) return;
  isDeploying = true;
  updateDeployButtonState();
  document.querySelector('.nav-item[data-page="deploy"]')?.classList.add("deploying");

  try {
    await runDeploy();
  } finally {
    isDeploying = false;
    document.querySelector('.nav-item[data-page="deploy"]')?.classList.remove("deploying");
    updateDeployButtonState();
    if (pendingConfigRefresh) {
      refreshConfigFromOtherWindow();
    } else if (pendingDeployConfigRefresh) {
      // Not refreshConfigFromOtherWindow: that closes an open Edit form and would discard what the user is typing
      pendingDeployConfigRefresh = false;
      refreshDeployConfig();
    }
  }
}

async function runDeploy() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const dryRunCheck = document.getElementById("dryRunCheck") as HTMLInputElement;
  const commitTemplateInput = document.getElementById("commitTemplate") as HTMLInputElement;
  const fileContentTemplateInput = document.getElementById("fileContentTemplate") as HTMLInputElement;
  const logOutput = document.getElementById("deployLog") as HTMLDivElement;

  const projectName = projectSelect.value;
  const branch = branchSelect.value;
  const env = envSelect.value;
  const type = typeSelect.value;
  const dryRun = dryRunCheck.checked;
  const commitTemplate = commitTemplateInput.value;
  const fileContentTemplate = fileContentTemplateInput.value;

  // Check if can deploy
  const canDeploy = await window.api.canDeploy(projectName);
  if (!canDeploy) {
    showToast(`Project ${projectName} is already being deployed`, "warning");
    return;
  }

  const project = currentConfig!.projects.find((p) => p.name === projectName);
  if (!project) return;

  const protectedWarning = PROTECTED_BRANCH_RE.test(branch.trim())
    ? `\n⚠ "${branch}" is a protected/shared branch - this push may trigger a real pipeline.`
    : "";
  const confirmed = await window.api.openDialogConfirm({
    title: "Confirm Deploy",
    message: `Deploy project "${projectName}" to environment "${env}" with type "${type}"?`,
    detail: `Branch: ${branch}${dryRun ? "\nMode: DRY RUN (no push)" : ""}${protectedWarning}`,
  });
  if (!confirmed) return;

  // Disable form
  setFormEnabled(false);
  resetDeployProgress();
  clearLogContainer(logOutput);
  let cancelled = false;

  try {
    const result = await window.api.startDeploy({
      project,
      branch,
      env,
      type,
      dryRun,
      commitTemplate,
      fileContentTemplate,
    });

    // Display the complete log (replaces the streamed lines, so nothing is lost if one was dropped)
    if (result.logs) {
      renderLogLines(logOutput, result.logs);
    }

    // Decide from the result only: a Cancel click can race with the commit starting
    if (result.success) {
      window.api.showNotification("Deploy Completed", `${projectName} deployed successfully to ${env}`);
    } else if (result.cancelled) {
      cancelled = true;
      window.api.showNotification("Deploy Cancelled", `${projectName} deploy was cancelled`);
    } else {
      window.api.showNotification("Deploy Failed", result.error || "Unknown error occurred");
    }
  } catch (err: unknown) {
    const message = (err as Error).message;
    appendLogLine(logOutput, `Error: ${message}`, true);
    window.api.showNotification("Deploy Error", message);
  } finally {
    // A step still "running" here (startDeploy threw, or its final event was lost) must not spin forever
    getStepElements()
      .filter((el) => el.dataset.status === "running")
      .forEach((el) => (el.dataset.status = cancelled ? "cancelled" : "failed"));
    hideCancelButton();
    setFormEnabled(true);
  }
}

function setFormEnabled(enabled: boolean) {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const dryRunCheck = document.getElementById("dryRunCheck") as HTMLInputElement;
  const deployBtn = document.getElementById("deployBtn") as HTMLButtonElement;

  projectSelect.disabled = !enabled;
  branchSelect.disabled = !enabled || !projectSelect.value;
  envSelect.disabled = !enabled || !projectSelect.value;
  typeSelect.disabled = !enabled || !projectSelect.value;
  dryRunCheck.disabled = !enabled;
  deployBtn.disabled = !enabled;
}

// ===== PROJECTS PAGE =====
let projectsConfig: ConfigI | null = null;
let projectsConfigError: string | null = null; // Why projectsConfig is null after the last load
let editingProjectIndex: number | null = null;

async function initProjectsPage() {
  await loadProjectsConfig();
  renderProjectsList();
  setupProjectsEventListeners();
}

async function loadProjectsConfig() {
  try {
    const config = await window.api.loadConfig();
    if (isConfigError(config)) {
      projectsConfig = null;
      projectsConfigError = config.error;
      console.error("Failed to load config:", config.error);
    } else {
      projectsConfig = config;
      projectsConfigError = null;
    }
  } catch (err) {
    projectsConfigError = (err as Error).message;
    console.error("Failed to load config:", err);
    showToast("Failed to load configuration", "error");
  }
}

function renderProjectsList() {
  const container = document.getElementById("projectsList") as HTMLDivElement;
  container.innerHTML = "";

  // Adding is pointless (and saving is blocked) while the config is not loaded
  (document.getElementById("addProjectBtn") as HTMLButtonElement).disabled = projectsConfig === null;

  if (projectsConfig === null && projectsConfigError) {
    container.innerHTML = `<p style="color: var(--danger, #e5534b); text-align: center; padding: 40px;">Failed to load configuration: ${escapeHtml(projectsConfigError)}<br>Fix scripts.json and reload (Ctrl+R).</p>`;
    return;
  }

  if (!projectsConfig?.projects || projectsConfig.projects.length === 0) {
    container.innerHTML =
      '<p style="color: var(--text-muted); text-align: center; padding: 40px;">No projects yet. Click "Add Project" to get started.</p>';
    return;
  }

  projectsConfig.projects.forEach((project, index: number) => {
    const lockAttrs = isProjectDeploying(project.name) ? ' disabled title="Being deployed - wait until the deploy finishes"' : "";
    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `
      <div class="project-card-header">
        <h3>${escapeHtml(project.name)}</h3>
        <div class="project-card-actions">
          <button class="btn btn-small edit-btn" data-index="${index}"${lockAttrs}>Edit</button>
          <button class="btn btn-small btn-danger delete-btn" data-index="${index}"${lockAttrs}>Delete</button>
        </div>
      </div>
      <div class="project-card-body">
        <div class="project-detail"><strong>Path:</strong> ${escapeHtml(project.repoPath)}</div>
        <div class="project-detail"><strong>Environments:</strong> ${escapeHtml(project.envs.join(", "))}</div>
        <div class="project-detail"><strong>Deploy Types:</strong> ${escapeHtml(project.deployTypes.join(", "))}</div>
        <div class="project-detail"><strong>Branch filter:</strong> ${escapeHtml(project.branchFilter)}</div>
        <div class="project-detail"><strong>Commit Template:</strong> ${escapeHtml(project.commitTemplate)}</div>
        <div class="project-detail"><strong>CICD File Name:</strong> ${escapeHtml(project.cicdFileName)}</div>
        <div class="project-detail"><strong>File Content Template:</strong> ${escapeHtml(project.fileContentTemplate)}</div>
        <div class="project-detail"><strong>Smart Append:</strong> ${project.smartAppend ? "Yes" : "No"}</div>
      </div>
    `;
    container.appendChild(card);
  });

  // Attach event listeners to edit/delete buttons
  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt((e.target as HTMLElement).getAttribute("data-index")!);
      editProject(index);
    });
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt((e.target as HTMLElement).getAttribute("data-index")!);
      deleteProject(index);
    });
  });
}

function setupProjectsEventListeners() {
  const addBtn = document.getElementById("addProjectBtn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancelFormBtn") as HTMLButtonElement;
  const saveBtn = document.getElementById("saveProjectBtn") as HTMLButtonElement;
  const browseBtn = document.getElementById('browseRepoBtn') as HTMLButtonElement;
  const commitFormatSelect = document.getElementById("projectCommitFormat") as HTMLSelectElement;
  const fileContentFormatSelect = document.getElementById("projectFileContentFormat") as HTMLSelectElement;
  
  addBtn.addEventListener("click", showAddForm);
  cancelBtn.addEventListener("click", hideForm);
  saveBtn.addEventListener("click", saveProject);
  browseBtn.addEventListener('click', handleBrowseRepo);
  commitFormatSelect.addEventListener("change", handleCommitFormatSelectChange);
  fileContentFormatSelect.addEventListener("change", handleFileContentFormatSelectChange);
}

function showAddForm() {
  editingProjectIndex = null;
  const formContainer = document.getElementById("projectFormContainer") as HTMLDivElement;
  const formTitle = document.getElementById("formTitle") as HTMLHeadingElement;

  formTitle.textContent = "Add New Project";
  clearProjectForm();
  formContainer.style.display = "block";

  // Scroll to form
  formContainer.scrollIntoView({ behavior: "smooth" });
}

// A project being deployed (in any window) must not be renamed or deleted: deploys are tracked by project name
function isProjectDeploying(name: string): boolean {
  return activeDeployments.includes(name);
}

function editProject(index: number) {
  const project = projectsConfig!.projects[index];
  if (isProjectDeploying(project.name)) {
    showToast(`Project "${project.name}" is being deployed; edit it after the deploy finishes`, "warning");
    return;
  }
  editingProjectIndex = index;
  const formContainer = document.getElementById("projectFormContainer") as HTMLDivElement;
  const formTitle = document.getElementById("formTitle") as HTMLHeadingElement;

  formTitle.textContent = "Edit Project";

  (document.getElementById("projectName") as HTMLInputElement).value = project.name;
  (document.getElementById("repoPath") as HTMLInputElement).value = project.repoPath;
  (document.getElementById("envs") as HTMLInputElement).value = project.envs.join(", ");
  (document.getElementById("deployTypes") as HTMLInputElement).value = project.deployTypes.join(", ");
  (document.getElementById("projectBranchFilter") as HTMLInputElement).value = project.branchFilter;
  (document.getElementById("projectCICDFileName") as HTMLInputElement).value = project.cicdFileName;
  (document.getElementById("projectFileContentSmartAppend") as HTMLInputElement).checked = project.smartAppend || false;
  const commitFormatSelect = document.getElementById("projectCommitFormat") as HTMLSelectElement;
  commitFormatSelect.value = project.commitFormat || "v1";

  const commitTemplateInput = document.getElementById("projectCommitTemplate") as HTMLInputElement;
  commitTemplateInput.value = project.commitTemplate || "";
  commitTemplateInput.disabled = commitFormatSelect.value !== 'custom';

  const fileContentFormatSelect = document.getElementById("projectFileContentFormat") as HTMLSelectElement;
  fileContentFormatSelect.value = project.fileContentFormat || "";
  
  const fileContentTemplateInput = document.getElementById("projectFileContentTemplate") as HTMLInputElement;
  fileContentTemplateInput.value = project.fileContentTemplate || "";
  fileContentTemplateInput.disabled = fileContentFormatSelect.value !== 'custom';

  formContainer.style.display = "block";
  formContainer.scrollIntoView({ behavior: "smooth" });
}

async function deleteProject(index: number) {
  const project = projectsConfig!.projects[index];
  if (isProjectDeploying(project.name)) {
    showToast(`Project "${project.name}" is being deployed; delete it after the deploy finishes`, "warning");
    return;
  }
  const confirmed = await showConfirmModal({
    title: "Delete project",
    message: `Are you sure you want to delete project "${project.name}"?`,
    confirmText: "Delete",
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  // The modal is async: another window may have replaced the config meanwhile, so re-locate by name
  const cfg = projectsConfig;
  const currentIndex = cfg ? cfg.projects.findIndex((p) => p.name === project.name) : -1;
  if (!cfg || currentIndex === -1) {
    showToast(`Project "${project.name}" no longer exists`, "warning");
    renderProjectsList();
    return;
  }
  if (isProjectDeploying(project.name)) {
    // A deploy of this project started while the confirmation was open
    showToast(`Project "${project.name}" is being deployed; delete it after the deploy finishes`, "warning");
    return;
  }

  // Editing index may point to a different project after the splice
  if (editingProjectIndex !== null) {
    hideForm();
  }
  const snapshot = structuredClone(cfg.projects);
  cfg.projects.splice(currentIndex, 1);
  if (!(await saveProjectsConfig())) {
    // Skip if another window's update replaced the config while saving
    if (projectsConfig === cfg) cfg.projects = snapshot;
  }
  renderProjectsList();
}

function hideForm() {
  const formContainer = document.getElementById("projectFormContainer") as HTMLDivElement;
  formContainer.style.display = "none";
  clearProjectForm();
  editingProjectIndex = null;
}

function clearProjectForm() {
  (document.getElementById("projectName") as HTMLInputElement).value = "";
  (document.getElementById("repoPath") as HTMLInputElement).value = "";
  (document.getElementById("envs") as HTMLInputElement).value = "";
  (document.getElementById("deployTypes") as HTMLInputElement).value = "";
  (document.getElementById("projectBranchFilter") as HTMLInputElement).value = "";
  (document.getElementById("projectCICDFileName") as HTMLInputElement).value = "CICD.txt";
  (document.getElementById("projectFileContentSmartAppend") as HTMLInputElement).checked = false;

  (document.getElementById("projectCommitFormat") as HTMLSelectElement).value = "v1";
  const commitTemplateInput = document.getElementById("projectCommitTemplate") as HTMLInputElement;
  commitTemplateInput.value = "deploy: {env}, {type}";
  commitTemplateInput.disabled = true;

  (document.getElementById("projectFileContentFormat") as HTMLSelectElement).value = "default";
  const fileContentTemplateInput = document.getElementById("projectFileContentTemplate") as HTMLInputElement;
  fileContentTemplateInput.value = "deploy: {env}, {type}";
  fileContentTemplateInput.disabled = true;
}

async function saveProject() {
  const name = (document.getElementById("projectName") as HTMLInputElement).value.trim();
  const repoPath = (document.getElementById("repoPath") as HTMLInputElement).value.trim();
  const envsStr = (document.getElementById("envs") as HTMLInputElement).value.trim();
  const typesStr = (document.getElementById("deployTypes") as HTMLInputElement).value.trim();
  const branchFilterStr = (document.getElementById("projectBranchFilter") as HTMLInputElement).value.trim();
  const commitFormat = (document.getElementById("projectCommitFormat") as HTMLSelectElement).value.trim();
  const commitTemplate = (document.getElementById("projectCommitTemplate") as HTMLInputElement).value.trim();
  const cicdFileName = (document.getElementById("projectCICDFileName") as HTMLInputElement).value.trim();
  const fileContentFormat = (document.getElementById("projectFileContentFormat") as HTMLSelectElement).value.trim();
  const fileContentTemplate = (document.getElementById("projectFileContentTemplate") as HTMLInputElement).value.trim();
  const smartAppendCheck = (document.getElementById("projectFileContentSmartAppend") as HTMLInputElement).checked;

  if (!projectsConfig?.projects) {
    showToast("Configuration is not loaded. Please reload the app.", "error");
    return;
  }

  // Validation
  if (!name || !repoPath || !envsStr || !typesStr || (commitFormat === "custom" && !commitTemplate) || !cicdFileName) {
    showToast("All fields are required", "warning");
    return;
  }

  const envs = envsStr
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e);
  const deployTypes = typesStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  if (envs.length === 0 || deployTypes.length === 0) {
    showToast("Please provide at least one environment and one deploy type", "warning");
    return;
  }

  const project = {
    name,
    repoPath,
    envs,
    deployTypes,
    branchFilter: branchFilterStr,
    commitFormat,
    fileContentFormat,
    commitTemplate,
    cicdFileName,
    fileContentTemplate,
    smartAppend: smartAppendCheck,
  };

  if (editingProjectIndex !== null) {
    const edited = projectsConfig.projects[editingProjectIndex];
    if (edited && isProjectDeploying(edited.name)) {
      showToast(`Project "${edited.name}" is being deployed; save your changes after the deploy finishes`, "warning");
      return;
    }
  }

  if (projectsConfig.projects.some((p, i: number) => p.name === name && i !== editingProjectIndex)) {
    showToast(`Project with name "${name}" already exists`, "warning");
    return;
  }

  // Keep a snapshot so a rejected save does not leave unsaved changes in memory
  const cfg = projectsConfig;
  const snapshot = structuredClone(cfg.projects);
  if (editingProjectIndex !== null) {
    // Edit existing
    projectsConfig.projects[editingProjectIndex] = project;
  } else {
    // Add new
    projectsConfig.projects.push(project);
  }

  if (!(await saveProjectsConfig())) {
    // Skip if another window's update replaced the config while saving
    if (projectsConfig === cfg) cfg.projects = snapshot;
    return; // keep the form open so the user can fix the input
  }
  hideForm();
  renderProjectsList();
}

async function handleBrowseRepo() {
  const repoPathInput = document.getElementById('repoPath') as HTMLInputElement;
  
  const selectedPath = await window.api.openDirectoryDialog();
  if (selectedPath) {
    repoPathInput.value = selectedPath;
  }
}

async function handleCommitFormatSelectChange() {
  const commitFormatSelect = document.getElementById("projectCommitFormat") as HTMLSelectElement;
  const commitTemplateInput = document.getElementById("projectCommitTemplate") as HTMLInputElement;
  const fileContentFormatSelect = document.getElementById("projectFileContentFormat") as HTMLSelectElement;
  const fileContentTemplateInput = document.getElementById("projectFileContentTemplate") as HTMLInputElement;

  switch (commitFormatSelect.value) {
    case 'v2':
      commitTemplateInput.disabled = true;
      commitTemplateInput.value = "deploy-v2: {env}, {type}";
      break;
    case 'custom':
      commitTemplateInput.disabled = false;
      break;
    default:
      commitTemplateInput.disabled = true;
      commitTemplateInput.value = "deploy: {env}, {type}";
      break;
  }

  if (fileContentFormatSelect.value === 'default') {
    fileContentTemplateInput.value = commitTemplateInput.value;
  }
}

async function handleFileContentFormatSelectChange() {
  const fileContentFormatSelect = document.getElementById("projectFileContentFormat") as HTMLSelectElement;
  const fileContentTemplateInput = document.getElementById("projectFileContentTemplate") as HTMLInputElement;
  
  if (fileContentFormatSelect.value === 'custom') {
    fileContentTemplateInput.disabled = false;
  } else {
    fileContentTemplateInput.disabled = true;
    const commitTemplateInput = document.getElementById("projectCommitTemplate") as HTMLInputElement;
    fileContentTemplateInput.value = commitTemplateInput.value || "deploy: {env}, {type}";
  }
}

// Returns true when the config was saved
async function saveProjectsConfig(): Promise<boolean> {
  try {
    const result = await window.api.saveConfig(projectsConfig!);
    if (!result.success) {
      showToast(`Failed to save config: ${result.error}`, "error");
      return false;
    }
    // Saving does not notify this window; the Deploy page keeps its old config until the running deploy ends
    if (isDeploying) pendingDeployConfigRefresh = true;
    return true;
  } catch (err: unknown) {
    showToast(`Error saving config: ${(err as Error).message}`, "error");
    return false;
  }
}

// ===== HISTORY PAGE =====
async function initHistoryPage() {
  await loadLogFiles();
  setupHistoryEventListeners();
}

function setupHistoryEventListeners() {
  const refreshBtn = document.getElementById("refreshHistoryBtn") as HTMLButtonElement;
  refreshBtn.addEventListener("click", loadLogFiles);
}

async function loadLogFiles() {
  try {
    const files = await window.api.getLogFiles();
    renderLogFilesList(files);
  } catch (err) {
    console.error("Failed to load log files:", err);
  }
}

function renderLogFilesList(files: string[]) {
  const container = document.getElementById("logFilesList") as HTMLDivElement;
  container.innerHTML = "";

  if (files.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">No log files found</p>';
    return;
  }

  files.forEach((file) => {
    const item = document.createElement("div");
    item.className = "log-file-item";
    item.textContent = file;
    item.addEventListener("click", () => {
      selectLogFile(file);
      // Update active state
      document.querySelectorAll(".log-file-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
    });
    container.appendChild(item);
  });
}

async function selectLogFile(filename: string) {
  try {
    const content = await window.api.readLogFile(filename);
    const logContent = document.getElementById("logContent") as HTMLDivElement;
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop(); // file ends with a newline
    renderLogLines(logContent, lines);
  } catch (err) {
    console.error("Failed to read log file:", err);
  }
}

// ===== SETTINGS PAGE =====
async function initSettingsPage() {
  await displayLogDirectory();
}

async function displayLogDirectory() {
  const logDirPath = document.getElementById("logDirPath") as HTMLParagraphElement;
  try {
    const logDir = await window.api.getLogDir();
    logDirPath.textContent = logDir;
  } catch (err) {
    console.error("Failed to get log directory:", err);
  }
}

async function displayAppVersion() {
  try {
    const version = await window.api.getAppVersion();
    const versionElements = document.querySelectorAll('.app-version');
    versionElements.forEach(el => {
      el.textContent = version;
    });
  } catch (err) {
    console.error('Failed to get app version:', err);
  }
}

function initAutoUpdateHandlers() {
  const updateAvailablePopup = document.getElementById('updateAvailablePopup') as HTMLDivElement;
  const remindLaterBtn = document.getElementById('remindLaterBtn') as HTMLButtonElement;
  const viewReleaseNotesBtn = document.getElementById('viewReleaseNotesBtn') as HTMLButtonElement;
  const closeUpdatePopupBtn = document.getElementById('closeUpdatePopupBtn') as HTMLButtonElement;
  const downloadNowBtn = document.getElementById('downloadNowBtn') as HTMLButtonElement;
  // Release page of the version shown in the popup, used by the manual-install buttons
  let latestReleaseUrl = '';

  initUpdateDownloadHandlers(() => latestReleaseUrl);

  // Listen for update available event from main process
  window.api.onUpdateAvailable?.((data) => {
    showUpdateAvailablePopup(data);
  });

  // Download the update in-app; progress is reported through the update-download-* events
  downloadNowBtn.addEventListener('click', () => {
    updateAvailablePopup.style.display = 'none';
    window.api.startUpdateDownload();
  });

  function showUpdateAvailablePopup(info: UpdateInfoI) {
    updateAvailablePopup.style.display = 'flex';
    latestReleaseUrl = info.githubReleaseUrl || '';
    
    // Update version info
    const latestVersionText = document.getElementById('latestVersionText') as HTMLElement;
    if (latestVersionText) {
      latestVersionText.textContent = info.version || 'Unknown';
    }

    // Setup GitHub release link
    const githubReleaseLink = document.getElementById('githubReleaseLink') as HTMLAnchorElement;
    if (info.githubReleaseUrl) {
      githubReleaseLink.href = info.githubReleaseUrl;
      githubReleaseLink.style.display = 'flex';
    }
    
    // Load release notes nếu có
    if (info.releaseNotes) {
      const releaseNotesDiv = document.getElementById('updateReleaseNotes') as HTMLDivElement;
      const releaseNotesContent = document.getElementById('releaseNotesContent') as HTMLDivElement;
      
      releaseNotesDiv.style.display = 'block';
      releaseNotesContent.innerHTML = info.releaseNotes;
    }
  }

  // Remind later button
  remindLaterBtn.addEventListener('click', () => {
    updateAvailablePopup.style.display = 'none';
    console.log('User chose to update later');
  });

  // View release notes button
  viewReleaseNotesBtn.addEventListener('click', () => {
    const releaseNotesDiv = document.getElementById('updateReleaseNotes') as HTMLDivElement;
    
    if (releaseNotesDiv.style.display === 'none') {
      releaseNotesDiv.style.display = 'block';
      viewReleaseNotesBtn.textContent = 'Ẩn chi tiết ↑';
    } else {
      releaseNotesDiv.style.display = 'none';
      viewReleaseNotesBtn.textContent = 'Xem chi tiết →';
    }
  });

  // Close button
  closeUpdatePopupBtn.addEventListener('click', () => {
    updateAvailablePopup.style.display = 'none';
  });
}
// ===== UPDATE DOWNLOAD PROGRESS =====
// Hint shown in the error modal, by what kind of failure happened
function updateErrorGuideText(kind: UpdateErrorI['kind']): string {
  switch (kind) {
    case 'signature':
      return 'Bản này chưa được ký số nên không tự cài đặt được. Bấm nút bên dưới để mở trang phát hành, tải file Deploy-Tool-Setup-<phiên bản>.exe (không dùng file .msi) và chạy file đó để cài đè. Cấu hình của ứng dụng được giữ nguyên.';
    case 'network':
      return 'Thử lại khi có mạng, hoặc tải file cài đặt thủ công từ trang phát hành.';
    case 'download':
    case 'unknown':
    default:
      return 'Bạn có thể tải file cài đặt thủ công từ trang phát hành.';
  }
}

function initUpdateDownloadHandlers(getReleaseUrl: () => string) {
  const updateModal = document.getElementById('updateModal') as HTMLDivElement;
  const updateSuccessModal = document.getElementById('updateSuccessModal') as HTMLDivElement;
  const updateErrorModal = document.getElementById('updateErrorModal') as HTMLDivElement;
  const openReleasePageFromSuccessBtn = document.getElementById('openReleasePageFromSuccessBtn') as HTMLButtonElement;
  const openReleasePageFromErrorBtn = document.getElementById('openReleasePageFromErrorBtn') as HTMLButtonElement;
  const closeSuccessBtn = document.getElementById('closeSuccessBtn') as HTMLButtonElement;
  const closeErrorBtn = document.getElementById('closeErrorBtn') as HTMLButtonElement;

  window.api.onUpdateDownloadStarted((data) => {
    updateModal.style.display = 'flex';
    updateSuccessModal.style.display = 'none';
    updateErrorModal.style.display = 'none';

    const versionInfo = document.getElementById('updateVersionInfo') as HTMLParagraphElement;
    const versionValue = document.createElement('strong');
    versionValue.textContent = `v${data.version}`;
    versionInfo.textContent = 'Phiên bản: ';
    versionInfo.appendChild(versionValue);

    // Reset every figure so a retry after an error does not show the previous attempt's numbers
    const progressBar = document.getElementById('updateProgressBar') as HTMLDivElement;
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';
    (document.getElementById('updatePercentText') as HTMLDivElement).textContent = '0%';
    (document.getElementById('updateDownloadedSize') as HTMLDivElement).textContent = '0 MB';
    (document.getElementById('updateTotalSize') as HTMLDivElement).textContent = '0 MB';
    (document.getElementById('updateSpeed') as HTMLDivElement).textContent = '0 MB/s';
  });

  window.api.onUpdateDownloadProgress((data) => {
    const progressBar = document.getElementById('updateProgressBar') as HTMLDivElement;
    const percentText = document.getElementById('updatePercentText') as HTMLDivElement;
    const downloadedSize = document.getElementById('updateDownloadedSize') as HTMLDivElement;
    const totalSize = document.getElementById('updateTotalSize') as HTMLDivElement;
    const speed = document.getElementById('updateSpeed') as HTMLDivElement;

    progressBar.style.width = data.percent + '%';
    progressBar.textContent = data.percent.toFixed(1) + '%';

    percentText.textContent = data.percent.toFixed(1) + '%';
    downloadedSize.textContent = data.downloadedMB.toFixed(2) + ' MB';
    totalSize.textContent = data.totalMB.toFixed(2) + ' MB';
    speed.textContent = data.speedMBps.toFixed(2) + ' MB/s';
  });

  window.api.onUpdateDownloaded((data) => {
    updateModal.style.display = 'none';
    updateSuccessModal.style.display = 'flex';

    const successVersion = document.getElementById('updateSuccessVersion') as HTMLParagraphElement;
    successVersion.textContent = `Phiên bản v${data.version} đã sẵn sàng để cài đặt. Ứng dụng sẽ tự động cài đặt khi bạn đóng.`;
  });

  window.api.onUpdateError((data) => {
    updateModal.style.display = 'none';
    updateErrorModal.style.display = 'flex';

    const errorMessage = document.getElementById('updateErrorMessage') as HTMLParagraphElement;
    errorMessage.textContent = data.message || 'Đã xảy ra lỗi không xác định khi tải xuống cập nhật.';

    const errorGuide = document.getElementById('updateErrorGuide') as HTMLParagraphElement;
    errorGuide.textContent = updateErrorGuideText(data.kind);

    const errorDetail = document.getElementById('updateErrorDetail') as HTMLParagraphElement;
    errorDetail.textContent = data.detail ? `Chi tiết kỹ thuật: ${data.detail}` : '';
    errorDetail.style.display = data.detail ? 'block' : 'none';
  });

  closeSuccessBtn.addEventListener('click', () => {
    updateSuccessModal.style.display = 'none';
  });

  closeErrorBtn.addEventListener('click', () => {
    updateErrorModal.style.display = 'none';
  });

  // Manual install: open the release page; the main process rejects any URL that is not this repository's release page
  openReleasePageFromErrorBtn.addEventListener('click', () => {
    void window.api.openReleasePage(getReleaseUrl());
  });
  openReleasePageFromSuccessBtn.addEventListener('click', () => {
    void window.api.openReleasePage(getReleaseUrl());
  });
}
