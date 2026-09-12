# Hermes Wallpaper Engine Plugin（hermes-wallpaper-engine）

[English](#english) · [简体中文](#简体中文)

## English

> **Platform: Windows only** · **License: MIT** · Hermes desktop plugin SDK (2026-09 builds)

Render your local **Wallpaper Engine** wallpapers (video + scene main-textures + still images) behind the Hermes desktop chat, with an in-app picker page, six live-adjustable sliders, and a frosted-glass chat styling suite. Inspired by [dsh-plugin-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) (MIT), rebuilt natively on the Hermes desktop plugin SDK. **Zero core-source modification** — every file lives under the user data directory (`~/.hermes`); disabling or deleting the plugin restores the original look instantly.

**Quick install:** one PowerShell command, no manual copying —
`iwr -useb https://raw.githubusercontent.com/linusxyao/Hermes-plugins-Wallpaper-Engine/main/install.ps1 | iex`
(locates your Hermes data dir, downloads the repo, deploys both halves; re-run to upgrade, `-Uninstall` to remove).
Or manually: copy `dashboard/` → `~/.hermes/plugins/hermes-wallpaper-engine/` and `desktop/plugin.js` → `~/.hermes/desktop-plugins/hermes-wallpaper-engine/`, then restart Hermes. Requires Wallpaper Engine + Steam workshop content (auto-discovered via `libraryfolders.vdf`); without WE you can still use the built-in upload button (jpg/png/webp/gif/mp4/webm). Windows-only because thumbnails/downscaling use the built-in PowerShell + System.Drawing — which also means zero third-party dependencies.

**Capabilities** (declared 1:1 with the catalog entry): one sidebar route + one command-palette entry; plugin-namespaced REST routes (`/wallpapers`, `/resolve`, `/media`, `/thumbnails`, `/upload`, `/upload/delete`); one injected DOM backdrop layer; injected chat-frost stylesheets. No tools, no agent-loop hooks, no middleware, no env vars, no network egress beyond the local Hermes gateway.

Full documentation below is in Chinese. 建议先读"功能一览"与"已知边界"两节。

---

## 简体中文

> **适用平台：仅 Windows** · **许可证：MIT** · 基于 Hermes 桌面插件 SDK（2026-09 版本）

把本机 **Wallpaper Engine** 的壁纸（视频 + 场景主纹理 + 静态图）铺到 Hermes 桌面端聊天界面后方，附带应用内选页、六根实时滑条、聊天区磨砂美化套件。灵感来自 [dsh-plugin-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT），为 Hermes 桌面插件 SDK 全新实现。**零侵入 Hermes 核心源码**——所有文件都在用户数据目录内，禁用或删除插件即刻完全还原原始外观。

**快速安装**：`dashboard/` → `~/.hermes/plugins/hermes-wallpaper-engine/`、`desktop/plugin.js` → `~/.hermes/desktop-plugins/hermes-wallpaper-engine/`，然后重启 Hermes。需要本机装有 Wallpaper Engine 且 Steam 工坊有壁纸（经 `libraryfolders.vdf` 自动发现）；没有 WE 也能用内置的上传壁纸功能（jpg/png/webp/gif/mp4/webm）。仅支持 Windows 的原因是缩略图与大图降采样依赖系统自带的 PowerShell + System.Drawing——也因此零第三方依赖。

**能力声明**（与目录条目一字对应）：侧栏路由与命令面板入口各一；插件命名空间 REST 路由（`/wallpapers`、`/resolve`、`/media`、`/thumbnails`、`/upload`、`/upload/delete`）；注入一个壁纸 DOM 层与聊天磨砂样式表。无 tools、无 agent 循环 hook、无中间件、无环境变量，除本地 Hermes 网关外零网络请求。

以下为完整中文文档。

---

## 目录结构

```
Hermes-plugins-Wallpaper-Engine/
├── README.md                 本文件
├── LICENSE                   MIT
├── install.ps1               安装引擎（定位 Hermes 目录 + 部署/升级/禁用/启用/卸载）
├── install.bat               ← 双击安装/升级（朋友就用这个）
├── disable.bat               ← 双击临时禁用（数据保留）
├── enable.bat                ← 双击恢复启用
├── uninstall.bat             ← 双击卸载
├── catalog-entry/            官方插件目录的 YAML 条目草稿（提交素材，不随插件运行）
├── dashboard/                Python 后端（FastAPI，由 Hermes serve 挂载到
│   │                         /api/plugins/hermes-wallpaper-engine/）
│   ├── plugin_api.py         路由 + 壁纸扫描 + 场景主纹理提取 + 大图降采样
│   ├── _thumb_batch.py       批量缩略图（单 PowerShell 进程处理 N 张）
│   │                         ⚠ 两个 .py 的文件名都不可修改（按名动态加载）
│   └── manifest.json         后端清单（"api" 入口 + 页签注册）
└── desktop/
    └── plugin.js             桌面 UI（渲染进程热加载，纯 ESM 单文件）
```

## 安装

**方式一（推荐，朋友间分发用）：双击 bat 即可**——把仓库下载/克隆到任意位置
（不用 git 也行：GitHub 页面绿色 Code 按钮 → Download ZIP，解压），然后：

| 双击这个 | 干什么 |
|---|---|
| `install.bat` | 安装 / 升级（自动定位 Hermes 目录；重复执行=升级，旧版自动备份，**上传过的壁纸自动迁回**） |
| `disable.bat` | 临时禁用（插件整体移入 `disabled-plugins\` 暂存区，数据全保留） |
| `enable.bat` | 恢复启用（从暂存区搬回） |
| `uninstall.bat` | 卸载（有 Y/N 确认，删除插件目录） |

四个入口共用同一引擎 `install.ps1`（也可在 PowerShell 直接带参数跑：
`-Uninstall` / `-Disable` / `-Enable` / `-Force`）。若下载的文件被 Windows 标记
"来自 Internet"拦截运行：右键 bat → 属性 → 解除锁定。

不想下载任何东西的极客路线（在线直装）：

```powershell
iwr -useb https://raw.githubusercontent.com/linusxyao/Hermes-plugins-Wallpaper-Engine/main/install.ps1 | iex
```

**方式二（手动）：** 把两个半区分别放进用户数据目录（Windows 为
`%LOCALAPPDATA%\hermes\`，即 `~/.hermes`）：

```
dashboard/*    →  ~/.hermes/plugins/hermes-wallpaper-engine/dashboard/
desktop/plugin.js  →  ~/.hermes/desktop-plugins/hermes-wallpaper-engine/plugin.js
```

然后**重启 Hermes 桌面端**（Python 后端只在启动时导入；UI 半区虽然热加载，
新启用建议一并重启，避开应用侧的启用时序竞争——插件自带看门狗会在需要时提示）。

前置条件：本机安装 Wallpaper Engine，且 Steam 工坊有壁纸（插件自动从
`libraryfolders.vdf` 发现所有 Steam 库）。没有 WE 也能用：`上传壁纸` 按钮支持
jpg/png/webp/gif/mp4/webm 自定义素材。

## 功能一览（当前版本）

### 选页
- 273+ 壁纸网格（视频/场景/图片三类计数），类型/分级/对齐三个自绘下拉框
  （圆角、展开动效、选项全量中文化），筛选状态重启记忆
- 进入页面自动定位并滚动到当前壁纸；分页加载 + 无限滚动 + 悬停预热
- 语言：中/英/日/韩四语界面（右上角语言下拉框，写死词典、零网络）
- 自定义壁纸上传；筛选栏"来源"下拉可切换 全部/本地上传/壁纸库；本地上传卡片带
  ✕ 两段式删除（点一次变红确认、再点删除，只传 id 由后端校验落在 uploads 内）；上传后 Raycast 风格悬浮进度条（HUD）三段推进：定位中 → 已定位 →
  已在资源管理器打开所在目录（或显示落盘路径），并明确提示"未自动更换当前壁纸"

### 壁纸渲染
- 视频：Electron 原生 `hermes-media://` Range 流播，卡顿/失焦暂停自动续播
- 场景：从 `scene.pkg`（PKGV 包）按需提取真实主纹理（95% 可提取），
  不再显示"封面"；无摄影图层的纯粒子/3D 场景自动回落 preview
- 图片：经插件 `/media` 鉴权通道取 dataURI；>1.5MB 自动降采样 ≤2560px
- 六种对齐（同 Wallpaper Engine 官方）：覆盖/填充/居中/拉伸/自由/平铺
- 换壁纸错峰溶解：旧图慢淡出（850ms×滑条系数）、退场过半时新图带微推近慢浮现
  （图片附加焦点柔化 blur），"先消失后出现"的电影感交叠；3 秒自愈看门狗
- 缩略图磁盘缓存（dashboard/thumb_cache）：首次进页面后台预热全量缩略图，
  之后再进秒开；按 路径+文件mtime 键控，源图更新自动失效，LRU 上限 600

### 调节滑条（实时生效 + 持久化）
左栏：壁纸不透明度(5–100) · 面板不透明度(0–100) · 输入框不透明度 · 悬浮窗（对话框/菜单/命令面板/时间线窗统一）
右栏：模糊 · 暗化 · 亮度 · 失焦暗化(默认 0) · 切换过渡(100–1200ms，默认 400=标准档)

### 聊天区磨砂套件（仅玻璃模式生效，`:root[data-hermes-glass]` 限定）
- 用户消息背后的全宽实心遮带 → 完全透明（用户钦定）
- 气泡/代码卡片/组件卡片/pane 标签/标签条/输入框 → 磨砂化
- 悬浮窗家族（设置等对话框及其内部导航/开关、下拉/右键菜单、命令面板 Ctrl+K/P、时间线悬停窗、聊天「滚动到底/新消息」胶囊、通知 toast 卡片）→ 一根「悬浮窗」滑条统一控制（核心写死 95/96%）
- 气泡填充透明度**不碰**（归内置"设置→外观→消息气泡"滑条，避免控制冲突），
  插件只补该滑条没有的 backdrop 模糊
- pane 标签：8px 上圆角芯片 + accent 选中染色 + 蓝下划线 + 200ms 交叉淡变，
  浓度挂面板不透明度滑条
- 停用插件即全部还原

## 已知边界（非 bug）

- **聊天正文区壁纸透不出**：核心自有的不透明表面模型，插件按红线不 hack
- **终端正文保持实心**：`--ui-terminal-surface-background` 直接喂 xterm WebGL
  画布，半透明值会毁掉渲染（踩过，见代码红线注释）
- **失焦时整窗微亮**：Windows DWM 对 inactive acrylic 的系统行为，可用
  "失焦暗化"滑条按需补偿
- **启用插件后页面打不开**：应用侧启用时序竞争，看门狗会弹"重启一次"提示；
  ⌘K 里有直达命令作为第二入口

## 卸载

设置 → 技能与工具 → 插件 → 关闭开关（即时生效），或删掉上文安装路径里的
两个目录。禁用/删除后聊天区所有磨砂覆盖自动移除，恢复原样。

## 许可

MIT。仅依赖 Hermes 桌面插件 SDK 与 Python 标准库（PowerShell System.Drawing
为 Windows 自带组件）。
