/**
 * Hermes Wallpaper Engine Backdrop — desktop UI half.
 *
 * Runtime constraints learned the hard way:
 *  - Only `@hermes/plugin-sdk` and `react` import specifiers resolve.
 *  - Runtime plugin code does NOT go through the app's Tailwind build — any
 *    Tailwind utility in className is dead. ALL styling is inline style objects
 *    (plus one injected stylesheet for :hover rules, see ensureStyles).
 *  - `pluginRest` has NO per-call profile option (only a module-global
 *    _apiProfile) — per-call "profile:" opts are silently ignored. The Python
 *    backend therefore lives in the ROOT plugins dir (AppData/Local/hermes/
 *    plugins/, scanned by EVERY profile's serve) so the primary backend
 *    mounts it; the linghua-profile copy is redundant but kept in sync.
 *  - Hooks order: WallpaperPicker renders early-return states, so ALL hooks
 *    must run before any return (React #310 otherwise). Dropdown keeps its
 *    own hooks and never early-returns.
 *  - Hot reloads orphan the previous backdrop layer — apply() adopts/sweeps.
 *
 * THEME FOLLOW: the picker follows Hermes' active appearance via
 * `useTheme().renderedMode`. UseTheme must run unconditionally (hooks
 * invariant), so palettes are computed per render.
 *
 * Readability: panels stay near-opaque (>= 90% surface alpha + backdrop blur)
 * in BOTH modes, so wallpaper bleed never decides text contrast.
 *
 * Switching speed (user report: "半天才换"): the old flow cleared the layer
 * and THEN fetched/decoded the new media, so the old wallpaper vanished long
 * before the new one painted. Now new media is appended hidden and
 * cross-faded in when ready, card hover pre-warms /resolve + the image data
 * URI, and the backend serves downscaled+cached images.
 *
 * Focus dim (user report: clicking another app makes the wallpaper brighter):
 * the window runs Windows glass (acrylic) and DWM brightens inactive acrylic.
 * The plugin cannot touch DWM, so it compensates on its dim layer while
 * blurred (see _windowBlurred / dimColor).
 */

import { host, PALETTE_AREA, useTheme } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'hermes-wallpaper-engine'

let _ctx = null

// ---------------------------------------------------------------- tiny store

const STORAGE_KEY = 'wallpaper.v1'
const listeners = new Set()
let settings = null

function defaults() {
  return {
    wallpaperId: '', type: '', mediaPath: '', previewPath: '', wallpaperTitle: '',
    opacity: 35, blur: 0, dim: 25, brightness: 100, panelOpacity: 85,
    composerAlpha: 45, blurDim: 0, timelineAlpha: 55, fadeMs: 400,
    typeFilter: 'all', ratingFilter: 'all',
    fit: 'cover', posX: 50, posY: 50, scale: 100,
    hidden: [],
  }
}

function loadSettings() {
  const d = defaults()
  try {
    const raw = _ctx?.storage.get(STORAGE_KEY)
    if (raw) return { ...d, ...JSON.parse(raw) }
  } catch { /* fall through */ }
  return d
}

const PAGE_SIZE = 28

function getSettings() {
  if (!settings) settings = loadSettings()
  return settings
}

function setSettings(next) {
  settings = next
  try { _ctx?.storage.set(STORAGE_KEY, JSON.stringify(next)) } catch { /* non-fatal */ }
  listeners.forEach(fn => fn(settings))
}

