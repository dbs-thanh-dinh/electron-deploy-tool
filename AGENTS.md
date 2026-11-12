# AGENTS.md

Hướng dẫn cho AI coding agent làm việc trong repo này. Giao tiếp với người dùng bằng **tiếng Việt**; comment trong code có thể giữ tiếng Anh.

## Tổng quan

**Deploy Tool** (`deploy-tool`, v1.3.0) là ứng dụng desktop Electron + TypeScript (chỉ Windows) tự động hoá quy trình deploy qua Git: với mỗi project đã cấu hình, tool sẽ `git stash` → `git checkout <branch>` → `git pull` → ghi một dòng vào file CI/CD (mặc định `CICD.txt`) → `git add` → `git commit` → `git push` (hoặc bỏ qua push ở chế độ dry-run). Push lên nhánh sẽ kích hoạt pipeline CI/CD của repo đích.

Tính năng chính: nhiều cửa sổ (chặn deploy trùng project), quản lý project, log realtime + lịch sử log, dry-run, thông báo hệ thống, theme sáng/tối, theme theo ngày lễ Việt Nam, tự kiểm tra cập nhật qua GitHub Releases.

## Tech stack

- Electron `^28`, TypeScript `^5.3` (strict, target ES2020, module `commonjs`)
- `electron-updater` (GitHub provider), `electron-builder` (đóng gói MSI + NSIS, x64)
- Renderer là HTML/CSS + TypeScript thuần (không framework, không bundler)
- Không có test, không có linter/formatter được cấu hình

## Lệnh thường dùng

```bash
npm install
npm run build      # tsc + copy-static (copy html/css từ src/renderer sang dist)
npm start          # build rồi chạy electron .
npm run watch      # tsc --watch (HTML/CSS không được copy lại — chạy copy-static khi đổi)
npm run dist       # build + electron-builder --win msi --x64 -> output ở release/
```

Không có `npm test` / `npm run lint`. Kiểm tra tối thiểu: `npx tsc --noEmit` phải pass.

## Cấu trúc thư mục

```
src/
├── main/                    # Main process (Node + Electron API)
│   ├── main.ts              # Entry: app lifecycle, menu, auto-update (check mỗi 4 giờ), show-notification
│   ├── window-manager.ts    # WindowManager: tạo cửa sổ, theo dõi deploy đang chạy (project -> windowId), broadcast
│   ├── ipc-handlers.ts      # registerIpcHandlers(): toàn bộ ipcMain.handle (config, deploy, log, git, dialog, holidays)
│   ├── deploy-service.ts    # DeployService: chạy lệnh git, ghi log, cập nhật file CICD
│   └── interface.ts         # ProjectI, ConfigI
├── preload/preload.ts       # contextBridge: expose `window.api`
└── renderer/                # Renderer process (UI)
    ├── index.html           # Toàn bộ markup; nạp script từ ../../dist/renderer/scripts/*.js
    ├── types.d.ts           # Khai báo kiểu cho `window.api`
    ├── scripts/renderer.ts  # Logic UI chính (~800 dòng)
    ├── scripts/holiday-theme-manager.ts  # Theme/animation theo ngày lễ (solar + lunar)
    └── styles/              # main.css, themes.css (dark/light), holiday-theme.css
extra/                       # Dữ liệu mẫu, được copy vào resources khi đóng gói (extraResources)
├── scripts.json             # Config mẫu các project
└── holidays-config.json     # Danh sách ngày lễ + theme
assets/                      # icon.ico, assets/holidays/*.png|jpg (ảnh nền ngày lễ)
dist/, release/              # Output build — bị gitignore, không sửa tay
```

## Kiến trúc & luồng dữ liệu

- `contextIsolation: true`, `nodeIntegration: false`. Renderer **không** truy cập Node; mọi thao tác hệ thống đi qua `window.api` (preload) → `ipcRenderer.invoke` → `ipcMain.handle` trong `ipc-handlers.ts`.
- **Thêm một IPC mới cần sửa đủ 3 nơi (+1):** `ipc-handlers.ts` (handler) → `preload.ts` (expose) → `renderer/types.d.ts` (kiểu) → gọi trong `renderer.ts`.
- Sự kiện main → renderer (`deployment-status-changed`, `config-updated`, `update-available`, `show-about`) được gửi bằng `webContents.send` và đăng ký qua `window.api.onXxx`.
- **Chặn deploy trùng:** `WindowManager.activeDeployments` (Map projectName → windowId). `start-deploy` kiểm tra `canDeploy`, đánh dấu active, và luôn `setDeploymentInactive` trong `finally`; mỗi lần đổi đều broadcast tới mọi cửa sổ.
- **Config người dùng:** `<userData>/scripts.json`. Lần đầu chưa có thì copy từ `extra/scripts.json` (fallback `configDefault`). Khi load, `load-config` điền giá trị mặc định cho các field thiếu của `ProjectI`. `save-config` ghi file rồi `broadcastConfigUpdate()` để đồng bộ các cửa sổ.
- **Log deploy:** `<userData>/logs/deploy-YYYY-MM-DD.log`, mỗi dòng có timestamp ISO; đồng thời trả mảng `logs` về renderer.
- **File `extra/`:** `getExtraFilePath()` đọc từ `process.resourcesPath/extra` khi đã đóng gói, từ `<cwd>/extra` khi dev.
- **Auto-update:** `autoDownload = false`; chỉ gửi `update-available` kèm link release GitHub (đọc `owner/repo` từ `package.json > build.publish`). `forceDevUpdateConfig = true`, `allowPrerelease = true`.
- **Theme ngày lễ:** `HolidayThemeManager` đọc `holidays-config.json` (qua IPC `load-holidays-config`), hỗ trợ ngày dương (`solar`) và âm (`lunar`) định dạng `"M/D"`, cửa sổ hiệu lực `daysBefore`/`daysAfter`, mỗi holiday có `theme.backgroundImage` + `theme.animations`, cờ `enabled`.

