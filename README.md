# My Health

一个纯前端(无后端服务器)的家庭健康档案工具,支持:

- 🔒 全屏锁屏 + 密码/AES-256-GCM 本地加密(基于 PBKDF2 派生密钥)
- 🫆 指纹 / Face ID / Touch ID 解锁(WebAuthn PRF 扩展,逐设备绑定)
- 🗄️ IndexedDB 加密存储(附件照片/PDF 静态加密)
- 📦 Pack ZIP 备份(开启加密时,备份 JSON + `attachments/` 内所有文件均整体加密)
- 🔀 单成员导入的字段/条目级合并 + 冲突审阅
- 💊 Daily Plan(v62):每日补剂/药品清单,打卡/跳过、按需服用记录、时段可配置,日志 90 天滚动 + 月度汇总(详见 DAILY_PLAN_DESIGN.md)
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