function useSettings() {
  const [s, setS] = useState(getSettings())
  useEffect(() => {
    const fn = v => setS({ ...v })
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return s
}

let inventory = { wallpapers: [], count: 0, total: 0, loaded: false }
const invListeners = new Set()
let previews = {}
const pvListeners = new Set()

function setInventory(next) { inventory = next; invListeners.forEach(fn => fn(inventory)) }
function setPreviews(next) { previews = next; pvListeners.forEach(fn => fn(previews)) }

function useStoreValue(get, ls) {
  const [v, setV] = useState(get())
  useEffect(() => {
    const fn = x => setV({ ...x })
    ls.add(fn)
    return () => { ls.delete(fn) }
  }, [])
  return v
}
const useInventory = () => useStoreValue(() => inventory, invListeners)
const usePreviews = () => useStoreValue(() => previews, pvListeners)

// 上传后跳转（用户批准的方案：不自动选中，但滚到新卡片并闪一下高亮）。
// 上传成功只记名字，真正的跳转在库存刷新完成后由 locate-upload effect 执行。
let _justUploaded = null
let _hud = null
let _warmSent = false

function reloadInventory() {
  if (!_ctx) return
  _ctx.rest('/inventory?limit=0').then(inv => {
    setInventory({ ...inv, loaded: true })
  }).catch(err => {
    host.notify({ kind: 'error', message: 'Wallpaper inventory failed: ' + err })
  })
}

function loadPreviews(ids) {
  if (!_ctx || !ids.length) return
  _ctx.rest('/inventory/previews?ids=' + encodeURIComponent(ids.join(','))).then(r => {
    setPreviews({ ...previews, ...r.previews })
  }).catch(() => { /* thumbnails are decorative */ })
}

// Hover pre-warm (switching speed): resolve the wallpaper and, for images,
// fetch the data URI into cache BEFORE the user clicks. Videos stream with
// Range requests and are fast, so only images need the head start.
const _prefetchInflight = new Set()
function prefetchWallpaper(w) {
  if (!_ctx || w.type === 'web') return
  if (_prefetchInflight.has(w.id)) return
  _prefetchInflight.add(w.id)
  _ctx.rest('/resolve', { method: 'POST', body: { id: w.id } }).then(r => {
    if (r?.ok && r.type !== 'video' && r.path) return fetchImageDataUri(r.path)
    return null
  }).catch(() => { /* prefetch is best-effort */ }).finally(() => {
    _prefetchInflight.delete(w.id)
  })
}

// ---------------------------------------------------------------- backdrop DOM layer

let backdropEl = null
let backdropVideo = null
const BACKDROP_SLOT = 'wallpaper-backdrop'

// ---- 壁纸切换动画（参考本地设计库 awesome-design-md/starbucks 的
// imageFadeTransition："opacity 0.3s ease-in on load, prevents jarring
// pop-in"——在它基础上升级为电影感换法：新层 opacity+轻微推近(+图片附加
// 焦点柔化 blur)淡入，旧层同步淡出，形成真·交叉溶解。WAAPI 不占用
// style/transform，动画落回后 fit 模式的样式不受影响；CSS transition
// 作为 WAAPI 不可用时的降级兜底。 ----
// 时长由"切换过渡"滑条驱动（fadeMs 100~1200，默认 400=标准档，线性放大）：
// 旧层 leave 850ms 慢淡出，新层 enter 620ms 在旧层退场 ~55% 处错峰起步——
// "快消失但没完全消失时新图浮现"的交叠溶解（用户定稿的叙事节奏）。
function wpeTimings() {
  const f = (getSettings().fadeMs ?? 400) / 400  // 400=标准档，滑条 100~1200
  const leave = Math.round(850 * f)
  // 新层在旧层退场进度 ~55% 处起步（两影交叠的错峰溶解）：旧图"快没完全
  // 没掉"时新图已经浮现，视觉上比串行的 淡完→再显 连贯得多（用户定稿）。
  return { enter: Math.round(620 * f), leave, enterDelay: Math.round(leave * 0.55) }
}
function wpeEnter(el, withBlur) {
  const T = wpeTimings()
  try {
    const from = { opacity: 0, transform: 'scale(1.025)' }
    const to = { opacity: 1, transform: 'scale(1)' }
    if (withBlur) { from.filter = 'blur(7px)'; to.filter = 'blur(0)' }
    // delay 期间 fill:'backwards' 把元素按在 from 帧（透明）——没有
    // setTimeout 那种"迟到前已按 style 显示"的竞态窗口。
    el.animate([from, to], { duration: T.enter, delay: T.enterDelay,
      easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' })
  } catch { /* 老内核无 WAAPI：保持 style 现状（opacity 已是 1），只是没有动画 */ }
}
function wpeFadeOut(nodes) {
  const T = wpeTimings()
  for (const x of nodes) {
    if (!x.isConnected || x.dataset.fading) continue
    x.dataset.fading = '1'
    try {
      const a = x.animate([{ opacity: Number(getComputedStyle(x).opacity) || 1 }, { opacity: 0 }],
        { duration: T.leave, easing: 'ease-in', fill: 'forwards' })
      a.onfinish = () => x.remove()
      setTimeout(() => x.remove(), T.leave + 500)  // onfinish 偶发不触发（遮挡节流）的保险
    } catch { x.remove() }
  }
}

// HOT-RELOAD SAFETY: each reload creates a fresh module instance whose
// `backdropEl` is null. Adopt the existing layer, sweep orphans — never stack.
function reclaimBackdropLayers() {
  const existing = document.querySelectorAll(`div[data-slot="${BACKDROP_SLOT}"]`)
  if (existing.length === 0) return null
  const adopted = existing[0]
  for (let i = 1; i < existing.length; i++) existing[i].remove()
  backdropEl = adopted
  backdropVideo = adopted.querySelector('video') || null
  return adopted
}

// Scene/image wallpapers: hermes-media:// only streams AV extensions (no
// jpg/png), and gateway image routes can't be used from a bare <img> (no
// session-token header). So image wallpapers are fetched as base64 data URIs
// through the plugin's own /media route (scanner-validated paths, ctx.rest
// carries the auth header), then assigned to the <img>. Videos keep
// hermes-media://stream (Range-capable AV streaming).
const dataUriCache = new Map()

function isAvPath(absPath) {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase()
  return ['.mp4', '.webm', '.mkv', '.mov', '.avi'].includes(ext)
}

function mediaUrl(absPath) {
  return 'hermes-media://stream/' + encodeURIComponent(absPath)
}

function fetchImageDataUri(absPath) {
  if (dataUriCache.has(absPath)) return Promise.resolve(dataUriCache.get(absPath))
  if (!_ctx) return Promise.resolve(null)
  return _ctx.rest('/media?path=' + encodeURIComponent(absPath)).then(r => {
    if (r?.ok && r.dataUrl) {
      dataUriCache.set(absPath, r.dataUrl)
      return r.dataUrl
    }
    return null
  }).catch(() => null)
}

// FOCUS DIM: DWM paints inactive acrylic brighter than active acrylic, which
// read as "the wallpaper got brighter when I clicked another window". Track
// window focus and deepen the dim layer a notch while blurred.
let _windowBlurred = false
let _lastDimPct = 25

// blurDim (user slider, default 0): how much EXTRA black the dim layer takes
// on while the window is blurred. The old hardcoded +0.18 auto-compensation
// for DWM's inactive-acrylic brightening OVER-compensated at low translucency
// — the whole window visibly darkened on focus loss (user report). Off by
// default now; anyone who wants the compensation can dial it in.
let _blurDim = 0
function dimColor(basePct) {
  const v = Math.min(basePct / 100 + (_windowBlurred ? _blurDim / 100 : 0), 0.85)
  return `rgba(0,0,0,${v})`
}

function setDim(basePct) {
  _lastDimPct = basePct
  if (!backdropEl) return
  let dim = backdropEl.querySelector('[data-role="dim"]')
  if (!dim) {
    dim = document.createElement('div')
    dim.dataset.role = 'dim'
  }
  dim.style.cssText = `position:absolute;inset:0;background:${dimColor(basePct)};transition:background 200ms ease`
  backdropEl.appendChild(dim) // keep the dim overlay the LAST child
}

function refreshDim() {
  setDim(_lastDimPct)
}

// Fit modes (Wallpaper Engine parity): cover / contain / fill(stretch) /
// tile / center (original size) / custom free (scale + position).
function mediaStyleFor(s) {
  const fit = s.fit || 'cover'
  const posX = (s.posX ?? 50) + '%'
  const posY = (s.posY ?? 50) + '%'
  const scale = (s.scale ?? 100) / 100
  if (fit === 'tile') {
    return { width: `${100 * scale}%`, height: 'auto', objectFit: 'fill', backgroundRepeat: 'repeat' }
  }
  if (fit === 'fill') {
    return { width: '100%', height: '100%', objectFit: 'fill' }
  }
  if (fit === 'center') {
    return { width: '100%', height: '100%', objectFit: 'none', objectPosition: `${posX} ${posY}` }
  }
  if (fit === 'contain') {
    return { width: '100%', height: '100%', objectFit: 'contain', objectPosition: `${posX} ${posY}` }
  }
  if (fit === 'custom' || fit === 'free') {
    return {
      width: '100%', height: '100%', objectFit: 'cover',
      transform: `scale(${scale})`, transformOrigin: `${posX} ${posY}`,
    }
  }
  return { width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${posX} ${posY}` }
}

// Fit styles merge onto an element's existing style, so switching modes must
// CLEAR the previous mode's properties or they bleed (user: 换过几种对齐再换回
// 覆盖后壁纸"不见了" — tile mode had stripped the <img src>, free mode's
// transform:scale lingered, both leave a blank or broken layer).
function setMediaFitStyle(el, st) {
  el.style.transform = ''
  el.style.transformOrigin = ''
  el.style.backgroundImage = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundSize = ''
  Object.assign(el.style, mediaStyleFor(st))
}

// Slider drags fire a settings event per tick; rebuilding the layer's
// blur/brightness filter every tick makes Chromium re-raster the whole
// backdrop and it can flash the window background between paints (user's
// "壁纸变白闪烁"). Coalesce to one application per animation frame.
let _applyQueued = false
let _applyPending = null
function scheduleApply(s) {
  _applyPending = s
  if (_applyQueued) return
  _applyQueued = true
  requestAnimationFrame(() => {
    _applyQueued = false
    applyBackdrop(_applyPending)
  })
}

function applyBackdrop(s) {
  if (typeof document === 'undefined') return

  if (!s.wallpaperId || (!s.mediaPath && !s.previewPath)) {
    if (backdropEl) { backdropEl.remove(); backdropEl = null; backdropVideo = null }
    document.querySelectorAll(`div[data-slot="${BACKDROP_SLOT}"]`).forEach(el => el.remove())
    return
  }

  if (!backdropEl || !backdropEl.isConnected) {
    backdropEl = reclaimBackdropLayers()
    if (!backdropEl) {
      backdropEl = document.createElement('div')
      backdropEl.setAttribute('data-slot', BACKDROP_SLOT)
      Object.assign(backdropEl.style, {
        position: 'fixed', inset: '0', zIndex: '0', pointerEvents: 'none',
        overflow: 'hidden',
      })
      document.body.insertBefore(backdropEl, document.body.firstChild)
    }
  }

  const isVideo = s.type === 'video' && isAvPath(s.mediaPath || '')

  _blurDim = Math.min(Math.max(s.blurDim ?? 0, 0), 60)
  backdropEl.style.opacity = String(s.opacity / 100)
  backdropEl.style.filter = `blur(${s.blur}px) brightness(${s.brightness}%)`

  const useTile = s.fit === 'tile'

  if (isVideo) {
    const src = mediaUrl(s.mediaPath)
    if (!backdropVideo || backdropVideo.dataset.src !== src || !backdropVideo.isConnected) {
      // CROSSFADE: keep the old video painted until the new one actually
      // plays — never blank the layer first (that was the "半天才换" gap).
      const old = backdropVideo && backdropVideo.isConnected ? backdropVideo : null
      const v = document.createElement('video')
      v.dataset.src = src
      v.style.cssText = 'position:absolute;inset:0;opacity:0;transition:opacity 260ms ease'
      Object.assign(v.style, useTile
        ? { width: '100%', height: '100%', objectFit: 'cover' }
        : mediaStyleFor(s))
      v.muted = true
      v.autoplay = true
      v.loop = true
      v.setAttribute('playsinline', '')
      v.src = src
      backdropEl.appendChild(v)
      const reveal = () => {
        v.style.opacity = '1'
        wpeEnter(v, false)  // 视频不加 blur：全屏解码已经吃 GPU，只留淡入+微推近
        wpeFadeOut([...backdropEl.querySelectorAll('video')].filter(x => x !== v))
        wpeFadeOut([...backdropEl.querySelectorAll('img')])
        backdropVideo = v
        setDim(_lastDimPct)  // re-stack the dim overlay ABOVE the new media
      }
      v.addEventListener('playing', reveal, { once: true })
      // Stream stalls and Chromium's occlusion throttling leave muted loop
      // videos paused with nobody to resume them (user: 动态壁纸不动了).
      // Any pause that isn't our teardown (isConnected check) -> play again.
      v.addEventListener('stalled', () => { if (v.isConnected) v.play().catch(() => {}) })
      v.addEventListener('pause', () => { if (v.isConnected) v.play().catch(() => {}) })
      // If 'playing' never fires (stall / autoplay hiccup) the layer would sit
      // at opacity 0 forever — reveal on first data when nothing older is
      // showing, and force-reveal after 4s regardless (a first frame beats a
      // blank window).
      v.addEventListener('loadeddata', () => { if (!old && v.style.opacity !== '1') reveal() }, { once: true })
      setTimeout(() => { if (v.isConnected && v.style.opacity !== '1') reveal() }, 4000)
    } else {
      // Live-update fit on an existing video without reloading it.
      if (useTile) Object.assign(backdropVideo.style, { width: '100%', height: '100%', objectFit: 'cover' })
      else setMediaFitStyle(backdropVideo, s)
    }
    if (backdropVideo) backdropVideo.play?.().catch(() => {})
  } else {
    // Image wallpaper: fetch as data URI (auth'd), then paint. Async but
    // idempotent — repeated calls with the same path are cache hits.
    const imgPath = s.previewPath || s.mediaPath
    fetchImageDataUri(imgPath).then(dataUrl => {
      if (!dataUrl || typeof document === 'undefined') return
      if (!backdropEl || !backdropEl.isConnected) return
      const same = Array.from(backdropEl.querySelectorAll('img')).find(x => x.dataset.src === imgPath)
      if (same) {
        // Same image — live-update fit styles only.
        if (useTile) {
          Object.assign(same.style, {
            width: '100%', height: '100%',
            backgroundImage: `url(${dataUrl})`, backgroundRepeat: 'repeat',
            backgroundSize: `${100 * (s.scale ?? 100) / 100}% auto`, objectFit: 'fill',
          })
          same.removeAttribute('src')
        } else {
          setMediaFitStyle(same, s)
          // Tile mode strips src (it paints via backgroundImage) — put it back
          // or the img renders nothing once tile styles are scrubbed.
          if (!same.getAttribute('src')) same.src = dataUrl
        }
        return
      }
      // CROSSFADE: append the new image hidden, fade it in over the old one,
      // THEN remove the old. Old wallpaper stays visible until the new one
      // is actually decodable — no more flash-to-background while loading.
      const el = document.createElement('img')
      el.dataset.src = imgPath
      el.style.cssText = 'position:absolute;inset:0;opacity:0;transition:opacity 260ms ease'
      if (useTile) {
        Object.assign(el.style, {
          width: '100%', height: '100%',
          backgroundImage: `url(${dataUrl})`, backgroundRepeat: 'repeat',
          backgroundSize: `${100 * (s.scale ?? 100) / 100}% auto`,
        })
      } else {
        Object.assign(el.style, mediaStyleFor(s))
        el.src = dataUrl
      }
      backdropEl.appendChild(el)
      const reveal = () => {
        el.style.opacity = '1'
        wpeEnter(el, true)  // 图片走完整"焦点柔化"入场（blur 一次性，成本可忽略）
        wpeFadeOut([...backdropEl.querySelectorAll('img')].filter(x => x !== el))
        wpeFadeOut([...backdropEl.querySelectorAll('video')])
        backdropVideo = null
        setDim(_lastDimPct)  // re-stack the dim overlay ABOVE the new media
      }
      if (useTile) reveal()  // backgroundImage paints now; no src -> no load event
      else if (el.complete && el.naturalWidth > 0) reveal()
      else {
        el.addEventListener('load', reveal, { once: true })
        el.addEventListener('error', () => el.remove(), { once: true })
      }
    })
  }

  setDim(s.dim)
}

// Self-heal: settings say a wallpaper is active but the layer lost its media
// (stuck hidden, orphaned by hot reload, raced away) — rebuild within 3s.
let _healTimer = null
function startHealWatch() {
  if (_healTimer || typeof window === 'undefined') return
  _healTimer = setInterval(() => {
    const st = getSettings()
    if (!st.wallpaperId || (!st.mediaPath && !st.previewPath)) return
    // 交叉淡入期间层里有新旧两枚媒体：巡检对象取【最后】一个（最新层），
    // 旧层是正在淡出的过渡残影，不归它管。
    const mediaList = backdropEl && backdropEl.isConnected ? backdropEl.querySelectorAll('img,video') : null
    const media = mediaList && mediaList.length ? mediaList[mediaList.length - 1] : null
    if (!media) { applyBackdrop(st); return }
    // 强制显现卡死层。两条防误伤：①IMG 必须真解码完（complete+naturalWidth，
    // 下载中不能提前揭示=半张图闪烁）②连续两轮巡检都卡住才救（≥6s），给
    // load/playing 事件与 4s 强制显示留足余地。
    if (media.style.opacity === '0') {
      const decoded = media.tagName === 'IMG' ? (media.complete && media.naturalWidth > 0) : media.readyState >= 2
      if (decoded && media.dataset.healseen) media.style.opacity = '1'
      else if (decoded) media.dataset.healseen = '1'
    }
  }, 3000)
}
function stopHealWatch() { if (_healTimer) { clearInterval(_healTimer); _healTimer = null } }

// ---------------------------------------------------------------- i18n

const L = {
  zh: {
    title: 'Wallpaper Engine 聊天背景', count: n => `${n} 张壁纸`,
    current: t => '当前：' + t, clear: '清除',
    loading: '正在加载壁纸库…', empty: '没有可用的壁纸。请确认 Wallpaper Engine 已安装且工坊里有壁纸。',
    opacity: '壁纸不透明度', blur: '模糊', dim: '暗化', brightness: '亮度', panel: '面板不透明度', blurDim: '失焦暗化', fadeMs: '切换过渡',
    composerAlpha: '输入框不透明度', timelineAlpha: '悬浮窗',
    fitLabel: '对齐方式', fitCover: '覆盖', fitContain: '填充', fitCenter: '居中', fitFill: '拉伸', fitFree: '自由', fitTile: '平铺',
    posLabel: '位置', scaleLabel: '缩放',
    typeAll: '全部类型', typeVideo: '视频', typeScene: '图片',
    ratingAll: '全部分级', ratingEveryone: '所有人', ratingUnrated: '未分级', ratingMature: '成人',
    filter: '筛选', upload: '上传壁纸', srcAll: '全部来源', srcUploads: '本地上传', srcWE: '壁纸库',
    delTip: '删除此上传壁纸', delConfirm: '再点一次确认删除', delDone: '已删除', delFail: '删除失败: ',
    hudUploaded: '上传成功，正在壁纸库中定位…',
    hudLocated: 'Hermes 已定位到上传后的壁纸位置，即将显示壁纸所在目录…',
    hudOpened: '已在资源管理器中打开壁纸所在目录',
    hudNotAuto: '未自动更换当前壁纸 — 点击高亮的卡片即可应用',
    hudOpenFail: '无法打开资源管理器，壁纸保存在：',
    uploaded: '已上传', uploadFail: '上传失败: ',
    reloadHint: '壁纸选择页没有打开？重启一次 Hermes 即可恢复（启用插件后的已知时序问题）。',
    reloadHintLoading: '壁纸页加载卡住了（后端没响应）——重启一次 Hermes 即可恢复。',
  },
  en: {
    title: 'Wallpaper Engine Backdrop', count: n => `${n} wallpapers`,
    current: t => 'Current: ' + t, clear: 'Clear',
    loading: 'Loading Wallpaper Engine library…', empty: 'No playable wallpapers found.',
    opacity: 'Opacity', blur: 'Blur', dim: 'Dim', brightness: 'Brightness', panel: 'Panel opacity', blurDim: 'Blur-dim', fadeMs: 'Transition speed',
    composerAlpha: 'Composer opacity', timelineAlpha: 'Floating windows',
    fitLabel: 'Alignment', fitCover: 'Cover', fitContain: 'Fill', fitCenter: 'Center', fitFill: 'Stretch', fitFree: 'Free', fitTile: 'Tile',
    posLabel: 'Position', scaleLabel: 'Scale',
    typeAll: 'All types', typeVideo: 'Video', typeScene: 'Image',
    ratingAll: 'All ratings', ratingEveryone: 'Everyone', ratingUnrated: 'Unrated', ratingMature: 'Mature',
    filter: 'Filter', upload: 'Upload', srcAll: 'All sources', srcUploads: 'Local uploads', srcWE: 'Wallpaper library',
    delTip: 'Delete this upload', delConfirm: 'Click again to confirm', delDone: 'Deleted', delFail: 'Delete failed: ',
    hudUploaded: 'Uploaded — locating it in the library…',
    hudLocated: 'Located the uploaded wallpaper — opening its folder…',
    hudOpened: 'Folder opened in your file manager',
    hudNotAuto: 'Your current wallpaper was NOT changed — click the highlighted card to apply',
    hudOpenFail: 'Could not open the folder. Saved at: ',
    uploaded: 'Uploaded', uploadFail: 'Upload failed: ',
    reloadHint: "The wallpaper page didn't open — restarting Hermes once fixes it (known enable-timing issue).",
    reloadHintLoading: 'The wallpaper page is stuck loading (backend not responding) — restarting Hermes fixes it.',
  },
  ja: {
    title: 'Wallpaper Engine チャット背景', count: n => `${n} 枚の壁紙`,
    current: t => '現在：' + t, clear: 'クリア',
    loading: '壁紙ライブラリを読み込み中…', empty: '利用可能な壁紙がありません。Wallpaper Engine がインストール済みでワークショップに壁紙があるか確認してください。',
    opacity: '壁紙の不透明度', blur: 'ぼかし', dim: '暗さ', brightness: '明るさ', panel: 'パネルの不透明度', blurDim: '非アクティブ減光', fadeMs: '切替速度',
    composerAlpha: '入力欄不透明度', timelineAlpha: 'フローティングウィンドウ',
    fitLabel: '配置', fitCover: 'カバー', fitContain: 'フィット', fitCenter: '中央', fitFill: '引き伸ばし', fitFree: 'フリー', fitTile: 'タイル',
    posLabel: '位置', scaleLabel: 'サイズ',
    typeAll: 'すべてのタイプ', typeVideo: '動画', typeScene: '画像',
    ratingAll: 'すべてのレーティング', ratingEveryone: '全ユーザー', ratingUnrated: '未評価', ratingMature: '成人向け',
    filter: 'フィルター', upload: 'アップロード', srcAll: 'すべての来源', srcUploads: 'ローカル追加', srcWE: '壁紙ライブラリ',
    delTip: 'この壁紙を削除', delConfirm: 'もう一度クリックで確定', delDone: '削除しました', delFail: '削除失敗: ',
    hudUploaded: 'アップロード成功 — ライブラリを検索中…',
    hudLocated: 'アップロードした壁紙を見つけました — 保存フォルダを開きます…',
    hudOpened: '保存フォルダをファイルマネージャーで開きました',
    hudNotAuto: '現在の壁紙は変更されていません — ハイライトされたカードをクリックで適用',
    hudOpenFail: 'フォルダを開けませんでした。保存先：',
    uploaded: 'アップロード済み', uploadFail: 'アップロード失敗: ',
    reloadHint: '壁紙ページが開かない場合、Hermes を再起動すると解消します（有効化直後の既知のタイミング問題）。',
    reloadHintLoading: '壁紙ページが読み込み中で止まっています（バックエンド無応答）— Hermes を再起動すると解消します。',
  },
  ko: {
    title: 'Wallpaper Engine 채팅 배경', count: n => `배경 ${n}개`,
    current: t => '현재: ' + t, clear: '지우기',
    loading: '배경 라이브러리 불러오는 중…', empty: '사용 가능한 배경이 없습니다. Wallpaper Engine이 설치되어 있고 워크숍에 배경이 있는지 확인하세요.',
    opacity: '배경 불투명도', blur: '흐림', dim: '어둡게', brightness: '밝기', panel: '패널 불투명도', blurDim: '비활성 어둡게', fadeMs: '전환 속도',
    composerAlpha: '입력창 불투명도', timelineAlpha: '플로팅 창',
    fitLabel: '정렬', fitCover: '커버', fitContain: '맞춤', fitCenter: '가운데', fitFill: '늘리기', fitFree: '자유', fitTile: '타일',
    posLabel: '위치', scaleLabel: '크기',
    typeAll: '전체 유형', typeVideo: '동영상', typeScene: '이미지',
    ratingAll: '전체 등급', ratingEveryone: '전체 이용가', ratingUnrated: '미분류', ratingMature: '성인용',
    filter: '필터', upload: '업로드', srcAll: '전체 소스', srcUploads: '로컬 업로드', srcWE: '벽지 라이브러리',
    delTip: '이 벽지 삭제', delConfirm: '한 번 더 클릭하면 삭제', delDone: '삭제됨', delFail: '삭제 실패: ',
    hudUploaded: '업로드 성공 — 라이브러리에서 찾는 중…',
    hudLocated: '업로드한 벽지를 찾았습니다 — 보관 폴더를 엽니다…',
    hudOpened: '파일 탐색기에서 보관 폴더를 열었습니다',
    hudNotAuto: '현재 벽지는 변경되지 않았습니다 — 강조된 카드를 클릭하면 적용됩니다',
    hudOpenFail: '폴더를 열 수 없습니다. 저장 위치: ',
    uploaded: '업로드됨', uploadFail: '업로드 실패: ',
    reloadHint: '배경 페이지가 열리지 않으면 Hermes를 다시 시작하세요(활성화 직후의 알려진 문제).',
    reloadHintLoading: '배경 페이지 로딩이 멈췄습니다(백엔드 무응답) — Hermes를 다시 시작하면 해결됩니다.',
  },
}
const LANGS = ['zh', 'en', 'ja', 'ko']            // 简体中文默认，其次 en/ja/ko
const LANG_NATIVE = { zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어' }
let _lang = null
function currentLang() {
  if (_lang) return _lang
  try { _lang = _ctx?.storage.get('lang') || 'zh' } catch { _lang = 'zh' }
  return _lang
}
function setLang(l) {
  _lang = l
  try { _ctx?.storage.set('lang', l) } catch { /* non-fatal */ }
  listeners.forEach(fn => fn(getSettings()))
}
const t = key => { const d = L[currentLang()] || L.zh; return d[key] ?? L.en[key] ?? key }

// ---------------------------------------------------------------- theme-following palette

// Light/dark palettes, chosen by useTheme().renderedMode (what's on screen).
// Panels stay >= 90% opaque with backdrop blur in both modes — wallpaper
// bleed never sets text contrast. FLICKER FIX: palettes are pure functions of
// the theme value (no state writes, no DOM churn) so theme/session switches
// re-render in place without the backdrop layer being torn down or rebuilt.
function paletteFor(mode, panelOpacity) {
  const dark = mode !== 'light'
  const a = Math.min(Math.max(panelOpacity ?? 85, 0), 100) / 100
  const S = dark
    ? { panel: '22,22,24', panelSoft: '30,30,34', card: '24,24,28', cardSel: '30,38,60', btn: '60,60,66' }
    : { panel: '252,252,252', panelSoft: '244,244,248', card: '255,255,255', cardSel: '228,238,255', btn: '210,210,215' }
  const border = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)'
  return {
    text: dark ? '#f2f2f2' : '#1c1c1e',
    textMuted: dark ? '#c9c9c9' : '#48484a',
    textFaint: dark ? '#9a9a9a' : '#8e8e93',
    panel: `rgba(${S.panel},${a})`,
    panelSoft: `rgba(${S.panelSoft},${Math.max(a - 0.04, 0.02)})`,
    card: `rgba(${S.card},${Math.max(a - 0.08, 0.02)})`,
    cardSel: `rgba(${S.cardSel},${Math.max(a - 0.04, 0.04)})`,
    border,
    btnBg: `rgba(${S.btn},${Math.max(a - 0.02, 0.02)})`,
    shadow: dark ? '0 2px 10px rgba(0,0,0,0.45)' : '0 2px 10px rgba(0,0,0,0.12)',
    accent: dark ? '#4a84fe' : '#0053fd',
    thumbBg: dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)',
    trackBg: dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)',
  }
}

const S = {
  page: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 16px 8px', height: '100%', minHeight: 0, fontSize: '14px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 },
  h2: { fontSize: '16px', fontWeight: 600, margin: 0 },
  filterRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flexShrink: 0, padding: '9px 12px', borderRadius: '10px', position: 'relative', zIndex: 5 },
  filterLabel: { fontSize: '12px', fontWeight: 500 },
  currentBar: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px', flexShrink: 0 },
  btn: { padding: '5px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 500 },
  gridWrap: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: '6px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '12px' },
  card: sel => ({
    borderRadius: '10px', padding: '8px', textAlign: 'left', cursor: 'pointer',
    boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
  }),
  thumbBox: { width: '100%', aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: '6px', marginBottom: '6px' },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  title: { fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  meta: { fontSize: '10px' },
  controlPanel: {
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '12px 14px', borderRadius: '12px', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  sliderRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  sliderLabel: { width: '96px', fontSize: '13px', fontWeight: 500 },
  sliderVal: { width: '56px', textAlign: 'right', fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  panelGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '22px', alignItems: 'start' },
  colStack: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  // "当前：壁纸名" capsule — sits right of the alignment dropdown, fixed
  // compact width so a long title never shoves the other controls around.
  pill: { display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '260px', padding: '5px 6px 5px 12px', borderRadius: '8px', fontSize: '13px', lineHeight: '1.5', overflow: 'hidden', flexShrink: 0 },
  pillName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
  pillX: { width: '18px', height: '18px', borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', lineHeight: '1', padding: 0 },
}

function buildStyles(P) {
  const frost = { backdropFilter: 'blur(18px) saturate(1.15)', WebkitBackdropFilter: 'blur(18px) saturate(1.15)', border: `1px solid ${P.border}` }
  return {
    page: { ...S.page, color: P.text },
    header: S.header,
    h2: { ...S.h2, color: P.text },
    muted: { ...S.muted, color: P.textMuted },
    filterRow: { ...S.filterRow, ...P && { background: P.panel }, ...frost },
    filterLabel: { ...S.filterLabel, color: P.textMuted },
    currentBar: { ...S.currentBar, background: P.panel, ...frost },
    btn: { ...S.btn, background: P.btnBg, color: P.text, border: frost.border },
    gridWrap: S.gridWrap,
    grid: S.grid,
    card: sel => ({
      ...S.card(sel),
      border: sel ? `2px solid ${P.accent}` : P.border,
      background: sel ? P.cardSel : P.card,
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      color: P.text,
    }),
    thumbBox: { ...S.thumbBox, background: P.trackBg },
    thumbImg: S.thumbImg,
    title: { ...S.title, color: P.text },
    meta: { ...S.meta, color: P.textMuted },
    controlPanel: { ...S.controlPanel, background: P.panel, ...frost },
    sliderRow: S.sliderRow,
    sliderLabel: { ...S.sliderLabel, color: P.text },
    sliderVal: { ...S.sliderVal, color: P.text },
    panelGrid: S.panelGrid,
    colStack: S.colStack,
    fitRows: { display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '6px', marginBottom: '2px', borderBottom: `1px solid ${P.border}` },
    pill: { ...S.pill, background: P.cardSel, border: `1px solid ${P.border}`, color: P.text },
    pillName: S.pillName,
    pillX: { ...S.pillX, background: P.btnBg, color: P.text },
  }
}

// Custom dropdown (native <select> replaced): rounded, animated open/close,
// panel-following background, fully i18n-able options.
function Dropdown({ P, value, options, onChange, title, maxWidth, minWidth }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!open) return
    // Mount animation once per open (a callback ref would re-run on every
    // re-render of the picker while the menu stays open).
    if (menuRef.current && typeof menuRef.current.animate === 'function') {
      menuRef.current.animate(
        [{ opacity: 0, transform: 'translateY(-5px) scale(0.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
        { duration: 170, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
      )
    }
    const onDoc = e => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const cur = options.find(o => o.value === value)
  return jsxs('span', { ref: rootRef, style: { position: 'relative', display: 'inline-block', flexShrink: 0 }, children: [
    jsxs('button', {
      type: 'button', title, className: 'wpe-dd-btn',
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between',
        minWidth: minWidth || '92px', maxWidth: maxWidth || '170px',
        padding: '5px 10px 5px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
        cursor: 'pointer', background: P.panelSoft, color: P.text, border: `1px solid ${P.border}`,
        transition: 'background 140ms ease, border-color 140ms ease',
      },
      onClick: () => setOpen(o => !o),
      children: [
        // 标签占位也钉住同一宽度：文字 1/2/3/4 字切换时按钮宽度全程恒定
        jsx('span', { style: { minWidth: '6ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: cur ? cur.label : '—' }),
        jsx('span', {
          style: { fontSize: '9px', marginLeft: '7px', flexShrink: 0, display: 'inline-block', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 160ms ease' },
          children: '▾',
        }),
      ],
    }),
    open ? jsx('div', {
      ref: menuRef,
      style: {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0,
        minWidth: '100%', width: 'max-content',
        background: P.panel, border: `1px solid ${P.border}`, borderRadius: '12px',
        boxShadow: P.shadow, padding: '5px', zIndex: 60,
        '--wpe-hover': P.cardSel,
        backdropFilter: 'blur(18px) saturate(1.15)', WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
      },
      children: options.map(o => jsxs('button', {
        type: 'button', className: 'wpe-dd-item',
        style: {
          display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
          gap: '14px', padding: '7px 12px', fontSize: '13px', borderRadius: '8px', border: 'none',
          cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap', color: P.text,
          background: o.value === value ? P.cardSel : 'transparent',
          fontWeight: o.value === value ? 600 : 400,
        },
        onClick: () => { setOpen(false); onChange(o.value) },
        children: [
          jsx('span', { children: o.label }),
          o.value === value ? jsx('span', { style: { color: P.accent, fontSize: '12px' }, children: '✓' }) : null,
        ],
      })),
    }) : null,
  ] })
}

function WallpaperPicker({ mode }) {
  const inv = useInventory()
  const pv = usePreviews()
  const s = useSettings()
  // Filters live in the persisted settings (user: 重启后要记得上次选的分级/类型)
  const typeFilter = s.typeFilter || 'all'
  const ratingFilter = s.ratingFilter || 'all'
  const srcFilter = s.srcFilter || 'all'
  const setTypeFilter = v => setSettings({ ...s, typeFilter: v })
  const setRatingFilter = v => setSettings({ ...s, ratingFilter: v })
  const [page, setPage] = useState(1)
  const sentinelRef = useRef(null)

  // ALL hooks before any conditional return (React #310 invariant).
  useEffect(() => { if (!inv.loaded) reloadInventory() }, [inv.loaded])
  useEffect(() => { setPage(1) }, [typeFilter, ratingFilter])

  const filtered = inv.wallpapers
    .filter(w => !s.hidden.includes(w.id))
    // 来源档：本地上传单独成类（便于管理）；『壁纸库』= WE 工坊/自制项目
    .filter(w => srcFilter === 'all' || (srcFilter === 'uploads' ? w.source === 'uploads' : w.source !== 'uploads'))
    // "图片"档的值是 scene（WE 场景纹理），但它必须同时收录上传的图片
    // （type=image）——否则上传的图永远藏在"图片"筛选外面（定位也找不到它）
    .filter(w => typeFilter === 'all' || w.type === typeFilter
      || (typeFilter === 'scene' && w.type === 'image'))
    .filter(w => ratingFilter === 'all' || w.contentrating.toLowerCase() === ratingFilter)
    .filter(w => w.type !== 'web')
  const items = filtered.slice(0, page * PAGE_SIZE)
  const hasMore = filtered.length > items.length

  useEffect(() => {
    // 首批拉齐整页（PAGE_SIZE=28）：曾写死 24，首屏尾部 4 张要等下一次
    // effect 触发才出图，进来总有几个角是空卡。
    if (inv.loaded) loadPreviews(items.slice(0, PAGE_SIZE).map(w => w.id))
  }, [typeFilter, ratingFilter, inv.loaded, page])

  // Auto-locate (user request): entering the page jumps to the CURRENTLY
  // SELECTED wallpaper — page forward so it exists in the grid, then scroll
  // it centered. Runs once per mount; later manual browsing is untouched.
  const locatedRef = useRef(false)
  useEffect(() => {
    if (!inv.loaded || !s.wallpaperId || locatedRef.current) return
    const idx = filtered.findIndex(w => w.id === s.wallpaperId)
    if (idx === -1) return
    locatedRef.current = true
    const neededPage = Math.floor(idx / PAGE_SIZE) + 1
    if (neededPage > page) setPage(neededPage)
    setTimeout(() => {
      const el = document.querySelector(`div[data-slot="wallpaper-gridwrap"] [data-wid="${CSS.escape(s.wallpaperId)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
  }, [inv.loaded, s.wallpaperId, page, filtered.length])

  // 上传后定位：库存刷新完成后，找到新上传的条目 → 若被当前筛选遮蔽就先把
  // 筛选放开（类型归位、分级重置），翻到它所在页，平滑滚动 + 高亮闪两下。
  // 与挂载定位共用滚动方式，但独立触发、可反复（每次上传都跳）。
  useEffect(() => {
    if (!inv.loaded || !_justUploaded) return
    const stem = _justUploaded.name.replace(/\.[^.]+$/, '')
    const slug = 'upload-' + stem.toLowerCase().replace(/ /g, '-').slice(0, 40)
    let w = inv.wallpapers.find(x => x.id === slug) ||
            inv.wallpapers.find(x => x.title === stem)
    if (!w) return  // 库存还没刷出来（reload 在途），等下一次 inv 变更
    // 被隐藏列表遮蔽 → 先解除并保留待跳转标记，等下一次渲染（filtered 更新后）再进本 effect
    if (s.hidden.includes(w.id)) {
      setSettings({ ...s, hidden: s.hidden.filter(x => x !== w.id) })
      return
    }
    const savedPath = _justUploaded.path
    _justUploaded = null
    // 被筛选遮蔽 → 放开到能看见它的组合（图片归"图片"档、视频归"视频"档）
    const tNeeded = w.type === 'video' ? 'video' : (w.type === 'image' ? 'scene' : typeFilter)
    if (typeFilter !== 'all' && typeFilter !== tNeeded) setTypeFilter(tNeeded)
    if (ratingFilter !== 'all' && ratingFilter !== 'unrated') setRatingFilter('all')
    const idx = filtered.findIndex(x => x.id === w.id)
    if (idx >= 0) setPage(p => Math.max(p, Math.floor(idx / PAGE_SIZE) + 1))
    const hud = _hud
    _hud = null
    setTimeout(() => {
      const el = document.querySelector(`div[data-slot="wallpaper-gridwrap"] [data-wid="${CSS.escape(w.id)}"]`)
      if (!el) { hud?.finish(t('uploaded') + ': ' + w.title, savedPath, 'warn'); return }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      // HUD 第②段：定位完成，预告即将打开所在目录
      hud?.update(t('hudLocated'), w.title)
      // 第③段：revealPath 走结果化桥（只回 true/false，不抛异常）。false 时把
      // 落盘路径直接显示出来——用户照样能找到文件，比静默失败诚实。
      const settle = ok => ok
        ? hud?.finish(t('hudOpened'), t('hudNotAuto'))
        : hud?.finish(t('hudOpenFail'), savedPath || w.title, 'warn')
      try {
        const pr = savedPath ? _ctx.os?.revealPath?.(savedPath) : null
        if (pr && pr.then) pr.then(settle, () => settle(false)); else settle(!!pr)
      } catch { settle(false) }
      // 高亮闪动用 Web Animations API：不依赖注入样式表，动画结束自动还原，
      // 中途改选/滚动也不会留下脏样式
      try {
        el.animate([
          { boxShadow: '0 0 0 0 rgba(0,0,0,0)' },
          { boxShadow: `0 0 0 3px ${P.accent || '#4b8dff'}`, outline: '2px solid rgba(75,141,255,0.9)' },
          { boxShadow: '0 0 0 0 rgba(0,0,0,0)', outline: '2px solid rgba(75,141,255,0)' },
          { boxShadow: `0 0 0 3px ${P.accent || '#4b8dff'}`, outline: '2px solid rgba(75,141,255,0.9)' },
          { boxShadow: '0 0 0 0 rgba(0,0,0,0)', outline: '2px solid rgba(75,141,255,0)' },
        ], { duration: 1400, easing: 'ease-in-out' })
      } catch { /* 老内核不支持 WAAPI：滚动已到位即可，闪动属锦上添花 */ }
    }, 200)
  }, [inv.loaded, inv.wallpapers, filtered.length, page])

  // Infinite scroll: sentinel enters viewport -> next page
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const obs = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setPage(p => p + 1)
    }, { rootMargin: '600px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, page, items.length])

  // 删除上传壁纸后的收口：刷新清单；删的若正是当前壁纸，清空选择
  // （文件已不存在，留在设置里只会让看门狗反复重建失败）
  const afterDelete = w => {
    if (s.wallpaperId === w.id) {
      const n = { ...s, wallpaperId: '', wallpaperTitle: '', mediaPath: '', previewPath: '', type: '' }
      setSettings(n)
    }
    reloadInventory()
    host.notify({ kind: 'info', message: t('delDone') + ': ' + w.title })
  }

  const P = paletteFor(mode, s.panelOpacity)
  const St = buildStyles(P)

  if (!inv.loaded) {
    return jsx('div', { style: St.page, children: t('loading') })
  }
  if (!inv.count) {
    return jsx('div', { style: St.page, children: t('empty') })
  }

  return jsxs('div', { style: St.page, children: [
    jsx(LoadingSentinel, {}),
    jsxs('div', { style: St.header, children: [
      jsx('h2', { style: St.h2, children: t('title') }),
      jsx('span', { style: St.muted, children: t('count')(items.length) }),
    ] }),

    // Layout (user-agreed): fixed controls on the left, the volatile
    // "current wallpaper" capsule right of alignment, elastic space, then
    // language + upload on the far right.
    jsxs('div', { style: St.filterRow, children: [
      jsx('span', { style: St.filterLabel, children: t('filter') }),
      jsx(Dropdown, {
        P, value: typeFilter, onChange: setTypeFilter,
        options: [
          { value: 'all', label: t('typeAll') },
          { value: 'video', label: t('typeVideo') },
          { value: 'scene', label: t('typeScene') },
        ],
      }),
      jsx(Dropdown, {
        P, value: srcFilter, title: t('srcAll'),
        onChange: v => setSettings({ ...s, srcFilter: v }),
        options: [
          { value: 'all', label: t('srcAll') },
          { value: 'uploads', label: t('srcUploads') },
          { value: 'library', label: t('srcWE') },
        ],
      }),
      jsx(Dropdown, {
        P, value: ratingFilter, onChange: setRatingFilter,
        options: [
          { value: 'all', label: t('ratingAll') },
          { value: 'everyone', label: t('ratingEveryone') },
          { value: 'unrated', label: t('ratingUnrated') },
          { value: 'mature', label: t('ratingMature') },
        ],
      }),
      jsx(Dropdown, {
        P, value: s.fit || 'cover', title: t('fitLabel'),
        onChange: v => setSettings({ ...s, fit: v }),
        options: [
          { value: 'cover', label: t('fitCover') },
          { value: 'contain', label: t('fitContain') },
          { value: 'center', label: t('fitCenter') },
          { value: 'fill', label: t('fitFill') },
          { value: 'free', label: t('fitFree') },
          { value: 'tile', label: t('fitTile') },
        ],
      }),
      s.wallpaperId ? jsxs('span', { style: St.pill, children: [
        jsx('span', { style: St.pillName, title: s.wallpaperTitle || s.wallpaperId, children: t('current')(s.wallpaperTitle || s.wallpaperId) }),
        jsx('button', {
          type: 'button', style: St.pillX, title: t('clear'),
          onClick: () => setSettings({ ...s, wallpaperId: '', type: '', mediaPath: '', previewPath: '', wallpaperTitle: '' }),
          children: '✕',
        }),
      ] }) : null,
      jsx('span', { style: { flex: 1 } }),
      jsx(Dropdown, {
        P, value: currentLang(), title: 'Language / 语言 / 言語 / 언어',
        onChange: l => setLang(l),
        options: LANGS.map(l => ({ value: l, label: LANG_NATIVE[l] })),
      }),
      jsx('button', {
        style: St.btn, type: 'button',
        onClick: () => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm'
          input.onchange = () => {
            const f = input.files && input.files[0]
            if (!f || !_ctx) return
            // 上传协议（踩坑定稿）：桌面桥的 multipart 通道只认结构化字段
            // { filename, contentType, bytes }，bytes 必须是 ArrayBuffer——
            // 直接把 <input> 的 File 对象扔进 IPC 会丢内容，主进程
            // Buffer.from(undefined) 抛 ERR_INVALID_ARG_TYPE（用户截图的报错）。
            f.arrayBuffer().then(bytes => _ctx.rest('/upload', {
              method: 'POST',
              upload: { filename: f.name, contentType: f.type || 'application/octet-stream', bytes },
              timeoutMs: 120000,
            })).then(r => {
              if (!r?.ok) { host.notify({ kind: 'error', message: t('uploadFail') + (r?.detail || 'unknown') }); return }
              // HUD 第①段：上传成功即挂"定位中"。落盘路径也进 HUD 副标题，
              // 用户当场知道文件保存到哪（复制式存储，源文件可随意删）。
              // ②③段由下方 locate-upload effect 接续（已定位 → 打开所在目录）。
              _justUploaded = { name: r.name, path: r.path || '' }
              _hud = hudShow(paletteFor(mode, Math.max(s.panelOpacity ?? 0, 86)), t('hudUploaded'), r.name)
              reloadInventory()
            }).catch(err => host.notify({ kind: 'error', message: t('uploadFail') + String(err) }))
          }
          input.click()
        },
        children: t('upload'),
      }),
    ] }),

    jsx('div', {
      style: St.gridWrap,
      'data-slot': 'wallpaper-gridwrap',
      children: jsxs('div', { children: [
        jsx('div', { style: St.grid,
          children: items.map(w => jsx(WallpaperCard, { w, pv, s, St, loadPreviews, onDeleted: afterDelete })) }),
        hasMore ? jsx('div', { ref: sentinelRef, style: { height: '8px' } }) : null,
      ] }),
    }),

    jsxs('div', { style: St.controlPanel, children: [
      (s.fit === 'free' || s.fit === 'custom' || s.fit === 'contain') ? jsxs('div', { style: St.fitRows, children: [
        (s.fit === 'free' || s.fit === 'custom') ? jsx(SliderRow, { St, label: t('scaleLabel'), value: s.scale ?? 100, min: 50, max: 300, unit: '%',
          onChange: v => setSettings({ ...s, scale: v }) }) : null,
        (s.fit === 'free' || s.fit === 'custom' || s.fit === 'contain') ? jsx(SliderRow, { St, label: t('posLabel') + ' X', value: s.posX ?? 50, min: 0, max: 100, unit: '%',
          onChange: v => setSettings({ ...s, posX: v }) }) : null,
        (s.fit === 'free' || s.fit === 'custom' || s.fit === 'contain') ? jsx(SliderRow, { St, label: t('posLabel') + ' Y', value: s.posY ?? 50, min: 0, max: 100, unit: '%',
          onChange: v => setSettings({ ...s, posY: v }) }) : null,
      ] }) : null,
      jsxs('div', { style: St.panelGrid, children: [
        jsxs('div', { style: St.colStack, children: [
          jsx(SliderRow, { St, label: t('opacity'), value: s.opacity, min: 5, max: 100,
            onChange: v => setSettings({ ...s, opacity: v }) }),
          jsx(SliderRow, { St, label: t('panel'), value: s.panelOpacity, min: 0, max: 100, unit: '%',
            onChange: v => setSettings({ ...s, panelOpacity: v }) }),
          jsx(SliderRow, { St, label: t('composerAlpha'), value: s.composerAlpha ?? 45, min: 0, max: 100, unit: '%',
            onChange: v => setSettings({ ...s, composerAlpha: v }) }),
          jsx(SliderRow, { St, label: t('timelineAlpha'), value: s.timelineAlpha ?? 55, min: 0, max: 100, unit: '%',
            onChange: v => setSettings({ ...s, timelineAlpha: v }) }),
        ] }),
        jsxs('div', { style: St.colStack, children: [
          jsx(SliderRow, { St, label: t('blur'), value: s.blur, min: 0, max: 30, unit: 'px',
            onChange: v => setSettings({ ...s, blur: v }) }),
          jsx(SliderRow, { St, label: t('dim'), value: s.dim, min: 0, max: 80, unit: '%',
            onChange: v => setSettings({ ...s, dim: v }) }),
          jsx(SliderRow, { St, label: t('blurDim'), value: s.blurDim ?? 0, min: 0, max: 60, unit: '%',
            onChange: v => setSettings({ ...s, blurDim: v }) }),
          jsx(SliderRow, { St, label: t('fadeMs'), value: s.fadeMs ?? 400, min: 100, max: 1200, unit: 'ms',
            onChange: v => setSettings({ ...s, fadeMs: v }) }),
          jsx(SliderRow, { St, label: t('brightness'), value: s.brightness, min: 40, max: 160, unit: '%',
            onChange: v => setSettings({ ...s, brightness: v }) }),
        ] }),
      ] }),
    ] }),

  ] })
}

function P_text(St) { return St.sliderVal.color }

let scrollbarStyled = false
function ensureStyles() {
  if (scrollbarStyled || typeof document === 'undefined') return
  let st = document.getElementById('wpe-bubble-style')
  if (!st) {
    st = document.createElement('style')
    st.id = 'wpe-bubble-style'
    document.head.appendChild(st)
  }
  st.textContent = `
    div[data-slot="wallpaper-gridwrap"]::-webkit-scrollbar { width: 10px; }
    div[data-slot="wallpaper-gridwrap"]::-webkit-scrollbar-track {
      background: rgba(127,127,127,0.10); border-radius: 5px; }
    div[data-slot="wallpaper-gridwrap"]::-webkit-scrollbar-thumb {
      background: rgba(127,127,127,0.38); border-radius: 5px; }
    div[data-slot="wallpaper-gridwrap"]::-webkit-scrollbar-thumb:hover {
      background: rgba(127,127,127,0.55); }
    .wpe-dd-btn { transition: filter 140ms ease; }
    .wpe-dd-btn:hover { filter: brightness(1.07); }
    .wpe-dd-item {
      transition: background 130ms ease, transform 130ms ease, filter 130ms ease;
    }
    .wpe-dd-item:hover { background: var(--wpe-hover); transform: translateX(3px); }
    .wpe-dd-item:active { filter: brightness(0.95); transform: translateX(3px) scale(0.99); }
  `
  document.head.appendChild(st)
  scrollbarStyled = true
}

// ---------------------------------------------------------------- chat de-white (frost)
// User (2026-09-11): kill the full-width mask strip behind a user message
// (fully transparent now — no film left), add frosted blur to the bubbles
// (fill opacity stays with the BUILT-IN Settings > Appearance lever so the
// two never fight), and one user-adjustable lever for the input composer
// (composerAlpha, 0..100) which core has no control for.
// All rules are scoped to :root[data-hermes-glass] so opaque themes are
// untouched; the sticky ROW's solid slab (core paints it via
// --ui-chat-surface-background, re-opaquet under glass by [data-glass-opaque])
// is dropped to a faint frost so it stops reading as pure white. Rewritten on
// every settings change; removed entirely on deactivate/dispose.
let bubbleStyleEl = null

function frostCss(compA, tlA) {
  const c = Math.min(Math.max(compA ?? 45, 0), 100)
  const tl = Math.min(Math.max(tlA ?? 55, 0), 100)
  const tlTrack = Math.max(tl - 25, 8)  // 开关轨道保持比面板厚一点，滑到0时圆点才有落点
  const menuA = Math.max(tl, 92)      // 选项菜单地板：列表盖在页面文字上，低于92%必叠字（用户2026-09-13定稿）
  return `
    /* Sticky user-message row: core paints an opaque mask strip behind the
       bubble (hides text sliding underneath). User wants it GONE — fully
       transparent, no fill, no blur; overlap-while-scrolling is the accepted
       trade. Its ::before gap-patch goes too. */
    :root[data-hermes-glass] [data-slot='aui_user-message-root'] {
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    :root[data-hermes-glass] [data-slot='aui_user-message-root']::before {
      background: transparent !important;
    }
    /* Bubble FILL belongs to the built-in Settings > Appearance > message-bubble
       lever (--user-bubble-keep -> --dt-user-bubble). Overriding the fill here
       made that lever dead (user-reported conflict) — so the plugin adds ONLY
       the frosted blur the lever lacks. No background rule on the bubble. */
    :root[data-hermes-glass] .composer-human-message {
      backdrop-filter: blur(4px) saturate(1.02) !important;
      -webkit-backdrop-filter: blur(4px) saturate(1.02) !important;
    }
    /* Assistant widget cards ("N files changed", clarify): frost + soften. */
    :root[data-hermes-glass] {
      --ui-widget-surface-background: color-mix(in srgb, var(--ui-bg-editor) 55%, transparent);
    }
    :root[data-hermes-glass] [data-slot='aui_assistant-message-content'] .rounded-3xl {
      backdrop-filter: blur(14px) saturate(1.15) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.15) !important;
    }
    /* Code blocks inside assistant replies (CodeCard paints --ui-bg-editor
       solid). Frosted so the wallpaper reads through like the user bubble. */
    /* 弹出浮层家族（对话框/下拉菜单/选择菜单/滚动时间线悬停窗）：核心同一规则
       画死 96% elevated 底。一根滑条统一驱动 alpha；核心自带 backdrop 模糊保留。
       键名沿用 timelineAlpha（持久化兼容），语义已扩为"全部浮层"。 */
    /* 底部状态栏（网关/缓存命中率/GPU 等信息条，用户 2026-09-13 定稿）：
       归"输入框不透明度"滑条管（窗口底部上下贴邻，浓度一致读起来才是一体），
       滑条指哪打哪无地板——浓度用户自己定。12px 磨砂与文字提亮只是质感
       补偿，不改变滑条设定的浓度。 */
    [data-slot='statusbar'] {
      background-color: color-mix(in srgb, var(--dt-card) ${c}%, transparent) !important;
      backdrop-filter: blur(12px) saturate(1.1);
      -webkit-backdrop-filter: blur(12px) saturate(1.1);
    }

    /* 通知 toast 堆栈（host.notify 弹出的卡片，用户 2026-09-12 收编）：核心
       STACK_SURFACE 用 bg-popover/95 类上色，该类全应用唯 notifications.tsx
       在用（grep 验证）——class 子串选择器精确锚定，不碰页面内 Alert 横幅。
       核心自带 backdrop-blur-md，透明后保持磨砂。 */
    :root[data-hermes-glass] div[class*='bg-popover/95'] {
      background-color: color-mix(in srgb, var(--ui-bg-elevated) ${tl}%, transparent) !important;
    }

    /* 会话翻页时的"滚动到底部/↓N 新消息"胶囊（.thread-jump-button）：核心用
       --composer-fill 上色（跟着输入框滑条偷偷走，用户 2026-09-12 才发现它）。
       显式收编进悬浮窗家族，语义归位。 */
    :root[data-hermes-glass] .thread-jump-button {
      background: color-mix(in srgb, var(--ui-bg-elevated) ${tl}%, transparent) !important;
    }
    /* 悬浮窗家族拆两档（用户 2026-09-13 定稿：设置里展开的下拉选项列表透出
       下层文字，没法看）：
       ①纯装饰浮层（时间线小窗/对话框/命令面板）——跟随滑条直驱；
       ②选项菜单（dropdown/select/context-menu/popover——都是"列表盖在页面
         文字上"的形态）——最低 92% 不透明地板，滑条只在 92~100 区间微调。
         searchable-select（设置页模型/分级下拉=Popover+Command）落在
         popover-content 上。 */
    :root[data-hermes-glass] [data-slot='thread-timeline-popover'],
    :root[data-hermes-glass] [data-slot='dialog-content'],
    :root[data-hermes-glass] [role='dialog'][aria-modal='true'] {
      background: color-mix(in srgb, var(--ui-bg-elevated) ${tl}%, transparent) !important;
    }
    :root[data-hermes-glass] [data-slot='dropdown-menu-content'],
    :root[data-hermes-glass] [data-slot='select-content'],
    :root[data-hermes-glass] [data-slot='context-menu-content'],
    :root[data-hermes-glass] [data-slot='popover-content'] {
      background: color-mix(in srgb, var(--ui-bg-elevated) ${menuA}%, transparent) !important;
    }
    /* 命令面板核心没给 backdrop 模糊（其他浮层都有），补上保持家族一致 */
    :root[data-hermes-glass] [role='dialog'][aria-modal='true'] {
      backdrop-filter: blur(12px) saturate(1.1);
      -webkit-backdrop-filter: blur(12px) saturate(1.1);
    }
    /* 设置页这类大浮层卡片（OverlayView，核心标 data-glass-raised）：核心在
       raised 上下文里把 --ui-chat-surface-background 强制 max(94%, keep)——
       正是"设置框完全不透"的源头。这里以更高特异度覆写该变量为滑条驱动，
       并补 backdrop 模糊（raised 卡片核心没给 blur，透明后不糊会显脏）。 */
    :root[data-hermes-glass] [data-glass-raised] {
      --ui-chat-surface-background: color-mix(in srgb, var(--ui-bg-chrome) ${tl}%, transparent) !important;
    }
    :root[data-hermes-glass] div[data-glass-raised] {
      backdrop-filter: blur(16px) saturate(1.15);
      -webkit-backdrop-filter: blur(16px) saturate(1.15);
    }
    /* 浮层卡内部还藏着一圈"近实心小表面"（用户 2026-09-12 点名：设置页左侧
       导航栏、顶部搜索胶囊、开关等）：
       - --ui-sidebar-surface-background：核心在 raised 里强制 max(94%)——左导航
         栏的白底就是它；覆写成滑条驱动。
       - --ui-bg-tertiary：分段控件轨道 + 导航选中芯片的灰底，降 62% 让它透。
       - [data-glass-opaque] 规则声明"覆盖自身兄弟节点的表面必须实心"（搜索胶囊
         自带此标记），在 raised 后代范围内把它拉回滑条值——作用域锁死在浮层卡
         内部，聊天区拖拽行等其它 opaque 用户不受牵连。
       - switch 轨道：核心的 dt-background 混合无 data 标记，按 slot 单独薄化。 */
    :root[data-hermes-glass] [data-glass-raised] {
      --ui-sidebar-surface-background: color-mix(in srgb, var(--ui-bg-sidebar) ${tl}%, transparent) !important;
      --ui-bg-tertiary: color-mix(in srgb, var(--ui-bg-tertiary) 62%, transparent) !important;
    }
    :root[data-hermes-glass] [data-glass-raised] [data-glass-opaque] {
      --ui-chat-surface-background: color-mix(in srgb, var(--ui-bg-chrome) ${tl}%, transparent) !important;
      --ui-bg-chrome: color-mix(in srgb, var(--ui-bg-chrome) ${tl}%, transparent);
      backdrop-filter: blur(12px) saturate(1.1);
      -webkit-backdrop-filter: blur(12px) saturate(1.1);
    }
    :root[data-hermes-glass] [data-glass-raised] [data-slot='switch'] {
      background-color: color-mix(in srgb, var(--dt-background) ${tlTrack}%, transparent) !important;
    }
    :root[data-hermes-glass] [data-slot='code-card'] {
      background: color-mix(in srgb, var(--ui-bg-editor) 50%, transparent) !important;
      backdrop-filter: blur(14px) saturate(1.15) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.15) !important;
    }
    /* Pane tabs (SESSIONS/BOTS and every zone tab): core paints each with
       --glass-field, i.e. the body field mix — which tracks the global
       transparency setting, so at low intensity it reads as an opaque grey
       chip that no wallpaper shows through. Frosted fill instead. */
    /* Linear pricing-tab pattern (awesome-design-md/linear.app): pill chips,
       sheer idle fill, selection carried by an accent wash + the core's blue
       underline — not by fill weight. margin-block floats the pill off the
       strip; the hairline separators between full-height tabs are dropped
       (they read as cracks between chips). */
    /* Top-only radius (8px, not the too-round pill): the selected tab's accent
   underline is an inset BOTTOM shadow — a bottom curve clips it (user: 下方不用弧度).
   Sheen is all-inner (outer shadows die in the strip's overflow clip): a top
   highlight hairline + accent glow on the selected chip. background+box-shadow
   at 200ms ease-out = when aria-selected flips, the old chip's wash & underline
   fade out while the new one's fade in (user: 丝滑渐变切换). The underline is
   re-declared here because the !important box-shadow would otherwise override
   the core's inset-underline; margin-bottom 0 keeps the chip flush with the
   strip bottom so the underline sits on the seam. */
    :root[data-hermes-glass] [data-tree-tab] {
      background: color-mix(in srgb, var(--ui-bg-sidebar) calc((var(--wpe-panel-a, 0.85) - 0.65) * 100%), transparent) !important;
      backdrop-filter: blur(12px) saturate(1.15) !important;
      -webkit-backdrop-filter: blur(12px) saturate(1.15) !important;
      border-radius: 8px 8px 0 0 !important;
      border-color: transparent !important;
      margin-block: 3px 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05) !important;
      transition: background 200ms ease-out, box-shadow 200ms ease-out;
    }
    :root[data-hermes-glass] [data-tree-tab]:hover:not([aria-selected='true']) {
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), inset 0 0 14px rgba(255,255,255,0.05) !important;
    }
    :root[data-hermes-glass] [data-tree-tab][aria-selected='true'] {
      background: color-mix(in srgb, var(--ui-accent) 16%, color-mix(in srgb, var(--ui-bg-sidebar) calc((var(--wpe-panel-a, 0.85) - 0.55) * 100%), transparent)) !important;
      box-shadow:
        inset 0 -2px 0 var(--pane-tab-active-accent, var(--theme-primary)),
        inset 0 1px 0 rgba(255,255,255,0.18),
        inset 0 8px 14px -8px color-mix(in srgb, var(--ui-accent) 45%, transparent) !important;
    }
    /* The strip BEHIND the tabs (PaneTabStrip): sheer frost so the chips
       read as raised above the bar. CSS needs a literal backslash before the
       slash (JS eats a single one in the template string). */
    :root[data-hermes-glass] .group\\/pane-header {
      background: color-mix(in srgb, var(--ui-bg-sidebar) calc((var(--wpe-panel-a, 0.85) - 0.6) * 100%), transparent) !important;
    }
    /* Terminal: DO NOT touch --ui-terminal-surface-background. It feeds
       resolveSurfaceColor() -> the xterm WebGL theme background; a translucent
       value corrupts the opaque canvas fast-path (blank ghost pane, user
       report 2026-09-11 — reverted same day). Terminal body stays opaque BY
       DESIGN; only its DOM chrome above (tabs) is frosted. */
    /* The input composer has no built-in lever — slider drives its fill. */
    :root[data-hermes-glass] [data-slot='composer-root'] {
      --composer-fill: color-mix(in srgb, var(--dt-card) ${c}%, transparent) !important;
    }
    /* 输入框上方停靠的排队/状态栈卡片：核心只在 composer-root 子树内声明
       --composer-fill，而这块栈是输入框的【兄弟】——它回落到 :root 兜底值
       （90% 卡片色，近实心），所以输入框滑条一直管不到它（用户 2026-09-12 报
       "排队面板不透"）。这里按输入框同值再声明：核心本就把两者设计成"共享
       一个填充、融合成一枚胶囊"（上下两张卡同值才不裂），故跟输入框滑条走，
       而非悬浮窗滑条。 */
    :root[data-hermes-glass] [data-slot='composer-status-stack'] {
      --composer-fill: color-mix(in srgb, var(--dt-card) ${c}%, transparent) !important;
    }
  `
}

function applyFrostStyle(s) {
  if (typeof document === 'undefined') return
  // Panel alpha as a root var so chrome we don't own (pane tabs/strips) can
  // ride the same 面板不透明度 slider instead of a hardcoded number.
  const a = Math.min(Math.max(s.panelOpacity ?? 85, 0), 100) / 100
  document.documentElement.style.setProperty('--wpe-panel-a', String(a))
  // Adopt the previous instance's element on hot reload — never stack.
  if (!bubbleStyleEl) bubbleStyleEl = document.getElementById('wpe-user-bubble-style')
  if (!bubbleStyleEl) {
    bubbleStyleEl = document.createElement('style')
    bubbleStyleEl.id = 'wpe-user-bubble-style'
    document.head.appendChild(bubbleStyleEl)
  }
  bubbleStyleEl.textContent = frostCss(s.composerAlpha, s.timelineAlpha)
  // 注入指纹：验证运行中的 App 加载了哪一版插件样式（改版后看这行就知道
  // 热重载有没有生效）。规则标记 WPE_BUILD 递增即新版。
  try {
    const css = bubbleStyleEl.textContent
    const marks = ['pane-tab-close-width) + 10px', 'translateY(1px)', 'thread-jump-button', 'bg-popover/95']
    console.info('[WPE] frost ' + css.length + 'ch build20260913b marks=' +
      marks.map(m => css.includes(m) ? 1 : 0).join(''))
  } catch { /* 纯诊断，不影响功能 */ }
}

function removeBubbleStyle() {
  if (bubbleStyleEl) { bubbleStyleEl.remove(); bubbleStyleEl = null }
  if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--wpe-panel-a')
  _hud = null
  hudDismiss()  // 停用/卸载时清掉可能还挂着的上传 HUD
}

// ---- 上传进度 HUD（Raycast 命令面板式悬浮条；参考 E:\9.PersonalProjects
// 的 awesome-design-md/raycast：near-black 磨砂 + 发丝边 + 内高光 + 圆角 14）----
// 为什么需要：上传后用户普遍以为壁纸已自动换上（真实误报）。HUD 三段推进：
// ①定位中(转圈) ②已定位(转圈+文案) ③收口(对勾=已打开所在目录 / 感叹号=打不开时
// 直接显示路径)，副标题始终说明"未自动更换当前壁纸"。alpha 强制 ≥86 保可读；
// 入场退场全走 WAAPI，不新增注入样式表，卸载/关闭即移除。
let _hudEl = null
let _hudHideTimer = null

function hudDismiss() {
  if (_hudHideTimer) { clearTimeout(_hudHideTimer); _hudHideTimer = null }
  const el = _hudEl
  _hudEl = null
  if (!el) return
  try {
    el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%,10px) scale(.98)' }],
      { duration: 240, easing: 'ease-in', fill: 'forwards' })
    setTimeout(() => el.remove(), 600)
  } catch { el.remove() }
}

function hudShow(P, title, sub) {
  hudDismiss()
  if (typeof document === 'undefined') return { update() {}, done() {} }
  const el = document.createElement('div')
  el.setAttribute('data-wpe-hud', '')
  el.style.cssText =
    'position:fixed;left:50%;bottom:88px;z-index:2147483000;display:flex;align-items:center;' +
    'gap:12px;padding:12px 16px;border-radius:14px;max-width:min(560px,86vw);pointer-events:none;' +
    `background:${P.panel};backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);` +
    `border:1px solid ${P.border};box-shadow:0 18px 48px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.10);` +
    `color:${P.text};font:13.5px/1.45 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;` +
    'opacity:0;transform:translate(-50%,14px) scale(.97)'
  const glyph = document.createElement('div')
  glyph.style.cssText = 'flex:none;width:18px;height:18px;border-radius:50%;border:2px solid rgba(127,127,127,.35);' +
    `border-top-color:${P.accent}`
  try { glyph.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity }) } catch {}
  const box = document.createElement('div')
  box.style.cssText = 'min-width:0;flex:1'
  const tEl = document.createElement('div')
  tEl.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  tEl.textContent = title
  const sEl = document.createElement('div')
  sEl.style.cssText = `font-size:11.5px;color:${P.textFaint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
  sEl.textContent = sub || ''
  box.appendChild(tEl); box.appendChild(sEl)
  el.appendChild(glyph); el.appendChild(box)
  document.body.appendChild(el)
  try {
    el.animate([{ opacity: 0, transform: 'translate(-50%,14px) scale(.97)' },
      { opacity: 1, transform: 'translate(-50%,0) scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
  } catch { el.style.opacity = '1'; el.style.transform = 'translate(-50%,0)' }
  _hudEl = el
  // 防卡死：10 秒无人推进就强制失败收口（弱网/后端没回时不永远转圈）
  let guard = setTimeout(() => api.finish('✕', '', 'warn'), 10000)
  const api = {
    update(nt, ns) { clearTimeout(guard); guard = setTimeout(() => api.finish('✕', '', 'warn'), 10000); tEl.textContent = nt; if (ns !== undefined) sEl.textContent = ns },
    finish(ft, fs, kind) {
      clearTimeout(guard)
      if (_hudEl !== el) return
      const ok = kind !== 'warn'
      glyph.style.cssText = 'flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;' +
        `justify-content:center;font-size:11px;font-weight:700;color:#fff;background:${ok ? P.accent : '#e0564b'}`
      glyph.textContent = ok ? '✓' : '!'
      tEl.textContent = ft
      if (fs !== undefined) sEl.textContent = fs
      _hudHideTimer = setTimeout(hudDismiss, 4600)
    },
  }
  return api
}