## Mô hình dữ liệu (`ProjectI`)

`name`, `repoPath`, `envs[]`, `deployTypes[]`, `branchFilter`, `commitFormat`, `commitTemplate`, `fileContentFormat`, `fileContentTemplate`, `smartAppend`, `cicdFileName`.

- Placeholder template: `{env}`, `{type}`, `{date:y-m-d}`, `{date:y/m/d}`, `{date:d-m-y}`, `{date:d/m/y}` (date chỉ dùng cho nội dung file). Khi `type === 'all'`, `{type}` cùng dấu phẩy kề bên bị loại khỏi chuỗi.
- `smartAppend`: nếu dòng cuối của file CICD trùng nội dung mới thì thêm `+` vào cuối dòng thay vì thêm dòng mới.
- Giá trị mặc định: `commitTemplate = "deploy: {env}, {type}"`, `cicdFileName = "CICD.txt"`, `commitFormat = "v1"`, `fileContentFormat = "default"`.

## Quy ước code

Theo quy ước global của chủ dự án (ThanhDC):

- Hạn chế `any` (code hiện tại còn dùng ở IPC/preload — không mở rộng thêm, ưu tiên khai báo kiểu cụ thể khi sửa vùng đó).
- Biến/hàm `camelCase`; class/type `PascalCase`; thư mục và file `kebab-case`.
- Model/DTO/RO kèm hậu tố `Model`/`DTO`/`RO`.
- Quy ước chủ dự án muốn là interface bắt đầu bằng `I` (vd `IExample`). **Lưu ý:** code hiện có dùng hậu tố (`ProjectI`, `ConfigI`) và `DeployOptions`/`DeployResult` không có tiền tố — giữ nhất quán với file đang sửa; chỉ dùng `I`-prefix cho interface mới nếu người dùng yêu cầu rõ.
- Import: dùng `node:` prefix cho module Node (`node:fs`, `node:path`). Dự án chưa cấu hình path alias `@/`, dùng đường dẫn tương đối.
- Renderer là script thường (không module): các file trong `scripts/` chia sẻ global scope, tránh đặt trùng tên khai báo top-level giữa `renderer.ts` và `holiday-theme-manager.ts`.

## Lưu ý quan trọng / bẫy thường gặp

- **Không commit** `.env`, `dist/`, `release/`, `node_modules/` (đã gitignore). Không sửa tay `dist/`.
- `index.html` nạp JS từ `../../dist/renderer/scripts/`, còn `main` trỏ `dist/main/main.js` → **luôn `npm run build` trước khi chạy Electron**; chỉ sửa `.ts`/`.html`/`.css` trong `src/`.
- `copy-static` chỉ copy `html`/`css`; file tĩnh khác (ảnh, json) nằm ngoài `src/` và được nạp qua `assets/` / `extra/`. `build.files` gồm `dist/**`, `src/renderer/**`, `assets/**`; `extra/` đóng gói qua `extraResources`.
- `DeployService` dùng `execSync` với chuỗi lệnh nối từ input người dùng (`branch`, `commitMsg`, `cicdFileName` đưa trực tiếp vào shell, commit message bọc trong `"..."`). Khi sửa, cẩn thận command injection/ký tự đặc biệt; ưu tiên `execFileSync` với mảng tham số nếu refactor.
- `git stash save` chạy trước checkout mà **không** `stash pop` lại — đây là hành vi hiện tại, đừng thay đổi âm thầm.
- `getBranches` chạy `git fetch --prune` + `git branch -r` đồng bộ trong main process (có thể chặn UI nếu repo/mạng chậm).
- `load-config` ở nhánh "chưa có file" trả về **đường dẫn** (khi copy từ sample) thay vì object config — hành vi không nhất quán với các nhánh khác; kiểm tra phía renderer khi đụng vào.
- Đường dẫn ảnh nền trong `holidays-config.json` là tương đối so với renderer (`./../../assets/holidays/...`); giữ nguyên format khi thêm ngày lễ mới và đặt ảnh vào `assets/holidays/`.
- README còn mô tả cũ (`scripts.json` ở thư mục gốc); thực tế config nằm ở `<userData>/scripts.json`, mẫu ở `extra/scripts.json`.

## Git workflow

- Nhánh chính `main`; không push trực tiếp lên `main`/`master` — làm trên nhánh `feature/*`, `release/*` rồi tạo PR.
- Commit theo Conventional Commits (`feat:`, `fix:`, `chore:`…). **Không** thêm `Co-Authored-By` hay trailer ghi công AI/“Generated with…” vào commit message và mô tả PR.
- Trước khi tạo PR: chạy `npx tsc --noEmit` (và lint/test nếu sau này được thêm).
- Release: bump `version` trong `package.json` (commit `chore: bump version to x.y.z`), build bằng `npm run dist`, publish lên GitHub Releases (`dbs-thanhdc/electron-deploy-tool`) để `electron-updater` phát hiện.
