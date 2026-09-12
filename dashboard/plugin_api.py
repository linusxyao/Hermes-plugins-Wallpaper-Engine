"""Wallpaper Engine plugin backend — single-file FastAPI router.

The Hermes web server imports this file via spec_from_file_location with NO
package context and NO sys.path entry for its directory, so everything lives
in this one file: wallpaper scanner + thumbnailer + HTTP routes.

Contract: module exposes `router` (FastAPI APIRouter), mounted by the host
under /api/plugins/hermes-wallpaper-engine/.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

import fastapi
from fastapi import APIRouter, File, HTTPException, Query, Request

# ================================================================ constants

WALLPAPER_ENGINE_DIRNAME = "wallpaper_engine"
STEAM_CONTENT_APP_ID = "431960"
PROJECT_FILENAME = "project.json"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mkv", ".mov", ".avi"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
THUMB_MAX_BYTES = 96 * 1024
THUMB_CAP_PER_REQUEST = 60
# 上传壁纸统一落盘在插件后端自己的 uploads 目录（可被 HERMES_WALLPAPER_UPLOADS 覆写）。
# 历史坑：此处曾指向 ~/.hermes-wallpaper/uploads，而旧版上传路由写的是插件目录下
# dashboard/uploads——两个"上传目录"分叉，上传成功的文件永远扫不到（2026-09 归一）。
UPLOAD_DIR = Path(os.environ.get("HERMES_WALLPAPER_UPLOADS",
                                 str(Path(__file__).resolve().parent / "uploads")))
_LEGACY_UPLOAD_DIR = Path.home() / ".hermes-wallpaper" / "uploads"  # 旧版落点，见下方一次性迁移
def _migrate_legacy_uploads() -> None:
    """一次性迁移：旧版（目录分叉 bug 时代）的上传文件从 ~/.hermes-wallpaper/uploads
    挪进归一后的 UPLOAD_DIR。同名不覆盖（加 -legacy 后缀）；旧目录清空后删除。"""
    try:
        if not _LEGACY_UPLOAD_DIR.is_dir():
            return
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        for child in _LEGACY_UPLOAD_DIR.iterdir():
            if not child.is_file():
                continue
            dest = UPLOAD_DIR / child.name
            if dest.exists():
                stem, ext = os.path.splitext(child.name)
                dest = UPLOAD_DIR / f"{stem}-legacy{ext}"
            child.rename(dest)
        if not any(_LEGACY_UPLOAD_DIR.iterdir()):
            _LEGACY_UPLOAD_DIR.rmdir()
    except OSError:
        pass  # 迁移失败不阻塞启动（最坏情况：旧文件继续躺在旧目录里）


_migrate_legacy_uploads()

MEDIA_EXTS = {".mp4", ".webm", ".mkv", ".mov"}

router = APIRouter()

# ================================================================ caches
# (added 2026-09-10: the picker's card grid + hover prefetch + resolve all
# hit scan_wallpapers; a cold walk over ~280 workshop dirs takes seconds and
# made wallpaper switching feel glacial. 20s TTL keeps it fresh for uploads.)

_SCAN_CACHE: dict[str, Any] | None = None
_SCAN_CACHE_AT: float = 0.0
_SCAN_CACHE_TTL = 20.0
_MEDIA_CACHE: dict[str, dict[str, Any]] = {}
_MEDIA_CACHE_MAX = 24

# ================================================================ scanner


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _find_steam_roots() -> list[Path]:
    roots: list[Path] = []
    candidates = [
        Path("C:/Program Files (x86)/Steam"),
        Path("D:/Steam"),
        Path("E:/Steam"),
        Path("F:/Steam"),
    ]
    for base in list(candidates):
        vdf = base / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            try:
                text = vdf.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for match in re.finditer(r'"path"\s*"([^"]+)"', text):
                p = match.group(1).replace("\\\\", "\\").strip("\\")
                candidate = Path(p)
                if candidate not in candidates:
                    candidates.append(candidate)
    seen: set[Path] = set()
    for base in candidates:
        workshop = base / "steamapps" / "workshop" / "content" / STEAM_CONTENT_APP_ID
        if workshop.is_dir():
            resolved = base.resolve()
            if resolved not in seen:
                seen.add(resolved)
                roots.append(resolved)
    return roots


def _find_we_install(steam_roots: list[Path]) -> Path | None:
    for root in steam_roots:
        for dirname in (WALLPAPER_ENGINE_DIRNAME, "Wallpaper Engine"):
            install = root / "steamapps" / "common" / dirname
            if install.is_dir():
                return install
    return None


def _preview_candidates(project_dir: Path, project: dict[str, Any]) -> list[Path]:
    cands = [
        project_dir / "preview.jpg",
        project_dir / "preview.png",
        project_dir / "preview.gif",
    ]
    file_field = project_dir / str(project.get("file") or "")
    if file_field.suffix.lower() in IMAGE_EXTENSIONS:
        cands.append(file_field)
    return cands


def _classify(project_dir: Path, project: dict[str, Any]) -> dict[str, Any] | None:
    wp_type = str(project.get("type") or "").strip().lower()
    title = str(project.get("title") or project_dir.name).strip() or project_dir.name
    rating = str(project.get("contentrating") or "").strip() or "Unrated"

    entry: dict[str, Any] = {
        "id": project_dir.name,
        "title": title,
        "type": wp_type or "unknown",
        "contentrating": rating,
        "dir": str(project_dir),
    }

    if wp_type == "video":
        media_name = str(project.get("file") or "").strip()
        media_path = project_dir / media_name if media_name else None
        if not media_path or not media_path.is_file():
            for child in sorted(project_dir.iterdir()):
                if child.suffix.lower() in VIDEO_EXTENSIONS:
                    media_path = child
                    break
        if media_path and media_path.is_file():
            entry["mediaPath"] = str(media_path)
            entry["mediaExt"] = media_path.suffix.lower()
            for cand in _preview_candidates(project_dir, project):
                if cand.is_file():
                    entry["previewPath"] = str(cand)
                    break
            return entry
        return None

    if wp_type == "web":
        return None

    for cand in _preview_candidates(project_dir, project):
        if cand.is_file():
            entry["previewPath"] = str(cand)
            break

    # Scene wallpapers: the real artwork lives inside scene.pkg (PKGV). The
    # preview often reads as a "cover" — extract the main texture ON DEMAND
    # (see /resolve), never during scan (200+ pkgs would slow the inventory).
    pkg = project_dir / "scene.pkg"
    if pkg.is_file():
        entry["pkgPath"] = str(pkg)
    if entry.get("previewPath") or entry.get("pkgPath"):
        return entry
    return None


def scan_wallpapers() -> dict[str, Any]:
    global _SCAN_CACHE, _SCAN_CACHE_AT
    now = time.monotonic()
    if _SCAN_CACHE is not None and (now - _SCAN_CACHE_AT) < _SCAN_CACHE_TTL:
        return _SCAN_CACHE

    steam_roots = _find_steam_roots()
    install = _find_we_install(steam_roots)
    scan_dirs: list[tuple[Path, str]] = []
    for root in steam_roots:
        workshop = root / "steamapps" / "workshop" / "content" / STEAM_CONTENT_APP_ID
        if workshop.is_dir():
            scan_dirs.append((workshop, "workshop"))
    if install:
        myprojects = install / "projects" / "myprojects"
        if myprojects.is_dir():
            scan_dirs.append((myprojects, "myprojects"))
    # Custom uploads: each media file in the uploads dir is a wallpaper.
    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        scan_dirs.append((UPLOAD_DIR, "uploads"))
    except OSError:
        pass

    entries: list[dict[str, Any]] = []
    for workshop_dir, source in scan_dirs:
        for child in sorted(workshop_dir.iterdir()):
            if source == "uploads" and child.is_file():
                # Flat custom upload: one media file = one wallpaper entry.
                ext = child.suffix.lower()
                if ext not in VIDEO_EXTENSIONS and ext not in IMAGE_EXTENSIONS:
                    continue
                entries.append({
                    "id": "upload-" + child.stem.lower().replace(" ", "-")[:40],
                    "title": child.stem,
                    "type": "video" if ext in VIDEO_EXTENSIONS else "image",
                    "contentrating": "Unrated",
                    "dir": str(child.parent),
                    "mediaPath": str(child) if ext in VIDEO_EXTENSIONS else "",
                    "previewPath": "" if ext in VIDEO_EXTENSIONS else str(child),
                    "source": source,
                })
                continue
            if not child.is_dir():
                continue
            project = _read_json(child / PROJECT_FILENAME)
            if project is None:
                continue
            entry = _classify(child, project)
            if entry is None:
                continue
            entry["source"] = source
            entries.append(entry)

    result = {
        "engineInstalled": install is not None,
        "steamRoots": [str(r) for r in steam_roots],
        "count": len(entries),
        "wallpapers": entries,
    }
    _SCAN_CACHE = result
    _SCAN_CACHE_AT = now
    return result


# ================================================================ scene textures

TEXTURE_CACHE_DIR = Path(__file__).resolve().parent / "texture_cache"
PKG_TEXTURE_MIN_BYTES = 40_000  # ignore small embedded icons/UI bits


def _extract_biggest_image(raw: bytes) -> tuple[bytes, str] | None:
    """Largest embedded JPEG/PNG in a PKGV blob. JPEG wins near-ties (WE
    authors photographic layers as JPEG; PNGs are usually UI/alpha sheets),
    but a clearly larger PNG is the real artwork."""
    best: dict[str, tuple[int, int, int]] = {}  # kind -> (size, start, end)
    png_sig = b"\x89PNG\x0d\x0a\x1a\x0a"
    for m in re.finditer(png_sig, raw):
        end = raw.find(b"IEND", m.start())
        if end != -1:
            size = end + 8 - m.start()
            if "png" not in best or size > best["png"][0]:
                best["png"] = (size, m.start(), end + 8)
    pos = 0
    while True:
        start = raw.find(b"\xff\xd8\xff", pos)
        if start == -1:
            break
        end = raw.find(b"\xff\xd9", start + 3)
        if end != -1:
            size = end + 2 - start
            if "jpg" not in best or size > best["jpg"][0]:
                best["jpg"] = (size, start, end + 2)
        pos = start + 3
    jpg = best.get("jpg")
    png = best.get("png")
    if jpg and (not png or jpg[0] >= png[0] * 0.8) and jpg[0] >= PKG_TEXTURE_MIN_BYTES:
        size, start, end = jpg
        return raw[start:end], "jpg"
    if png and png[0] >= PKG_TEXTURE_MIN_BYTES:
        size, start, end = png
        return raw[start:end], "png"
    return None


def _scene_texture(entry: dict[str, Any]) -> str | None:
    """Extract (once, disk-cached) the main texture of a scene wallpaper.
    Returns the cached file path, or None when the pkg holds no image."""
    pkg_path = entry.get("pkgPath")
    if not pkg_path:
        return None
    try:
        pkg_mtime = int(Path(pkg_path).stat().st_mtime)
    except OSError:
        return None
    TEXTURE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = TEXTURE_CACHE_DIR / f"{entry['id']}_{pkg_mtime}"
    if cached.with_suffix(".jpg").is_file():
        return str(cached.with_suffix(".jpg"))
    if cached.with_suffix(".png").is_file():
        return str(cached.with_suffix(".png"))
    try:
        raw = Path(pkg_path).read_bytes()
    except OSError:
        return None
    hit = _extract_biggest_image(raw)
    if not hit:
        return None
    blob, kind = hit
    out = cached.with_suffix(".jpg" if kind == "jpg" else ".png")
    try:
        out.write_bytes(blob)
        # Cap the cache well ABOVE the scene count (~202 on this machine) —
        # a cap below it thrashes: every rebuild re-extracts evicted pkgs.
        files = sorted(TEXTURE_CACHE_DIR.iterdir(), key=lambda f: f.stat().st_mtime)
        for stale in files[:-240]:
            stale.unlink(missing_ok=True)
    except OSError:
        return None
    return str(out)


# ================================================================ thumbnails


def make_thumb(path: Path, width: int = 320) -> bytes | None:
    """Small JPEG thumbnail via PowerShell System.Drawing (stdlib only)."""
    try:
        from base64 import b64encode

        # Pass the path base64-encoded: the GBK console codepage mangles
        # non-ASCII inline paths ("路径中具有非法字符").
        path_b64 = b64encode(str(path).encode("utf-8")).decode("ascii")
        ps = (
            "Add-Type -AssemblyName System.Drawing;"
            f"$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{path_b64}'));"
            "$img=[System.Drawing.Image]::FromFile($p);"
            f"$w={width};"
            "$h=[int]($img.Height*$w/$img.Width);"
            "$bmp=New-Object System.Drawing.Bitmap($w,$h);"
            "$g=[System.Drawing.Graphics]::FromImage($bmp);"
            "$g.InterpolationMode='HighQualityBicubic';"
            "$g.DrawImage($img,0,0,$w,$h);"
            "$ms=New-Object System.IO.MemoryStream;"
            "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg);"
            "[Convert]::ToBase64String($ms.ToArray());"
            "$g.Dispose();$bmp.Dispose();$img.Dispose()"
        )
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps],
            capture_output=True, timeout=20,
        )
        b64 = r.stdout.decode("ascii", errors="ignore").strip()
        if r.returncode == 0 and b64 and len(b64) < THUMB_MAX_BYTES * 2:
            return base64.b64decode(b64)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return None


def preview_data_uri(path_str: str) -> str | None:
    p = Path(path_str)
    if not p.is_file():
        return None
    thumb = make_thumb(p)
    if thumb is None:
        try:
            raw = p.read_bytes()
        except OSError:
            return None
        if len(raw) > THUMB_MAX_BYTES:
            return None
        thumb = raw
    mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(thumb).decode("ascii")




# ================================================================ uploads

# ================================================================ routes


def _path_is_safe(candidate: str) -> bool:
    """No traversal, no control/Windows-illegal chars; the drive colon is the
    ONLY colon allowed (at index 1)."""
    if ".." in candidate or "\x00" in candidate:
        return False
    if candidate.count(":") > 1:
        return False
    if ":" in candidate and candidate[1] != ":":
        return False
    return not re.compile(r'[<>"|?*\x00-\x1f]').search(candidate)


@router.get("/inventory")
def inventory(
    type: Optional[str] = Query(default=None),
    rating: Optional[str] = Query(default=None),
    limit: int = Query(default=0),
) -> dict:
    inv = scan_wallpapers()
    items = inv["wallpapers"]  # uploads 已由扫描器纳入（scan_dirs 含 UPLOAD_DIR），不再双路拼接
    if type:
        items = [w for w in items if w["type"] == type]
    if rating and rating != "all":
        items = [w for w in items if w["contentrating"].lower() == str(rating).lower()]
    if limit > 0:
        items = items[:limit]
    return {
        "engineInstalled": inv["engineInstalled"],
        "count": len(items),
        "total": inv["count"],
        "wallpapers": [
            {k: v for k, v in w.items() if k not in ("previewPath", "mediaPath")}
            for w in items
        ],
    }


UPLOAD_MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB


@router.post("/upload")
async def upload(file: fastapi.UploadFile = File(...)) -> dict:
    """Store a custom wallpaper (jpg/png/webp/gif/mp4/webm) in the uploads dir."""
    if file is None:
        raise HTTPException(status_code=400, detail="multipart file field required")
    data = await file.read()
    if len(data) > UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (1 GiB max)")
    name = os.path.basename(file.filename or "wallpaper")
    if not name or os.sep in name or "/" in name or name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    ext = os.path.splitext(name)[1].lower()
    if ext not in VIDEO_EXTENSIONS and ext not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported type {ext}")
    # 同名不覆盖：追加 -1/-2…（用户会反复上传同名文件）
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / name
    stem, ext = os.path.splitext(name)
    n = 1
    while dest.exists():
        dest = UPLOAD_DIR / f"{stem}-{n}{ext}"
        n += 1
    dest.write_bytes(data)
    global _SCAN_CACHE
    _SCAN_CACHE = None  # next inventory sees the new upload immediately
    # path 给 UI 展示与"打开所在文件夹"用（用户问：上传的图保存在哪里）
    return {"ok": True, "name": dest.name, "size": len(data), "path": str(dest)}


@router.post("/upload/delete")
def upload_delete(payload: dict | None = None) -> dict:
    """Delete a previously uploaded wallpaper file (uploads only, never WE dirs)."""
    payload = payload or {}
    name = os.path.basename(str(payload.get("name") or ""))
    dest = UPLOAD_DIR / name
    if not dest.resolve().is_relative_to(UPLOAD_DIR.resolve()) or not dest.is_file():
        raise HTTPException(status_code=404, detail="upload not found")
    dest.unlink()
    global _SCAN_CACHE
    _SCAN_CACHE = None  # 删除后立刻重扫：否则网格会挂着死卡片最长 20 秒，点开必报错
    return {"ok": True}


@router.get("/inventory/previews")
def previews(ids: str = Query(default="")) -> dict:
    wanted = [s.strip() for s in ids.split(",") if s.strip()][:THUMB_CAP_PER_REQUEST]
    inv = scan_wallpapers()
    by_id = {w["id"]: w for w in inv["wallpapers"]}
    order: list[str] = []
    paths: list[str] = []
    for wid in wanted:
        w = by_id.get(wid)
        if not w:
            continue
        src_path = w.get("previewPath")
        if src_path and Path(src_path).is_file():
            order.append(wid)
            paths.append(src_path)
    out: dict[str, str] = {}
    if paths:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location("_thumb_batch", Path(__file__).resolve().parent / "_thumb_batch.py")
        _tb = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_tb)
        results = _tb.make_thumbs_batch(paths)
        for wid, src_path, b64 in zip(order, paths, results):
            if b64:
                out[wid] = "data:image/jpeg;base64," + b64
            else:
                uri = preview_data_uri(src_path)  # per-item fallback
                if uri:
                    out[wid] = uri
    return {"previews": out}



def _downscale_bytes(raw: bytes, mime: str, max_dim: int = 2560) -> tuple[bytes, str] | None:
    """Downscale oversized images via PowerShell System.Drawing (stdlib only).

    Multi-megabyte wallpapers base64 into multi-MB JSON over the plugin REST
    channel — a visible chunk of the "switching takes forever" report. Bytes
    travel via TEMP FILES: inline base64 blows the 32k command-line cap on
    anything above ~24KB. Returns (bytes, mime) or None on any failure."""
    import tempfile
    src_ext = ".png" if "png" in mime else ".jpg"
    tmp_in = tmp_out = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=src_ext) as f:
            f.write(raw)
            tmp_in = f.name
        fd, tmp_out = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        in_b64 = base64.b64encode(tmp_in.encode("utf-8")).decode("ascii")
        out_b64 = base64.b64encode(tmp_out.encode("utf-8")).decode("ascii")
        ps = (
            "Add-Type -AssemblyName System.Drawing;"
            "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("
            f"'{in_b64}'));"
            "$o=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("
            f"'{out_b64}'));"
            "$img=[System.Drawing.Image]::FromFile($p);"
            f"$max={max_dim};"
            "$w=$img.Width;$h=$img.Height;"
            "if($w -gt $max -or $h -gt $max){"
            "if($w -ge $h){$nw=$max;$nh=[int]($img.Height*$max/$img.Width)}"
            "else{$nh=$max;$nw=[int]($img.Width*$max/$img.Height)}}"
            "else{$nw=$w;$nh=$h};"
            "$bmp=New-Object System.Drawing.Bitmap($nw,$nh);"
            "$g=[System.Drawing.Graphics]::FromImage($bmp);"
            "$g.InterpolationMode='HighQualityBicubic';"
            "$g.DrawImage($img,0,0,$nw,$nh);"
            "$bmp.Save($o,[System.Drawing.Imaging.ImageFormat]::Jpeg);"
            "$g.Dispose();$bmp.Dispose();$img.Dispose()"
        )
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps],
            capture_output=True, timeout=25,
        )
        if r.returncode == 0 and os.path.isfile(tmp_out):
            out = Path(tmp_out).read_bytes()
            if 0 < len(out) < len(raw):
                return out, "image/jpeg"
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    finally:
        for stale in (tmp_in, tmp_out):
            try:
                if stale and os.path.isfile(stale):
                    os.unlink(stale)
            except OSError:
                pass
    return None


@router.get("/media")
def media(path: str = Query(default="")) -> dict:
    """Base64 data-URI for an image wallpaper. Scanner-derived paths only —
    the <img> tag can't carry the session token header, so the UI fetches this
    via ctx.rest (which authenticates) and assigns the data URI directly.

    Results are cached in memory (LRU-ish cap) and oversized originals are
    downscaled once to <=2560px, so hover prefetch + repeated selection hit
    the cache instead of re-reading multi-MB files."""
    inv = scan_wallpapers()
    target = next((w for w in inv["wallpapers"] if w.get("previewPath") == path or w.get("mediaPath") == path), None)
    p = Path(path)
    # Paths produced by us (scene texture cache) are allowed as media sources —
    # verify by containment rather than exact scanner-listing.
    if target is None and not _path_is_safe(path):
        raise HTTPException(status_code=404, detail="wallpaper not found")
    if target is None:
        cache_dir = TEXTURE_CACHE_DIR.resolve()
        if not p.resolve().is_relative_to(cache_dir) or not p.is_file():
            raise HTTPException(status_code=404, detail="wallpaper not found")
    elif not _path_is_safe(path):
        raise HTTPException(status_code=404, detail="wallpaper not found")
    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="not an image wallpaper")

    mtime = p.stat().st_mtime
    cached = _MEDIA_CACHE.get(path)
    if cached and cached["mtime"] == mtime:
        return {"ok": True, "dataUrl": cached["dataUrl"]}

    raw = p.read_bytes()
    mime = "image/png" if p.suffix.lower() == ".png" else ("image/gif" if p.suffix.lower() == ".gif" else "image/jpeg")
    payload, out_mime = raw, mime
    if len(raw) > 1_500_000 and mime != "image/gif":
        # Only bother downsizing the heavy ones; GIFs re-encode badly as JPEG.
        ds = _downscale_bytes(raw, mime)
        if ds is not None:
            payload, out_mime = ds
    data_url = f"data:{out_mime};base64," + base64.b64encode(payload).decode("ascii")

    if len(_MEDIA_CACHE) >= _MEDIA_CACHE_MAX:
        _MEDIA_CACHE.pop(next(iter(_MEDIA_CACHE)))
    _MEDIA_CACHE[path] = {"mtime": mtime, "dataUrl": data_url}
    return {"ok": True, "dataUrl": data_url}


@router.post("/resolve")
def resolve(payload: dict | None = None) -> dict:
    payload = payload or {}
    wid = str(payload.get("id") or "")
    raw = str(payload.get("path") or "")
    inv = scan_wallpapers()
    all_w = inv["wallpapers"]
    target = next((w for w in all_w if w["id"] == wid), None)

    # Only scanner-derived records are honored — no arbitrary filesystem access.
    candidate = (target or {}).get("mediaPath") or (target or {}).get("previewPath") or ""
    if not target and raw:
        candidate = raw
    if not candidate:
        raise HTTPException(status_code=404, detail="wallpaper not found")

    p = Path(candidate)
    if not _path_is_safe(candidate) or not p.is_file():
        raise HTTPException(status_code=400, detail="unsafe or missing media path")
    ext = p.suffix.lower()
    if ext not in MEDIA_EXTS and ext not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"unsupported media type {ext}")

    # Scene wallpaper: prefer the main texture extracted from scene.pkg —
    # the preview.jpg often reads as a cover/promo frame (user report:
    # "显示的还是封面"). Falls back to the preview when extraction yields
    # nothing (pure particle/3D scenes have no photographic texture).
    if target and target.get("type") == "scene" and target.get("pkgPath"):
        tex = _scene_texture(target)
        if tex:
            p = Path(tex)
            ext = p.suffix.lower()

    return {
        "ok": True,
        "path": str(p.resolve()),
        "type": target["type"] if target else "unknown",
        "title": target["title"] if target else p.stem,
    }