function WallpaperCard({ w, pv, s, St, loadPreviews: load, onDeleted }) {
  const selected = w.id === s.wallpaperId
  const thumb = pv[w.id]
  // 两段式删除（不用 window.confirm：Electron 渲染进程里它卡交互、反馈也丑）：
  // 第一次点 ✕ 变红并提示"再点一次确认"，2.5 秒内再点才真删；过点自动回退。
  const [armed, setArmed] = useState(0)
  useEffect(() => {
    if (!armed) return
    const to = setTimeout(() => setArmed(0), 2500)
    return () => clearTimeout(to)
  }, [armed])
  const doDelete = e => {
    e.stopPropagation()
    if (!armed) { setArmed(Date.now()); return }
    // 只传 id：路径解析与"必须在 uploads 目录内"的校验全在后端做（清单
    // 投影本就剥掉路径字段，前端压根不该知道文件在哪）
    _ctx.rest('/upload/delete', { method: 'POST', body: { id: w.id } })
      .then(() => onDeleted && onDeleted(w))
      .catch(err => host.notify({ kind: 'error', message: t('delFail') + String(err) }))
  }
  return jsx('button', {
    type: 'button',
    'data-wid': w.id,
    style: St.card(selected),
    onClick: () => {
      if (w.type === 'web' || !_ctx) return
      _ctx.rest('/resolve', { method: 'POST', body: { id: w.id } }).then(r => {
        if (!r.ok) { host.notify({ kind: 'error', message: 'Resolve failed: ' + r.error }); return }
        setSettings({
          ...s,
          wallpaperId: w.id, wallpaperTitle: w.title, type: r.type,
          mediaPath: r.type === 'video' ? r.path : '',
          previewPath: r.type === 'video' ? '' : r.path,
        })
        host.notify({ kind: 'info', message: 'Backdrop: ' + w.title })
      }).catch(err => host.notify({ kind: 'error', message: String(err) }))
    },
    onMouseEnter: () => {
      if (!thumb) load([w.id])
      prefetchWallpaper(w)
    },
    children: jsxs('div', { children: [
      jsx('div', { style: St.thumbBox, children: thumb
        ? jsx('img', { src: thumb, style: St.thumbImg, alt: w.title })
        : jsx('div', { style: { ...St.thumbBox, marginBottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: P_text(St) }, children: w.title.slice(0, 24) }) }),
      jsx('div', { style: St.title, children: w.title }),
      jsxs('div', { style: St.meta, children: [
        `${w.type === 'video' ? t('typeVideo') : w.type === 'scene' ? t('typeScene') : w.type} · ${w.contentrating}`,
        w.source === 'uploads' ? jsx('span', {
          style: { float: 'right', cursor: 'pointer', fontWeight: 700, marginLeft: '6px',
                   color: armed ? '#ff5b4e' : 'rgba(127,127,127,0.6)' },
          title: armed ? t('delConfirm') : t('delTip'),
          onClick: doDelete,
          children: armed ? t('delConfirm') : '✕',
        }) : null,
      ] }),
    ] }),
  })
}

