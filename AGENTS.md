# AGENTS.md

Hướng dẫn cho AI coding agent làm việc trong repo này. Giao tiếp với người dùng bằng **tiếng Việt**; comment trong code có thể giữ tiếng Anh.

## Nguyên tắc chung

### Trách nhiệm của Agent

- Agent chịu trách nhiệm **vừa triển khai vừa ghi tài liệu** dự án.
- Mục tiêu: luôn ghi lại các quyết định triển khai thành tài liệu tại `docs/notes/<YYYY-MM>.md` (danh mục nằm ở `docs/implementation-notes.md`). Nếu file/thư mục chưa có thì agent tự tạo theo mẫu bên dưới.
- Không bao giờ **âm thầm** đưa ra quyết định kiến trúc — mọi quyết định phải để lại dấu vết kiểm toán (audit trail).
- Với quyết định kiến trúc: hỏi người dùng (multiple choice, có lựa chọn Recommended) và gọi sub-agent `advisor` **trước** khi triển khai, rồi mới ghi note.

### Khi nào ghi note

- **Ghi** khi: quyết định kiến trúc, thay đổi hành vi của deploy/IPC/config, đánh đổi kỹ thuật, hoặc lệch khỏi quy ước trong file này.
- **Không ghi** cho thay đổi nhỏ: sửa typo, chỉnh định dạng, bump version.

### Định dạng

- Mỗi tháng một file `docs/notes/<YYYY-MM>.md`; mỗi quyết định là một mục `## <YYYY-MM-DD> — <tiêu đề ngắn>` gồm: **Bối cảnh**, **Quyết định**, **Phương án đã cân nhắc**, **Lý do**, **Liên quan** (file/PR).
- `docs/implementation-notes.md` là danh mục: mỗi tháng một dòng link tới file note tương ứng. Tạo file tháng mới thì thêm dòng vào danh mục.
- File note commit cùng PR với thay đổi code (hoặc commit riêng dạng `docs: ...`).

### Tầm quan trọng của ghi tài liệu

Ghi tài liệu giúp minh bạch quá trình phát triển, review lại quyết định về sau, giúp thành viên mới hiểu lý do đằng sau mỗi quyết định, và tạo lịch sử kiểm toán (audit trail) hoàn chỉnh.

## Tổng quan

**Deploy Tool** (`deploy-tool`, v1.3.0) là ứng dụng desktop Electron + TypeScript (chỉ Windows) tự động hoá quy trình deploy qua Git: với mỗi project đã cấu hình, tool sẽ `git stash` → `git checkout <branch>` → `git pull` → ghi một dòng vào file CI/CD (mặc định `CICD.txt`) → `git add` → `git commit` → `git push` (hoặc bỏ qua push ở chế độ dry-run). Push lên nhánh sẽ kích hoạt pipeline CI/CD của repo đích.

Tính năng chính: nhiều cửa sổ (chặn deploy trùng project), quản lý project, log realtime + lịch sử log, dry-run, thông báo hệ thống, theme sáng/tối, theme theo ngày lễ Việt Nam, tự kiểm tra cập nhật qua GitHub Releases.

## Tech stack

- Electron `^28`, TypeScript `^5.3` (strict, target ES2020, module `commonjs`)
- `electron-updater` (GitHub provider), `electron-builder` (đóng gói MSI + NSIS, x64)
- Renderer là HTML/CSS + TypeScript thuần (không framework, không bundler)
- Test: Vitest (`tests/`); lint: ESLint flat config (`eslint.config.mjs`, typescript-eslint). Không cấu hình Prettier/formatter

## Lệnh thường dùng

```bash
npm install
npm run build      # tsc + copy-static (copy html/css từ src/renderer sang dist)
npm start          # build rồi chạy electron .
npm run watch      # tsc --watch (HTML/CSS không được copy lại — chạy copy-static khi đổi)
npm run dist       # build + electron-builder --win msi --x64 -> output ở release/
npm run typecheck  # tsc --noEmit (src) + tsc --noEmit -p tsconfig.test.json (tests)
npm test           # vitest run
npm run lint       # eslint src tests (cảnh báo `no-explicit-any`/unused là warn, chỉ lỗi mới làm fail)
```

Kiểm tra tối thiểu trước khi tạo PR: `npm run typecheck`, `npm test`, `npm run lint` phải pass (0 lỗi).

