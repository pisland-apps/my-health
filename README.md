# My Health

一个纯前端(无后端服务器)的家庭健康档案工具,支持:

- 🔒 全屏锁屏 + 密码/AES-256-GCM 本地加密(基于 PBKDF2 派生密钥)
- 🫆 指纹 / Face ID / Touch ID 解锁(WebAuthn PRF 扩展,逐设备绑定)
- 🗄️ IndexedDB 加密存储(附件照片/PDF 静态加密)
- 📦 Pack ZIP 备份(开启加密时,备份 JSON + `attachments/` 内所有文件均整体加密)
- 🔀 单成员导入的字段/条目级合并 + 冲突审阅
- 💊 Daily Plan(v64):按疗程(Plan)分组的补剂/药品清单 —— 时段 / 每 N 小时(按实际服药时间重新计时)/ 按需服用;日历(✓ ◐ ✕ + 备注 + 收据/报告关联);90 天后单次明细自动折叠为每日记录,日历与备注保留直到手动删除(详见 DAILY_PLAN_DESIGN.md)
- 🔙 v66:解锁后自动回到上次所在页面(成员 + 标签页 + Plan 列表/日历视图);只保存成员 ID 和标签名,不含任何健康数据
- 📱 v72:Every-N-hours 药服用后,和其他药一致:「实际服用时间」显示在右边,「Next tomorrow …」移到下面小字行
- 📱 v71:手机上「Today」卡片更紧凑易读:按钮等宽一行;每个药改为「圆圈 | 药名+说明 | 时间/Skip」三栏,说明文字全宽显示,已服用的行淡化,服用时间输入框缩小,整体不用滚动太多
- 📱 v70:手机上成员信息头部重新排版:头像不再被压成椭圆,姓名/标签自动换行更整齐,「Edit Info」「Emergency Card」两个按钮独占一行等宽显示
- 🧰 v69:新增 Cabinet(家庭药箱)标签页:记录家里的药(名称、用途/备注、有效期、药盒照片/PDF);按有效期排序,过期标红,60 天内到期会出现在 Reminders;不会混进健康记录时间线、报告和日历;备份/ZIP/合并同步沿用 Records 机制
- 💊 v68:Every-N-hours 药(如 24 小时一次)服用后,当天保持 ✓ 打勾(右边仍显示下次时间),不再变回空圈;取消打勾(点 ✓、点 × 或点已勾选的时段圆圈)前会先弹出确认,避免误触
- 📂 v67:Overview 的 Basic Info 可折叠/展开(默认折叠,折叠时显示身高·体重·血型·BMI 摘要),让今日 Plan 不用下滑;选择会被记住
- 📱 PWA:可安装到主屏幕、Service Worker 离线缓存

所有数据都只保存在**用户自己浏览器的 localStorage / IndexedDB** 里,没有任何后端或云端同步。

> v53 起,本应用由 **Family Health & Shield** 改名为 **My Health**,并**移除了保险模块**(保险数据已迁移到 Ledger 应用)。

## 目录结构

```
my-health/
├── index.html              ← 页面结构 + CSP <meta>
├── styles.css              ← 全部样式(style-src 'self',无需哈希)
├── app.js                  ← 主应用逻辑
├── merge-engine.js         ← 单成员导入的合并引擎(纯函数,UMD)
├── merge-engine.test.js    ← `node merge-engine.test.js` 直接运行
├── MERGE_SYNC_DESIGN.md    ← 合并同步设计文档(历史文档,见文件开头说明)
├── manifest.json           ← Web App Manifest
├── service-worker.js       ← 离线缓存
├── _headers                ← Cloudflare Pages 自定义响应头(CSP / X-Frame-Options / HSTS 等)
├── lib/                    ← 本地 vendor 的 JSZip、pdf.js
├── icons/ , favicon.ico
└── README.md
```

## 新建 GitHub 仓库并连接 Cloudflare Pages

```bash
cd my-health
git init
git add .
git commit -m "My Health v53: rename, remove insurance module"
git branch -M main
git remote add origin https://github.com/<你的用户名>/my-health.git
git push -u origin main
```