function SliderRow({ St, label, value, min, max, unit = '', onChange }) {
  return jsxs('label', { style: St.sliderRow, children: [
    jsx('span', { style: St.sliderLabel, children: label }),
    jsx('input', {
      type: 'range', min, max, value,
      onChange: e => onChange(Number(e.target.value)),
      style: { flex: 1, accentColor: '#4a84fe', height: '4px', cursor: 'pointer' },
    }),
    jsx('span', { style: St.sliderVal, children: value + unit }),
  ] })
}

// ---------------------------------------------------------------- register

export default {
  id: ID,
  name: 'Wallpaper Engine Backdrop',
  register(ctx) {
    _ctx = ctx
    ctx.i18n.register({
      en: { pickerTitle: 'Wallpaper Engine Backdrop' },
      zh: { pickerTitle: 'Wallpaper Engine 聊天背景' },
    })

    ctx.register({
      id: 'picker-page',
      area: 'routes',
      data: { path: '/wallpaper-engine' },
      render: () => { ensureStyles(); return jsx(ThemeAwarePicker, {}) },
    })
    ctx.register({
      id: 'picker-nav',
      area: 'sidebar.nav',
      data: { path: '/wallpaper-engine', label: 'Wallpaper Engine', codicon: 'symbol-color' },
    })
    // ⌘K / command palette door: if the sidebar row's click misses the page
    // (enable-timing race the app-side still has), the palette command is a
    // second independent entry point.
    ctx.register({
      id: 'picker-open',
      area: PALETTE_AREA,
      data: {
        id: 'open-picker',
        label: 'Wallpaper Engine 壁纸选择页 / Open picker',
        keywords: ['wallpaper', '壁纸', '背景', 'backdrop'],
        run: () => host.navigate('/wallpaper-engine'),
      },
    })

    listeners.add(scheduleApply)
    applyBackdrop(getSettings())
    startHealWatch()
    listeners.add(applyFrostStyle)
    applyFrostStyle(getSettings())
    reloadInventory()
    const stopWatchdog = watchPageOpen()

    // Focus dim compensation: deepen the dim layer while the window is
    // inactive (DWM paints inactive acrylic brighter — plugin cannot touch
    // DWM, so it counteracts on its own layer).
    const onBlur = () => { _windowBlurred = true; refreshDim() }
    const onFocus = () => { _windowBlurred = false; refreshDim(); if (backdropVideo) backdropVideo.play().catch(() => {}) }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    // Register the backdrop-layer cleanup as a ctx disposer too, so the
    // framework's own teardown path (not just deactivate) removes the layer.
    ctx.onDispose(() => {
      stopHealWatch()
      listeners.delete(scheduleApply)
      listeners.delete(applyFrostStyle)
      if (stopWatchdog) stopWatchdog()
      removeBubbleStyle()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      if (backdropEl) { backdropEl.remove(); backdropEl = null; backdropVideo = null }
      if (typeof document !== 'undefined') {
        document.querySelectorAll('div[data-slot="wallpaper-backdrop"]').forEach(el => el.remove())
      }
    })
  },
  deactivate() {
    stopHealWatch()
    listeners.delete(scheduleApply)
    listeners.delete(applyFrostStyle)
    removeBubbleStyle()
    if (backdropEl) { backdropEl.remove(); backdropEl = null; backdropVideo = null }
    if (typeof document !== 'undefined') {
      document.querySelectorAll('div[data-slot="wallpaper-backdrop"]').forEach(el => el.remove())
    }
  },
}