## Cấu trúc thư mục

```
src/
├── main/                    # Main process (Node + Electron API)
│   ├── main.ts              # Entry: app lifecycle, menu, auto-update (check mỗi 4 giờ), show-notification
│   ├── window-manager.ts    # WindowManager: tạo cửa sổ, theo dõi deploy đang chạy (project -> windowId), broadcast
│   ├── ipc-handlers.ts      # registerIpcHandlers(): toàn bộ ipcMain.handle (config, deploy, log, git, dialog, holidays)
│   ├── deploy-service.ts    # DeployService: chạy lệnh git, ghi log, cập nhật file CICD
│   ├── deploy-utils.ts      # Hàm thuần (commit msg, nội dung file, applyCicdEntry) — không import electron, có unit test
│   └── interface.ts         # ProjectI, ConfigI
├── preload/preload.ts       # contextBridge: expose `window.api`
└── renderer/                # Renderer process (UI)
    ├── index.html           # Toàn bộ markup; nạp script từ ../../dist/renderer/scripts/*.js
    ├── types.d.ts           # Khai báo kiểu cho `window.api` (global script, xem lưu ý bên dưới)
    ├── scripts/renderer.ts  # Logic UI chính (~800 dòng)
    ├── scripts/holiday-theme-manager.ts  # Theme/animation theo ngày lễ (solar + lunar)
    └── styles/              # main.css, themes.css (dark/light), holiday-theme.css
extra/                       # Dữ liệu mẫu, được copy vào resources khi đóng gói (extraResources)
├── scripts.json             # Config mẫu các project
└── holidays-config.json     # Danh sách ngày lễ + theme
assets/                      # icon.ico, assets/holidays/*.png|jpg (ảnh nền ngày lễ)
docs/                        # Tài liệu quyết định triển khai (không đóng gói vào app)
├── implementation-notes.md  # Danh mục các file note theo tháng
└── notes/<YYYY-MM>.md       # Ghi chú quyết định triển khai của từng tháng
tests/                       # Unit test Vitest (ngoài `src/` nên không bị build vào dist)
dist/, release/              # Output build — bị gitignore, không sửa tay
```

## Kiến trúc & luồng dữ liệu

- `contextIsolation: true`, `nodeIntegration: false`. Renderer **không** truy cập Node; mọi thao tác hệ thống đi qua `window.api` (preload) → `ipcRenderer.invoke` → `ipcMain.handle` trong `ipc-handlers.ts`.
- **Thêm một IPC mới cần sửa đủ 3 nơi (+1):** `ipc-handlers.ts` (handler) → `preload.ts` (expose) → `renderer/types.d.ts` (kiểu) → gọi trong `renderer.ts`.
- Sự kiện main → renderer (`deployment-status-changed`, `config-updated`, `update-available`, `show-about`) được gửi bằng `webContents.send` và đăng ký qua `window.api.onXxx`.
- **Chặn deploy trùng:** `WindowManager.activeDeployments` (Map projectName → windowId). `start-deploy` kiểm tra `canDeploy`, đánh dấu active, và luôn `setDeploymentInactive` trong `finally`; mỗi lần đổi đều broadcast tới mọi cửa sổ.
- **Config người dùng:** `<userData>/scripts.json`. Lần đầu chưa có thì copy từ `extra/scripts.json` (fallback `configDefault`). Khi load, `load-config` điền giá trị mặc định cho các field thiếu của `ProjectI`. `save-config` validate + ghi atomic (`saveConfigToFile`, xem mục Config bên dưới) rồi chỉ khi thành công mới `broadcastConfigUpdate()` để đồng bộ các cửa sổ.
- **Log deploy:** `<userData>/logs/deploy-YYYY-MM-DD.log`, mỗi dòng có timestamp giờ local `YYYY-MM-DD HH:mm:ss` (tên file cũng theo ngày local); đồng thời trả mảng `logs` về renderer.
- **File `extra/`:** `getExtraFilePath()` đọc từ `process.resourcesPath/extra` khi đã đóng gói, từ `<cwd>/extra` khi dev.
- **Auto-update:** `autoDownload = false`; chỉ gửi `update-available` kèm link release GitHub (đọc `owner/repo` từ `package.json > build.publish`). `forceDevUpdateConfig = !app.isPackaged` (chỉ bật khi chạy dev), `allowPrerelease = true`.
- **Theme ngày lễ:** `HolidayThemeManager` đọc `holidays-config.json` (qua IPC `load-holidays-config`), hỗ trợ ngày dương (`solar`) và âm (`lunar`) định dạng `"M/D"`, cửa sổ hiệu lực `daysBefore`/`daysAfter`, mỗi holiday có `theme.backgroundImage` + `theme.animations`, cờ `enabled`.

