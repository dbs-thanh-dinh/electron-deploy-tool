# Deploy Tool

Ứng dụng desktop (Electron + TypeScript) giúp tự động hoá quy trình deploy qua Git: chọn project, nhánh, môi trường và loại deploy, tool sẽ ghi một dòng vào file CI/CD của repo, commit và push để kích hoạt pipeline.

## Tính năng

- **Nhiều cửa sổ**: deploy nhiều project song song, nhưng chặn deploy trùng một project ở hai cửa sổ.
- **Quản lý project**: thêm, sửa, xoá project ngay trong ứng dụng.
- **Log deploy realtime**: hiển thị từng dòng output các lệnh git ngay khi chạy, tô màu theo mức (lỗi, cảnh báo, thành công, lệnh), có nút **Copy**; đồng thời lưu vào file log theo ngày (tự xoá file cũ hơn 90 ngày).
- **Lịch sử deploy**: xem lại log theo ngày, cùng cách tô màu.
- **Tiến trình theo bước và huỷ deploy**: thanh bước (Stash → Checkout → Pull → Update CICD → Commit → Push) hiện trạng thái từng bước; không còn lớp phủ chặn màn hình nên vẫn dùng được sidebar. Nút **Cancel deploy** dừng deploy ở ranh giới giữa các bước (và ngắt ngay `git pull` đang treo), khôi phục file CI/CD. Từ khi bước Commit bắt đầu thì không huỷ được nữa.
- **Dry-run**: chạy thử toàn bộ quy trình nhưng không push (có badge **DRY RUN** cạnh nút Deploy).
- **Cảnh báo nhánh nhạy cảm**: hộp thoại xác nhận nhắc thêm khi deploy lên `main`, `master`, `stage`, `staging`, `prod`, `production`.
- **Thông báo hệ thống** khi deploy xong.
- **Theme sáng/tối** (lưu lựa chọn của người dùng).
- **Theme ngày lễ Việt Nam**: tự đổi ảnh nền và hiệu ứng động quanh các ngày lễ (dương lịch và âm lịch).
- **Tự kiểm tra cập nhật** qua GitHub Releases (mỗi 4 giờ), hiện thông báo kèm link bản phát hành mới.
- **Đồng bộ giữa các cửa sổ**: cấu hình và trạng thái deploy cập nhật tức thì.

## Yêu cầu

- Windows (x64)
- Node.js 20.19+, 22.13+ hoặc 24+ (để phát triển; `jsdom` dùng trong test yêu cầu phiên bản này)
- Git đã cài, nằm trong `PATH` và đã cấu hình xác thực (SSH key hoặc credential) để `git pull`/`git push` không cần nhập mật khẩu

## Cài đặt & chạy (phát triển)

```bash
git clone https://github.com/dbs-thanh-dinh/electron-deploy-tool.git
cd electron-deploy-tool
npm install
npm start          # build TypeScript + copy html/css, rồi chạy Electron
```

Không cần tạo file cấu hình thủ công: lần chạy đầu tiên app tự tạo `scripts.json` từ file mẫu `extra/scripts.json`.

### Các lệnh npm

| Lệnh | Tác dụng |
|---|---|
| `npm run build` | `tsc` + copy `html`/`css` từ `src/renderer` sang `dist/` |
| `npm start` | Build rồi chạy `electron .` |
| `npm run watch` | `tsc --watch` (không copy lại html/css, chạy `npm run copy-static` khi sửa chúng) |
| `npm run dist` | Build và đóng gói bản cài đặt Windows (MSI, x64) vào `release/` |
| `npm run typecheck` | Kiểm tra kiểu cho `src` và `tests` |
| `npm test` | Chạy test Vitest (`tests/`; UI renderer được test bằng jsdom) |
| `npm run lint` | ESLint cho `src` và `tests` |

> `index.html` nạp JavaScript từ `dist/`, nên luôn build trước khi chạy Electron.

## Cấu hình project

