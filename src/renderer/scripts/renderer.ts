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
    console.log("Config updated from another window, reloading...");
    window.location.reload();
  });
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
            loadDeployConfig();
            break;
          case "projects":
            loadProjectsConfig();
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
let currentConfig: any = null;
let activeDeployments: string[] = [];
let allBranches: string[] = []; // Store all branches for filtering
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


async function initDeployPage() {
  await loadDeployConfig();
  setupDeployEventListeners();

  // Listen for deployment status changes from other windows
  window.api.onDeploymentStatusChanged((projects: string[]) => {
    activeDeployments = projects;
    updateDeployButtonState();
  });

  // Load initial active deployments
  activeDeployments = await window.api.getActiveDeployments();
  updateDeployButtonState();
}

async function loadDeployConfig() {
  try {
    currentConfig = await window.api.loadConfig();
    populateProjectSelect();
  } catch (err) {
    console.error("Failed to load config:", err);
    alert("Failed to load configuration");
  }
}

function populateProjectSelect() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  projectSelect.innerHTML = '<option value="">Select a project...</option>';

  if (currentConfig && currentConfig.projects) {
    currentConfig.projects.forEach((project: any) => {
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

  projectSelect.addEventListener("change", async () => {
    const projectName = projectSelect.value;
    if (!projectName) {
      return;
    }

    // Clear and disable dependent selects
    branchSelect.disabled = true;
    envSelect.disabled = true;
    typeSelect.disabled = true;
    deployBtn.disabled = true;
    commitTemplate.disabled = true;
    fileContentTemplate.disabled = true;

    const project = currentConfig.projects.find((p: any) => p.name === projectName);
    if (!project) return;

    // Load branches from git repo
    branchFilter.disabled = true;
    branchSelect.disabled = true;
    branchSelect.innerHTML = '<option value="">Loading branches...</option>';

    const branches = await window.api.getBranches(project.repoPath);
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

    // Populate envs
    envSelect.innerHTML = '<option value="">Select environment...</option>';
    project.envs.forEach((env: string) => {
      const option = document.createElement("option");
      option.value = env;
      option.textContent = env;
      envSelect.appendChild(option);
    });
    envSelect.disabled = false;

    // Populate deploy types
    typeSelect.innerHTML = '<option value="">Select type...</option>';
    project.deployTypes.forEach((type: string) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      typeSelect.appendChild(option);
    });
    typeSelect.disabled = false;

    // Set commit and file content templates
    commitTemplate.value = project.commitTemplate;
    commitTemplate.disabled = false;
    fileContentTemplate.value = project.fileContentTemplate;
    fileContentTemplate.disabled = false;

    updateDeployButtonState();
  });

  branchFilter.addEventListener('input', handleBranchFilter);
  branchSelect.addEventListener("change", updateDeployButtonState);
  envSelect.addEventListener("change", updateDeployButtonState);
  typeSelect.addEventListener("change", updateDeployButtonState);

  deployBtn.addEventListener("click", handleDeploy);
  clearLogBtn.addEventListener("click", () => {
    clearLogOutput();
  });

}

function updateDeployButtonState() {
  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const deployBtn = document.getElementById("deployBtn") as HTMLButtonElement;

  const projectName = projectSelect.value;
  const isProjectBeingDeployed = projectName && activeDeployments.includes(projectName);

  if (isProjectBeingDeployed) {
    deployBtn.disabled = true;
    deployBtn.querySelector(".btn-text")!.textContent = `${projectName} is being deployed in another window`;
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

function clearLogOutput() {
  const logOutput = document.getElementById("deployLog") as HTMLDivElement;
  logOutput.textContent = "";
}

async function handleDeploy() {
  // Clear previous logs
  clearLogOutput();

  const projectSelect = document.getElementById("projectSelect") as HTMLSelectElement;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement;
  const envSelect = document.getElementById("envSelect") as HTMLSelectElement;
  const typeSelect = document.getElementById("typeSelect") as HTMLSelectElement;
  const dryRunCheck = document.getElementById("dryRunCheck") as HTMLInputElement;
  const commitTemplateInput = document.getElementById("commitTemplate") as HTMLInputElement;
  const fileContentTemplateInput = document.getElementById("fileContentTemplate") as HTMLInputElement;
  const logOutput = document.getElementById("deployLog") as HTMLDivElement;
  const loadingOverlay = document.getElementById("loadingOverlay") as HTMLDivElement;

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
    alert(`Project ${projectName} is already being deployed in another window`);
    return;
  }

  const project = currentConfig.projects.find((p: any) => p.name === projectName);
  if (!project) return;

  const confirm = await window.api.openDialogConfirm({
    title: "Confirm Deploy",
    message: `Deploy project "${projectName}" to environment "${env}" with type "${type}"?`,
  });
  if (!confirm) return;

  // Disable form
  setFormEnabled(false);
  loadingOverlay.style.display = "flex";
  logOutput.textContent = "";

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

    // Display logs
    if (result.logs) {
      logOutput.textContent = result.logs.join("\n");
    }

    // Show notification
    if (result.success) {
      window.api.showNotification("Deploy Completed", `${projectName} deployed successfully to ${env}`);
    } else {
      window.api.showNotification("Deploy Failed", result.error || "Unknown error occurred");
    }
  } catch (err: any) {
    logOutput.textContent += `\n\nError: ${err.message}`;
    window.api.showNotification("Deploy Error", err.message);
  } finally {
    loadingOverlay.style.display = "none";
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
let projectsConfig: any = null;
let editingProjectIndex: number | null = null;

async function initProjectsPage() {
  await loadProjectsConfig();
  renderProjectsList();
  setupProjectsEventListeners();
}

async function loadProjectsConfig() {
  try {
    projectsConfig = await window.api.loadConfig();
  } catch (err) {
    console.error("Failed to load config:", err);
    alert("Failed to load configuration");
  }
}

function renderProjectsList() {
  const container = document.getElementById("projectsList") as HTMLDivElement;
  container.innerHTML = "";

  if (!projectsConfig?.projects || projectsConfig.projects.length === 0) {
    container.innerHTML =
      '<p style="color: var(--text-muted); text-align: center; padding: 40px;">No projects yet. Click "Add Project" to get started.</p>';
    return;
  }

  projectsConfig.projects.forEach((project: any, index: number) => {
    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `
      <div class="project-card-header">
        <h3>${escapeHtml(project.name)}</h3>
        <div class="project-card-actions">
          <button class="btn btn-small edit-btn" data-index="${index}">Edit</button>
          <button class="btn btn-small btn-danger delete-btn" data-index="${index}">Delete</button>
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

function editProject(index: number) {
  editingProjectIndex = index;
  const project = projectsConfig.projects[index];
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
  const project = projectsConfig.projects[index];
  if (!confirm(`Are you sure you want to delete project "${project.name}"?`)) {
    return;
  }

  projectsConfig.projects.splice(index, 1);
  await saveProjectsConfig();
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

  // Validation
  if (!name || !repoPath || !envsStr || !typesStr || (commitFormat === "custom" && !commitTemplate) || !cicdFileName) {
    alert("All fields are required");
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
    alert("Please provide at least one environment and one deploy type");
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

  if (projectsConfig.projects.some((p: any, i: number) => p.name === name && i !== editingProjectIndex)) {
    alert(`Project with name "${name}" already exists`);
    return;
  }

  if (editingProjectIndex !== null) {
    // Edit existing
    projectsConfig.projects[editingProjectIndex] = project;
  } else {
    // Add new
    projectsConfig.projects.push(project);
  }

  await saveProjectsConfig();
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
    fileContentTemplateInput.value = "deploy: {env}, {type}";
  }
}

async function saveProjectsConfig() {
  try {
    const result = await window.api.saveConfig(projectsConfig);
    if (!result.success) {
      alert(`Failed to save config: ${result.error}`);
    }
  } catch (err: any) {
    alert(`Error saving config: ${err.message}`);
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
    logContent.textContent = content;
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

  // Listen for update available event from main process
  window.api.onUpdateAvailable?.((data: any) => {
    showUpdateAvailablePopup(data);
  });

  function showUpdateAvailablePopup(info: any) {
    updateAvailablePopup.style.display = 'flex';
    
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