## Mô hình dữ liệu (`ProjectI`)

`name`, `repoPath`, `envs[]`, `deployTypes[]`, `branchFilter`, `commitFormat`, `commitTemplate`, `fileContentFormat`, `fileContentTemplate`, `smartAppend`, `cicdFileName`.

- Placeholder template: `{env}`, `{type}`, `{date:y-m-d}`, `{date:y/m/d}`, `{date:d-m-y}`, `{date:d/m/y}` (date chỉ dùng cho nội dung file). Khi `type === 'all'`, `{type}` cùng dấu phẩy kề bên bị loại khỏi chuỗi.
- `smartAppend`: nếu dòng cuối của file CICD trùng nội dung mới thì thêm `+` vào cuối dòng thay vì thêm dòng mới.
- Giá trị mặc định: `commitTemplate = "deploy: {env}, {type}"`, `cicdFileName = "CICD.txt"`, `commitFormat = "v1"`, `fileContentFormat = "default"`.

## Quy ước code

Theo quy ước global của chủ dự án (ThanhDC):

- Hạn chế `any`, không thêm `any` mới (ESLint `no-explicit-any` ở mức warn). Với lỗi bắt được ưu tiên `catch (err: unknown)` rồi `(err as Error).message`.
- Biến/hàm `camelCase`; class/type `PascalCase`; thư mục và file `kebab-case`.
- Model/DTO/RO kèm hậu tố `Model`/`DTO`/`RO`.
- Quy ước chủ dự án muốn là interface bắt đầu bằng `I` (vd `IExample`). **Lưu ý:** code hiện có dùng hậu tố (`ProjectI`, `ConfigI`) và `DeployOptions`/`DeployResult` không có tiền tố — giữ nhất quán với file đang sửa; chỉ dùng `I`-prefix cho interface mới nếu người dùng yêu cầu rõ.
- Import: dùng `node:` prefix cho module Node (`node:fs`, `node:path`). Dự án chưa cấu hình path alias `@/`, dùng đường dẫn tương đối.
- Renderer là script thường (không module): các file trong `scripts/` chia sẻ global scope, tránh đặt trùng tên khai báo top-level giữa `renderer.ts` và `holiday-theme-manager.ts`.

## Lưu ý quan trọng / bẫy thường gặp