1. 登录 [Cloudflare Pages](https://pages.cloudflare.com/) → **Create a project → Connect to Git**,选择 `my-health` 仓库
2. 项目名填 `my-health`(地址即 `https://my-health.pages.dev`,与 `my-ledger` 同一命名组)
3. Build command 留空,Output directory 留空或填 `/`(纯静态,没有构建步骤)
4. 部署后确认 `_headers` 生效:浏览器开发者工具 → Network → 点击 `index.html` → Response Headers 里能看到 `Content-Security-Policy`、`X-Frame-Options: DENY`
5. 手机打开新地址,"添加到主屏幕"安装

> ⚠️ **GitHub Pages 不支持自定义响应头**,`_headers` 在那里不会生效,请使用 Cloudflare Pages。

## 从旧版 Family Health & Shield 迁移

新地址是全新的浏览器源(origin),**所有数据从空白开始**,需要手动迁移一次:

1. 在旧应用里导出一份完整备份(JSON 或 Pack ZIP,加密与否均可)——**保留这个文件**
2. 打开新应用 → **Import** → 选择该文件(加密备份需输入当时的密码)
3. 如果文件里含保险数据,导入前的确认框会提示"含 N 份保单,将不会导入"。保险数据**每次导入都会被忽略**(不是只有第一次),原文件不会被修改
4. 核对成员数量、健康记录数量后,再决定是否停用旧应用
5. 首次打开会自动弹出"设置密码"窗口——建议**先设置密码再导入备份**,这样导入的数据直接以加密形式保存;可点"Skip for now"跳过(之后仍可在侧栏 ⚙ Setting → Security 里设置)。指纹/Face ID(绑定在域名上,无法迁移)需要重新开启,PWA 需要重新安装

## 更新部署后如何让访客拿到最新版本

`service-worker.js` 顶部的 `CACHE_VERSION` 每次改动 `index.html` / `app.js` 等 App Shell 文件后都要递增,同时更新 `app.js` 顶部的 `APP_VERSION` / `APP_VERSION_DATE`(版本徽章显示用,两处不会自动同步)。

## 本地调试与测试

```bash
python3 -m http.server 8000      # Service Worker 仅在 HTTPS 或 localhost 下生效
node merge-engine.test.js        # 合并引擎测试
```

## v73 - Google Drive sync (optional)

Settings -> **Google Drive sync** keeps several devices in step through the person's own Google Drive.

- Scope is `drive.appdata` only: the app can reach its own hidden folder, never other Drive files.
- Needs the passcode to be on. Data and every photo/PDF are encrypted on the device (AES-256-GCM, key = PBKDF2(passcode, driveSalt)) before upload; Google only stores ciphertext. Use the same passcode on every device.
- Sync is a merge (`FHSMerge.mergeMembers`), not an overwrite. Same item edited on two devices -> the existing Conflicts queue; deletions travel as tombstones.
- Files: `my-health-sync.json` (data) and `my-health-att-<id>.json` (one per attachment, uploaded/downloaded only when missing on the other side). Attachment files nobody references for 30 days are deleted.
- OAuth client: web client "My Health Web" in Google Cloud project `my-health` (consent screen published, only a non-sensitive scope, no verification needed). Authorized JavaScript origin must equal the site origin.
- Code: `drive-sync.js` (loaded after `app.js`), hooks in `app.js` (`FHSDrive.*`), `drive-sync.test.js` (`node drive-sync.test.js`, two simulated devices + fake Drive).
- CSP / headers: Google hosts added for the sign-in script and Drive API; `Cross-Origin-Opener-Policy` is `same-origin-allow-popups` because the Google sign-in pop-up needs it. `privacy.html` is the privacy policy linked from the Google consent screen.

## v74 - Shared medicines in the Home Medicine Cabinet

Each medicine has a **Share with the whole family** switch (Cabinet -> + Add medicine / Edit).

- Off (default): the medicine stays in that member's own cabinet, exactly as before.
- On: it also shows in every other member's Cabinet, under "Shared with the whole family", labelled "Shared by <owner>". Anyone can edit or delete it; only the member who added it can switch sharing off.
- Still ONE record, kept in its owner's `records` (`record.shared === true`; omitted = private). So sync, merge (`shared` is in `RECORD_SCALAR_KEYS`), export/import, attachments and Drive sync need no special handling. No "Home" member needed any more - existing items can simply be switched to shared.
- Expiry reminders for shared medicines appear for every member (each member dismisses them separately).
- Deleting a member also removes the medicines they shared; the confirmation says so.
- Tests: `node cabinet-share.test.js`.

## v75 - Sync status under the title

When Google Drive is connected, a small line under "My Health" shows the state: `☁️ Synced 11:39 AM`, `☁️ Syncing...`, `🔒 Unlock to sync`, or a red `⚠️ ...` (sign in again / reconnect / sync problem / passcode off). Tap it to open Settings -> Google Drive sync. Hidden when Drive is not connected.
