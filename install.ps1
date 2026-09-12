<#
    Hermes Wallpaper Engine — 一键安装脚本（Windows PowerShell 5.1+ / 7+）

    用法（朋友只需二选一）：
      A. 在线直装（无需克隆仓库）：
         iwr -useb https://raw.githubusercontent.com/linusxyao/Hermes-plugins-Wallpaper-Engine/main/install.ps1 | iex
      B. 已 git clone 本仓库的话，在仓库目录里执行：
         powershell -ExecutionPolicy Bypass -File .\install.ps1

    参数：
      -Uninstall   卸载（删除两个安装目录）
      -Disable     临时禁用（目录整体移入 disabled-plugins\，数据全保留）
      -Enable      恢复被 -Disable 移出的插件
      -Force       升级时不生成 .bak 备份，直接覆盖
      -Branch      指定分支（默认 main）

    脚本自动定位 Hermes 数据目录：$env:HERMES_HOME > %LOCALAPPDATA%\hermes > ~/.hermes。
    安装 = 把 dashboard/ 与 desktop/ 两个半区拷到正确位置；已有旧版自动备份
    （旧版里用户上传的壁纸 uploads/ 会原样迁回，纹理缓存自动重建无需保留）。
#>
[CmdletBinding()]
param(
    [string]$Branch = "main",
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$Disable,
    [switch]$Enable
)
$ErrorActionPreference = "Stop"
$Repo = "linusxyao/Hermes-plugins-Wallpaper-Engine"
$Name = "hermes-wallpaper-engine"

# ---------- 定位 Hermes 数据目录（profile 无关：两半区都装在 root 下） ----------
function Find-HermesHome {
    $candidates = @()
    if ($env:HERMES_HOME) { $candidates += $env:HERMES_HOME }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "hermes") }
    $candidates += (Join-Path $HOME ".hermes")
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

$HermesHome = Find-HermesHome
if (-not $HermesHome) {
    Write-Host "[X] 未找到 Hermes 数据目录（%LOCALAPPDATA%\hermes）。请先安装并启动过 Hermes 桌面端再运行本脚本。" -ForegroundColor Red
    exit 1
}

$DashDst = Join-Path $HermesHome "plugins\$Name\dashboard"
$DashSrcRoot = Join-Path $HermesHome "plugins\$Name"
$DeskDst = Join-Path $HermesHome "desktop-plugins\$Name"

# ---------- 禁用/启用分支 ----------
# 禁用 = 把两个安装目录整体挪到 disabled-plugins\ 暂存区（扫描根之外的位置）。
# 之所以是"搬走"而不是"改名"：插件扫描按目录内 manifest 识别，改名不换位置未必
# 能停用；搬到暂存区则确定不可见。用户数据（上传壁纸/缓存）原样跟着走，启用即还原。
$StoreRoot = Join-Path $HermesHome "disabled-plugins\$Name"
if ($Disable -or $Enable) {
    $pairs = @(
        @{ from = $DashSrcRoot; to = (Join-Path $StoreRoot "plugins") },
        @{ from = $DeskDst;     to = (Join-Path $StoreRoot "desktop") }
    )
    if ($Enable) { $pairs = @(@{ from = (Join-Path $StoreRoot "plugins"); to = $DashSrcRoot }, @{ from = (Join-Path $StoreRoot "desktop"); to = $DeskDst }) }
    $moved = 0
    foreach ($pair in $pairs) {
        if (Test-Path $pair.from) {
            New-Item -ItemType Directory -Force -Path (Split-Path $pair.to) | Out-Null
            Move-Item -Force $pair.from $pair.to
            Write-Host "[>] $($pair.from)  ->  $($pair.to)"
            $moved++
        }
    }
    if ($moved -eq 0) { Write-Host "[i] 没有需要移动的目录（当前状态已满足）。" }
    # 清掉搬空后残留的空骨架目录（enable 把子目录搬走后，暂存根会变成空壳）
    foreach ($prune in @($StoreRoot, (Join-Path $HermesHome "disabled-plugins"))) {
        if ((Test-Path $prune) -and -not (Get-ChildItem $prune)) { Remove-Item $prune }
    }
    $verb = if ($Disable) { "禁用" } else { "启用" }
    Write-Host "[OK] $verb 完成（重启 Hermes 生效）。" -ForegroundColor Green
    exit 0
}