- **Không commit** `.env`, `dist/`, `release/`, `node_modules/` (đã gitignore). Không sửa tay `dist/`.
- `index.html` nạp JS từ `../../dist/renderer/scripts/`, còn `main` trỏ `dist/main/main.js` → **luôn `npm run build` trước khi chạy Electron**; chỉ sửa `.ts`/`.html`/`.css` trong `src/`.
- `copy-static` chỉ copy `html`/`css`; file tĩnh khác (ảnh, json) nằm ngoài `src/` và được nạp qua `assets/` / `extra/`. `build.files` gồm `dist/**`, `src/renderer/**`, `assets/**`; `extra/` đóng gói qua `extraResources`.
- `DeployService` chạy git qua `execFile` với mảng tham số (không qua shell), có timeout 5 phút và `GIT_TERMINAL_PROMPT=0`; `branch` bắt đầu bằng `-` và `cicdFileName` thoát khỏi repo bị từ chối. Giữ cách gọi này khi sửa, không quay lại nối chuỗi lệnh.
- **Không thêm `import`/`export` top-level vào `src/renderer/scripts/*.ts` hay `src/renderer/types.d.ts`**: renderer là script thường (không bundler); thêm import biến file thành module, tsc (commonjs) sinh `exports` và trình duyệt lỗi `exports is not defined`, riêng `types.d.ts` sẽ làm `Window` hết global. Muốn dùng kiểu của main process thì dùng inline `import('../main/...')` (xem đầu `types.d.ts`). `src/preload/preload.ts` chỉ được `import type` từ main.
- **Luồng lỗi của `deploy()`:** `git pull --ff-only` (nhánh phân kỳ/chưa có upstream thì dừng, không merge). Sau `git add`, nếu file CICD không có thay đổi staged (`git diff --cached --quiet`) thì dừng với lỗi `Nothing to commit`. Nếu lỗi xảy ra sau khi đã ghi file CICD và trước khi commit thành công thì rollback best-effort bằng `git checkout HEAD -- <file>` (rollback thất bại chỉ ghi log, không ghi đè lỗi gốc; file untracked/gitignore hoặc `index.lock` sót có thể làm rollback thất bại). Nếu commit đã tạo mà push lỗi thì **không** đụng repo, chỉ log rõ commit còn local — lần deploy sau sẽ phải fast-forward được. Dry-run cũng để lại commit local.
- Test `tests/deploy-service.test.ts` dùng git thật trong thư mục tạm (repo + bare remote), mock `electron`, xoá biến `GIT_*` và trỏ `GIT_CONFIG_GLOBAL` tới file rỗng để không phụ thuộc cấu hình máy hay chạy nhầm lên repo thật. Mỗi test ~1-2 giây trên Windows.
- `git stash save` chạy trước checkout mà **không** `stash pop` lại — đây là hành vi hiện tại, đừng thay đổi âm thầm. Khi stash thực sự tạo mới (output không chứa "No local changes"), log thêm cảnh báo `NOT restored` kèm gợi ý `git stash pop`.
- `get-branches` chạy `git fetch --prune` + `git branch -r` bằng `execFile` bất đồng bộ (timeout 2 phút) nên không chặn main process, nhưng UI vẫn phải chờ; lỗi thì trả mảng rỗng. Chỉ bỏ tiền tố `origin/`.
- **Config (`src/main/config-utils.ts`):** `load-config` lenient — luôn trả object config (điền mặc định bằng `applyProjectDefaults`), lỗi đọc/parse thì trả `ConfigErrorI` `{ error }`; kiểu `window.api.loadConfig` là `ConfigI | ConfigErrorI`, renderer narrow bằng `'error' in cfg` (chỉ `loadDeployConfig` hiện alert, `loadProjectsConfig` chỉ log để không alert 2 lần). `save-config` chặt — `validateConfig` từ chối config sai (thông báo nêu rõ `projects[i] ("tên").field`; cho phép field thừa như `commitPrefix`), rồi `writeFileAtomic` (file tmp + fsync + rename, retry EPERM/EACCES/EBUSY). Bất đối xứng cố ý: file sửa tay sai kiểu vẫn load được nhưng không lưu được cho tới khi sửa. Trang Projects khi load lỗi hiện thông báo lỗi (không hiện "No projects yet") và vô hiệu hoá nút Add. `isConfigError` coi là lỗi chỉ khi `error` là chuỗi và không có `projects` dạng mảng. Renderer hoàn tác thay đổi in-memory (`structuredClone` snapshot) và giữ form mở khi lưu thất bại.
- Đường dẫn ảnh nền trong `holidays-config.json` là tương đối so với renderer (`./../../assets/holidays/...`); giữ nguyên format khi thêm ngày lễ mới và đặt ảnh vào `assets/holidays/`.
- README còn mô tả cũ (`scripts.json` ở thư mục gốc); thực tế config nằm ở `<userData>/scripts.json`, mẫu ở `extra/scripts.json`.

## Git workflow

- Nhánh chính `main`; không push trực tiếp lên `main`/`master` — làm trên nhánh `feature/*`, `release/*` rồi tạo PR.
- Commit theo Conventional Commits (`feat:`, `fix:`, `chore:`…). **Không** thêm `Co-Authored-By` hay trailer ghi công AI/“Generated with…” vào commit message và mô tả PR.
- Trước khi tạo PR: chạy `npm run typecheck`, `npm test` và `npm run lint` (`npx tsc --noEmit` một mình không kiểm tra `tests/`).
- Release: bump `version` trong `package.json` (commit `chore: bump version to x.y.z`), build bằng `npm run dist`, publish lên GitHub Releases (`dbs-thanhdc/electron-deploy-tool`) để `electron-updater` phát hiện.