// Wrapper so useTheme (a context hook) runs OUTSIDE the early-return paths of
// the picker. renderedMode = what the app actually painted (luminance-derived),
// which is exactly "Hermes 是亮色就是亮色，是暗色就是暗色".
function ThemeAwarePicker() {
  const theme = useTheme()
  const mode = theme?.renderedMode === 'light' ? 'light' : 'dark'
  useEffect(() => { _pickerMounted = true }, [])
  // 缩略图后台预热（用户：每次进页面都要等图加载）：首次进页面触发一次
  // 全量磁盘预热——预热完成后所有缩略图走磁盘缓存，秒开。
  useEffect(() => {
    if (_warmSent || !_ctx) return
    _warmSent = true
    _ctx.rest('/inventory/previews/warm', { method: 'POST' }).catch(() => {})
  }, [])
  return jsx(WallpaperPicker, { mode })
}

// Mark "loaded" once the inventory actually arrives (or definitively fails) —
// the loading-stuck watchdog clears against this.
function LoadingSentinel() {
  const inv = useInventory()
  useEffect(() => {
    if (inv.loaded) _pickerLoaded = true
  }, [inv.loaded])
  return null
}

// ---------------------------------------------------------------- open-watchdog
// Known app-side race (newer desktop builds): enabling the plugin shows the
// sidebar row, but clicking it sometimes doesn't mount the page until the
// next app restart. The plugin can't fix the app's route table, so it does
// the next best thing: detect "user asked for the page, page never mounted"
// and TELL them the one-step fix (restart) instead of leaving a dead click.
// Variant: the page mounts but hangs on the loading line (backend didn't
// answer) — same fix, different message so the user isn't told to fiddle
// with Wallpaper Engine settings that aren't the problem.
let _pickerMounted = false
let _pickerLoaded = false
let _reloadHintShown = false

function watchPageOpen() {
  if (typeof window === 'undefined') return
  const check = () => {
    if (_reloadHintShown) return
    if (_pickerMounted) {
      // Page shell mounted but the picker never got past the loading state?
      if (_pickerLoaded) return
      _reloadHintShown = true
      host.notify({ kind: 'warning', message: t('reloadHintLoading') })
      return
    }
    _reloadHintShown = true
    host.notify({ kind: 'warning', message: t('reloadHint') })
  }
  const onHash = () => {
    if (!window.location.hash.includes('wallpaper-engine')) return
    _pickerMounted = false
    _pickerLoaded = false
    setTimeout(check, 1500)
  }
  window.addEventListener('hashchange', onHash)
  // Booted directly onto the route (no hashchange fires): check once.
  if (window.location.hash.includes('wallpaper-engine')) setTimeout(check, 2500)
  return () => window.removeEventListener('hashchange', onHash)
}