# ---------- 卸载分支 ----------
if ($Uninstall) {
    $pluginRoot = Join-Path $HermesHome "plugins\$Name"
    # disabled-plugins 暂存区一并清掉，不留孤儿副本
    foreach ($d in @($pluginRoot, $DeskDst, $StoreRoot)) {
        if (Test-Path $d) { Remove-Item -Recurse -Force $d; Write-Host "[-] 已删除 $d" }
    }
    Write-Host "[OK] 卸载完成（重启 Hermes 生效）。聊天区所有磨砂覆盖会随之自动还原。" -ForegroundColor Green
    exit 0
}

# ---------- 取源码：本地克隆直装，否则下载仓库 zip ----------
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "dashboard\plugin_api.py"))) {
    $SrcRoot = $PSScriptRoot
    Write-Host "[i] 使用本地仓库副本：$SrcRoot"
} else {
    $Tmp = Join-Path $env:TEMP "wpe-install"
    $Zip = "$Tmp.zip"
    if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp }
    Write-Host "[..] 正在下载 $Repo ($Branch 分支) ..."
    Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $Zip
    Expand-Archive -Force $Zip $Tmp
    $SrcRoot = (Get-ChildItem $Tmp -Directory | Select-Object -First 1).FullName
}

# ---------- 部署一个半区；返回旧版备份路径（若有） ----------
function Deploy-Dir($src, $dst) {
    if (-not (Test-Path $src)) { throw "仓库缺少源目录 $src" }
    $bak = $null
    if ((Test-Path $dst) -and -not $Force) {
        $bak = "$dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Move-Item $dst $bak
        Write-Host "[i] 旧版本已备份：$bak"
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Recurse -Force (Join-Path $src "*") $dst
    Write-Host "[+] $dst"
    return $bak
}

# 升级前先清理"被禁用状态"下的旧暂存副本——否则 enable.bat 会把旧版本搬回来。
# 但暂存区里可能躺着用户上传的壁纸（禁用前传的）：先挪到临时目录保下来，删副本，
# 部署完再落位（若当前实例自己带 uploads 则以当前为准）。
$rescuedUploads = $null
if (Test-Path $StoreRoot) {
    $su = Join-Path $StoreRoot "plugins\dashboard\uploads"
    if (Test-Path $su) {
        $rescuedUploads = Join-Path $env:TEMP "wpe-uploads-keep"
        if (Test-Path $rescuedUploads) { Remove-Item -Recurse -Force $rescuedUploads }
        Move-Item $su $rescuedUploads
    }
    Remove-Item -Recurse -Force $StoreRoot
    Write-Host "[i] 已清理暂存的禁用副本（新版已就位，稍后 enable 无需恢复旧版）"
}

$bakDash = Deploy-Dir (Join-Path $SrcRoot "dashboard") $DashDst
Deploy-Dir (Join-Path $SrcRoot "desktop") $DeskDst | Out-Null

# 用户上传过的壁纸属于用户数据：从 .bak（活跃实例被部署挪走的部分）迁回；
# 禁装升级场景则回落到暂存区抢救出的副本。纹理缓存会按需重建，不用迁。
$UploadDst = Join-Path $DashDst "uploads"
if ($bakDash -and (Test-Path (Join-Path $bakDash "uploads"))) {
    Copy-Item -Recurse -Force (Join-Path $bakDash "uploads") $UploadDst
    Write-Host "[i] 已迁移原有上传壁纸"
} elseif ($rescuedUploads -and -not (Test-Path $UploadDst)) {
    Move-Item $rescuedUploads $UploadDst
    Write-Host "[i] 已恢复禁用期间暂存的上传壁纸"
}

Write-Host ""
Write-Host "[OK] 安装完成！请重启 Hermes 桌面端，然后：" -ForegroundColor Green
Write-Host "     设置 → 技能与工具 → 插件 → 启用『$Name』，"
Write-Host "     左侧栏出现 Wallpaper Engine 入口即可选壁纸。"
Write-Host "     （若启用后点击入口没反应：再重启一次即可——应用侧已知启用时序问题。）"
