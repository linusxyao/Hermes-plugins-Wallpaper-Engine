# Hermes 壁纸引擎插件（hermes-wallpaper-engine）

把本机 **Wallpaper Engine** 的壁纸（视频 + 场景主纹理 + 静态图）铺到 Hermes 桌面端
聊天界面后方，附带应用内选页、六类可调滑条、聊天区磨砂美化套件。

灵感来自 [dsh-plugin-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)
（MIT），为 Hermes 桌面插件 SDK 全新实现。**零侵入 Hermes 源码**：所有文件都在用户数据
目录内，禁用/删除即完全还原。

## 目录结构

```
Hermes-plugins-Wallpaper-Engine/
├── README.md                 本文件
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

把两个半区分别放进用户数据目录（Windows 为 `%LOCALAPPDATA%\hermes\`，即 `~/.hermes`）：

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
- 自定义壁纸上传

### 壁纸渲染
- 视频：Electron 原生 `hermes-media://` Range 流播，卡顿/失焦暂停自动续播
- 场景：从 `scene.pkg`（PKGV 包）按需提取真实主纹理（95% 可提取），
  不再显示"封面"；无摄影图层的纯粒子/3D 场景自动回落 preview
- 图片：经插件 `/media` 鉴权通道取 dataURI；>1.5MB 自动降采样 ≤2560px
- 六种对齐（同 Wallpaper Engine 官方）：覆盖/填充/居中/拉伸/自由/平铺
- 换壁纸交叉淡入，无黑空窗；3 秒自愈看门狗，壁纸意外丢失自动重建

### 调节滑条（实时生效 + 持久化）
左栏：壁纸不透明度(5–100) · 面板不透明度(0–100) · 输入框不透明度 · 时间线浮窗
右栏：模糊 · 暗化 · 亮度 · 失焦暗化(默认 0)

### 聊天区磨砂套件（仅玻璃模式生效，`:root[data-hermes-glass]` 限定）
- 用户消息背后的全宽实心遮带 → 完全透明（用户钦定）
- 气泡/代码卡片/组件卡片/pane 标签/标签条/输入框 → 磨砂化
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
