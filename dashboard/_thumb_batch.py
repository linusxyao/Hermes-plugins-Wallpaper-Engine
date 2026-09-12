# -*- coding: utf-8 -*-
"""壁纸插件的批量缩略图器——N 张图共用一个 PowerShell 进程。
由 plugin_api.py 经 importlib 按文件路径动态加载（无包上下文），
独立成文件是为了让 plugin_api 保持单一 FastAPI 路由面。文件名不可改。

逐张起 PowerShell（每张 ~1.5 秒进程开销）曾经是选页首屏的大头：
8 张缩略图 = 8 次进程 = ~13 秒。批量化后 = 1 次进程 + N 次绘制。
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile


def make_thumbs_batch(paths: list[str], width: int = 320, timeout: int = 90) -> list[str]:
    """一个 PowerShell 进程批量缩略 N 张图。返回 base64 JPEG 字符串列表，
    失败项为空串。路径清单经临时 JSON 文件传入并 base64 编码——
    GBK 控制台代码页会毁掉内联的非 ASCII 路径。"""
    list_path = None
    try:
        payload = json.dumps(paths).encode("utf-8")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as f:
            f.write(payload)
            list_path = f.name
        list_b64 = base64.b64encode(list_path.encode("utf-8")).decode("ascii")
        ps = (
            "Add-Type -AssemblyName System.Drawing;"
            "$lf=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("
            f"'{list_b64}'));"
            "$paths=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($lf)) | ConvertFrom-Json;"
            "$out=@();"
            "foreach($p in $paths){"
            "try{"
            "$img=[System.Drawing.Image]::FromFile($p);"
            f"$w={width};"
            "$h=[int]($img.Height*$w/$img.Width);"
            "$bmp=New-Object System.Drawing.Bitmap($w,$h);"
            "$g=[System.Drawing.Graphics]::FromImage($bmp);"
            "$g.InterpolationMode='HighQualityBicubic';"
            "$g.DrawImage($img,0,0,$w,$h);"
            "$ms=New-Object System.IO.MemoryStream;"
            "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg);"
            "$out+=[Convert]::ToBase64String($ms.ToArray());"
            "$g.Dispose();$bmp.Dispose();$img.Dispose();$ms.Dispose()"
            "}catch{$out+=''}"
            "};"
            "$out -join '|'"
        )
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps],
            capture_output=True, timeout=timeout,
        )
        b64s = r.stdout.decode("ascii", errors="ignore").strip()
        if r.returncode == 0 and b64s:
            parts = b64s.split("|")
            return parts if len(parts) == len(paths) else ["" for _ in paths]
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    finally:
        try:
            if list_path and os.path.isfile(list_path):
                os.unlink(list_path)
        except OSError:
            pass
    return ["" for _ in paths]