Cấu hình lưu trong `scripts.json` ở thư mục dữ liệu người dùng của app (`%APPDATA%\deploy-tool\`). Cách đơn giản nhất là chỉnh qua trang **Projects** trong ứng dụng. File mẫu nằm ở [`extra/scripts.json`](extra/scripts.json).

```json
{
  "projects": [
    {
      "name": "Auth",
      "repoPath": "C:\\Projects\\auth-service",
      "envs": ["dev", "stage", "prod"],
      "deployTypes": ["api", "webapp", "all"],
      "branchFilter": "",
      "commitFormat": "v1",
      "commitTemplate": "deploy: {env}, {type}",
      "fileContentFormat": "default",
      "fileContentTemplate": "deploy: {env}, {type}",
      "smartAppend": false,
      "cicdFileName": "CICD.txt"
    }
  ]
}
```

| Field | Bắt buộc | Mô tả | Mặc định |
|---|---|---|---|
| `name` | ✔ | Tên hiển thị, dùng làm khoá để chặn deploy trùng | — |
| `repoPath` | ✔ | Đường dẫn thư mục repo Git trên máy | — |
| `envs` | ✔ | Danh sách môi trường (vd `dev`, `stage`) | — |
| `deployTypes` | ✔ | Danh sách loại deploy (vd `api`, `webapp`, `all`) | — |
| `branchFilter` | | Chuỗi lọc nhanh danh sách nhánh | `""` |
| `commitFormat` | | `v1`, `v2` hoặc `custom` | `v1` |
| `commitTemplate` | | Mẫu commit message | `deploy: {env}, {type}` |
| `fileContentFormat` | | `default` (dùng commit message) hoặc `custom` | `default` |
| `fileContentTemplate` | | Mẫu nội dung dòng ghi vào file CI/CD | = `commitTemplate` |
| `smartAppend` | | Nếu dòng cuối trùng nội dung mới thì thêm `+` vào cuối dòng thay vì thêm dòng mới | `false` |
| `cicdFileName` | | Tên file CI/CD nằm trong repo (phải tồn tại sẵn) | `CICD.txt` |

### Placeholder trong template

| Placeholder | Dùng ở | Ý nghĩa |
|---|---|---|
| `{env}` | commit, nội dung file | Môi trường đã chọn |
| `{type}` | commit, nội dung file | Loại deploy đã chọn. Khi chọn `all`, `{type}` và dấu phẩy kề bên bị loại bỏ |
| `{date:y-m-d}`, `{date:y/m/d}` | nội dung file | Ngày deploy theo năm-tháng-ngày |
| `{date:d-m-y}`, `{date:d/m/y}` | nội dung file | Ngày deploy theo ngày-tháng-năm |

## Quy trình deploy

Với mỗi lần deploy, tool chạy tuần tự trong `repoPath`:

1. `git stash save "Auto stash before deploy"`
2. `git checkout <branch>` (bỏ qua nếu đang ở đúng nhánh)
3. `git pull --ff-only` (nhánh phân kỳ hoặc chưa có upstream thì dừng, không merge)
4. Ghi một dòng vào `cicdFileName` theo `fileContentTemplate`
5. `git add <cicdFileName>` (nếu file không có thay đổi thì dừng với lỗi `Nothing to commit`)
6. `git commit -m "<commitTemplate>"`
7. `git push` (bỏ qua nếu bật **Dry Run**)

Bạn có thể huỷ trước bước 6: tool dừng ở ranh giới giữa các bước (riêng `git pull` bị ngắt ngay), rollback file CI/CD nếu đã ghi, và để nguyên mọi thứ stash trước đó (không `stash pop`). Project đang deploy bị khoá Edit/Delete trong trang Projects.

Bất kỳ bước nào lỗi thì quy trình dừng lại và log ghi rõ lỗi. Nếu lỗi xảy ra sau khi đã ghi file CI/CD và trước khi commit thành công, tool cố gắng khôi phục file về `HEAD`. Nếu commit đã tạo nhưng push lỗi, repo không bị đụng thêm: commit vẫn nằm ở local và log nói rõ điều đó (Dry Run cũng để lại commit local).

> ⚠️ **Lưu ý**: tool tự `git stash` các thay đổi chưa commit trong repo và **không** `stash pop` lại. Nếu bạn đang làm dở, hãy dùng `git stash list` / `git stash pop` để lấy lại sau khi deploy. Nên commit trước khi dùng tool.

## Hướng dẫn sử dụng

### Trang Deploy
1. Chọn project.
2. Chọn nhánh (danh sách tải từ remote của repo; có ô lọc nhanh).
3. Chọn môi trường và loại deploy; có thể chỉnh nhanh Commit format / File content format.
4. Tick **Dry Run** nếu chỉ muốn chạy thử, không push.
5. Bấm **Start Deploy**, xác nhận trong hộp thoại và theo dõi thanh bước cùng **Deploy Log** (dùng **Copy** để sao chép, **Clear** để xoá). Bấm **Cancel deploy** để huỷ trước khi bước Commit bắt đầu.

### Trang Projects
- **+ Add Project** để thêm; chọn một project trong danh sách để sửa hoặc xoá (có hộp thoại xác nhận khi xoá).
- Các field `envs`, `deployTypes` nhập dạng danh sách cách nhau bằng dấu phẩy.

### Trang History
Duyệt các file log theo ngày và bấm vào file để xem nội dung. Log lưu tại `<thư mục dữ liệu app>\logs\deploy-YYYY-MM-DD.log`.

### Trang Settings
Bật/tắt theme sáng/tối, xem phiên bản app và đường dẫn thư mục log.

## Nhiều cửa sổ

- Mở thêm cửa sổ bằng **File > New Deploy Window** (`Ctrl+N`).
- Mỗi cửa sổ có thể deploy một project khác nhau cùng lúc.
- Nếu Project A đang deploy ở cửa sổ 1, cửa sổ 2 không thể deploy Project A.
- Thay đổi cấu hình được đồng bộ sang mọi cửa sổ.

## Theme ngày lễ

Cấu hình trong [`extra/holidays-config.json`](extra/holidays-config.json). Mỗi ngày lễ gồm:

```json
{
  "id": "new-year",
  "name": "Tết Dương Lịch",
  "type": "solar",
  "date": "1/1",
  "daysBefore": 7,
  "daysAfter": 7,
  "theme": {
    "backgroundImage": "./../../assets/holidays/new-year-background.png",
    "animations": ["fireworks", "stars"]
  },
  "enabled": true
}
```

- `type`: `solar` (dương lịch) hoặc `lunar` (âm lịch); `date` theo dạng `"tháng/ngày"` (`M/D`), ví dụ `"5/1"` là ngày 1 tháng 5. Ngày âm lịch được quy đổi bằng bảng cố định chỉ gồm 3 ngày — `1/1` (Tết), `3/10` (Giỗ Tổ), `8/15` (Trung Thu) — cho năm 2024–2030; ngày âm khác hoặc năm ngoài khoảng này sẽ bị bỏ qua mà không báo lỗi. Ngày `3/10` của 2028–2030 trong bảng chưa được kiểm chứng (có thể lệch 1–2 ngày, xem TODO trong `holiday-theme-manager.ts`).
- `daysBefore` / `daysAfter`: số ngày áp dụng theme trước và sau ngày lễ.
- `enabled`: đặt `false` để tắt một ngày lễ.
- Ảnh nền đặt trong `assets/holidays/`.

## Đóng gói & phát hành

```bash
# 1. Cập nhật version trong package.json (commit: "chore: bump version to x.y.z")
# 2. Đóng gói
npm run dist        # kết quả nằm trong release/
```

Sau đó tạo GitHub Release với tag `vX.Y.Z` tại repo `dbs-thanh-dinh/electron-deploy-tool` và tải file cài đặt lên. Các bản đã cài sẽ tự phát hiện phiên bản mới qua `electron-updater` và hiện thông báo kèm link tới release.

## Cấu trúc thư mục

```
electron-deploy-tool/
├── src/
│   ├── main/                       # Main process (Node.js)
│   │   ├── main.ts                 # Khởi tạo app, menu, auto-update
│   │   ├── window-manager.ts       # Quản lý cửa sổ, trạng thái deploy
│   │   ├── deploy-service.ts       # Chạy lệnh git, ghi log, cập nhật file CI/CD
│   │   ├── deploy-utils.ts         # Hàm thuần: commit message, nội dung file CI/CD
│   │   ├── branch-utils.ts         # Lấy danh sách branch remote
│   │   ├── config-utils.ts         # Đọc/validate/ghi atomic scripts.json
│   │   ├── log-utils.ts            # Xoá log quá hạn
│   │   ├── deploy-steps.ts         # Kiểu/hằng các bước deploy, lỗi huỷ
│   │   ├── running-deploys.ts      # Theo dõi deploy từng cửa sổ để huỷ
│   │   ├── ipc-handlers.ts         # Các handler IPC
│   │   └── interface.ts            # Kiểu dữ liệu ProjectI, ConfigI
│   ├── preload/
│   │   └── preload.ts              # Cầu nối IPC (window.api)
│   └── renderer/                   # Renderer process (UI)
│       ├── index.html
│       ├── types.d.ts              # Kiểu cho window.api
│       ├── scripts/
│       │   ├── renderer.ts
│       │   └── holiday-theme-manager.ts
│       └── styles/                 # main.css, themes.css, holiday-theme.css
├── tests/                          # Test Vitest (main process + renderer qua jsdom)
├── docs/                           # Ghi chú quyết định triển khai
├── extra/
│   ├── scripts.json                # Cấu hình project mẫu
│   └── holidays-config.json        # Cấu hình theme ngày lễ
├── assets/
│   ├── icon.ico
│   └── holidays/                   # Ảnh nền ngày lễ
├── package.json
└── tsconfig.json
```

## Công nghệ

- **Electron 28** – nền tảng ứng dụng desktop
- **TypeScript** (strict) – main, preload và renderer
- **HTML/CSS** thuần – giao diện với theme sáng/tối
- **Node.js `child_process`** – thực thi lệnh git
- **electron-updater** – kiểm tra cập nhật qua GitHub Releases
- **electron-builder** – đóng gói MSI/NSIS
- **Vitest + jsdom** – test; **ESLint** (typescript-eslint) – lint

## Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `Repository path does not exist` | `repoPath` sai hoặc repo đã di chuyển | Sửa lại đường dẫn trong Projects |
| `<file> does not exist in repo` | Repo chưa có file CI/CD | Tạo file (mặc định `CICD.txt`) trong repo hoặc đổi `cicdFileName` |
| `Git push failed` | Thiếu quyền, chưa xác thực, hoặc nhánh bị bảo vệ | Kiểm tra `git push` thủ công trong repo |
| Dưới ô Branch hiện thông báo lỗi đỏ | `git fetch` lỗi (mạng/xác thực): danh sách vẫn là các nhánh đã cache từ lần fetch trước, có thể cũ | Chạy `git fetch --prune` thủ công trong repo |
| Danh sách nhánh trống kèm thông báo lỗi | `repoPath` sai, không phải repo git hoặc repo không có remote | Sửa `repoPath` trong Projects, kiểm tra `git remote -v` |
| `Project ... is already being deployed in another window` | Project đang deploy ở cửa sổ khác | Chờ deploy kia xong |
| Mất thay đổi chưa commit sau deploy | Tool đã `git stash` tự động | `git stash list` rồi `git stash pop` |
| Log báo lỗi khi chạy `git ...` (thường kèm `spawn git ENOENT`) hoặc `Git stash failed` | Git không có trong `PATH` | Cài Git và mở lại app |

## Giấy phép

MIT

## Tác giả

ThanhDC

---

**Lưu ý**: tool thực thi lệnh git trực tiếp trên repo cục bộ của bạn (stash, checkout, pull, commit, push). Hãy kiểm tra kỹ project, nhánh và môi trường trước khi deploy; dùng **Dry Run** nếu chưa chắc chắn.
