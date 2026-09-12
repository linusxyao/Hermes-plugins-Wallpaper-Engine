/**
 * Hermes 壁纸引擎聊天背景 — 桌面端 UI 插件（渲染进程内运行的纯 ESM 单文件）。
 *
 * 运行时硬性约束（全部是踩坑验证过的）：
 *  - 只允许 import `@hermes/plugin-sdk` 和 `react` 两个裸模块，其余解析全部失败。
 *  - 插件代码不经过应用的 Tailwind 构建，className 里写 Tailwind 工具类是死代码。
 *    所有样式一律内联 style 对象（:hover 等伪类见 ensureStyles 注入的样式表）。
 *  - pluginRest 没有按次的 profile 参数（只有模块级 _apiProfile）。因此 Python
 *    后端必须放在 root plugins 目录（被所有 profile 的 serve 扫描挂载）。
 *  - Hooks 顺序不变式：WallpaperPicker 有提前 return 的分支，所有 hooks 必须在
 *    任何 return 之前执行完毕（否则 React #310）。
 *  - 热重载会让上一代壁纸层成为孤儿 DOM——applyBackdrop 负责认领/清扫。
 *
 * 主题跟随：配色由 useTheme().renderedMode 跟随 Hermes 当前外观（亮随亮暗随暗）；
 * 调色板是主题值的纯函数（不写 state、不动 DOM），切主题/会话原地重渲染防闪烁。
 * 两种主题下面板都保持高不透明度 + 磨砂，壁纸明暗不干扰文字对比度。
 *
 * 核心功能地图：
 *  applyBackdrop  — 壁纸层渲染（视频/图片双通道、交叉淡入、六种对齐方式）
 *  scheduleApply  — rAF 节流：滑条拖动不引发滤镜重建风暴（防变白闪烁）
 *  Dropdown       — 自绘下拉框（替代原生 select，开合动效 + 国际化选项）
 *  frostCss       — 聊天区去白/磨砂样式表（由面板/输入框/时间线滑条驱动）
 *  watchPageOpen  — 页面打开看门狗（启用时序竞争时弹"重启"提示）
 *  startHealWatch — 3 秒自愈看门狗（壁纸意外丢失自动重建）
 *  L 常量         — 中/英/日/韩四语词典，语言选择持久化
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
    composerAlpha: 45, blurDim: 0, timelineAlpha: 55,
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

// 悬停预热（换壁纸提速的关键一环）：用户还没点击，就提前发起 resolve 并把图片
// dataURI 拉进缓存。视频走 Range 流式播放本身很快，只有图片需要抢这个时间差。
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

// 热重载安全：每次重载都生成全新模块实例，其 backdropEl 为 null。
// 必须先认领页面已存在的壁纸层、清扫多余孤儿层——绝不允许两层壁纸叠加显示。
function reclaimBackdropLayers() {
  const existing = document.querySelectorAll(`div[data-slot="${BACKDROP_SLOT}"]`)
  if (existing.length === 0) return null
  const adopted = existing[0]
  for (let i = 1; i < existing.length; i++) existing[i].remove()
  backdropEl = adopted
  backdropVideo = adopted.querySelector('video') || null
  return adopted
}

// 图片壁纸的加载通道：hermes-media:// 协议只流式支持音视频（不支持 jpg/png），
// 网关图片路由又没法让裸 <img> 携带会话鉴权头。因此图片统一走插件自己的 /media
// 接口取 base64 dataURI（路径经扫描器白名单校验，ctx.rest 自带鉴权头）再赋给
// <img>。视频保持走 hermes-media://stream（支持 Range 断点的音视频流播）。
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

// 失焦明暗：DWM 会把失焦窗口的亚克力底衬提亮，观感就是"点了别的窗口壁纸变亮"。
// 这里跟踪窗口焦点，失焦期间按 blurDim 设定值给暗化层加码（见下方 dimColor）。
let _windowBlurred = false
let _lastDimPct = 25

// blurDim（用户滑条，默认 0）：失焦时暗化层额外加深的黑色百分比。
// 这里曾硬编码 0.18 补偿 DWM 失焦提亮——低透明度设置下补偿过度，
// 失焦反而整窗变暗（用户报告）。现默认关闭，需要补偿的用户自行拉滑条。
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

// 对齐方式（与 Wallpaper Engine 官方对齐方式一一对应）：覆盖 cover /
// 填充 contain / 拉伸 fill / 平铺 tile / 居中 center(原始尺寸) /
// 自由 free(缩放+位置；历史存档值 custom 与之等价)。
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

// 换对齐方式必须先清空上一模式专属的样式属性——Object.assign 只合并不清除
// （用户报：乱切几种对齐再切回"覆盖"后壁纸消失——平铺摘掉了 img 的 src，
// 自由模式的 transform:scale 又残留，两种情况都会让图层空白或错位）。
function setMediaFitStyle(el, st) {
  el.style.transform = ''
  el.style.transformOrigin = ''
  el.style.backgroundImage = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundSize = ''
  Object.assign(el.style, mediaStyleFor(st))
}

// 拖滑条每个刻度都发一次设置事件；每次都重建壁纸层的 blur/brightness 滤镜
// 会迫使 Chromium 对整层重新光栅化，两次绘制之间可能闪出窗口底色
// （用户报"调参时变白闪烁"）。用 requestAnimationFrame 合并成每帧最多应用一次。
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
      // 交叉淡入：旧视频保持显示直到新视频真正开播——绝不先清空图层
      // （"先清空再加载"正是当年"半天才换"中间那段空白的来源）。
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
        backdropEl.querySelectorAll('video').forEach(x => { if (x !== v) x.remove() })
        backdropEl.querySelectorAll('img').forEach(x => x.remove())
        backdropVideo = v
        setDim(_lastDimPct)  // re-stack the dim overlay ABOVE the new media
      }
      v.addEventListener('playing', reveal, { once: true })
      // 流媒体偶发卡顿、以及 Chromium 对遮挡窗口的省电节流，会让循环静音视频
      // 停在暂停态无人接管（用户报"动态壁纸不动了"）。
      // 只要不是我们主动移除（isConnected 检查），暂停即自动续播。
      v.addEventListener('stalled', () => { if (v.isConnected) v.play().catch(() => {}) })
      v.addEventListener('pause', () => { if (v.isConnected) v.play().catch(() => {}) })
      // 万一 'playing' 事件始终不来（流卡顿/自动播放策略抖动），图层会永远停在
      // opacity:0——没有旧视频在场时首帧数据到达即揭示；4 秒后无条件强制揭示
      // （看到一帧画面也比空窗强）。
      v.addEventListener('loadeddata', () => { if (!old && v.style.opacity !== '1') reveal() }, { once: true })
      setTimeout(() => { if (v.isConnected && v.style.opacity !== '1') reveal() }, 4000)
    } else {
      // Live-update fit on an existing video without reloading it.
      if (useTile) Object.assign(backdropVideo.style, { width: '100%', height: '100%', objectFit: 'cover' })
      else setMediaFitStyle(backdropVideo, s)
    }
    if (backdropVideo) backdropVideo.play?.().catch(() => {})
  } else {
    // 图片壁纸：先取 dataURI（带鉴权）再上屏。异步但幂等——
    // 同一路径重复调用全部命中缓存。
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
          // 平铺模式摘掉了 src（它靠 backgroundImage 上色）——切出平铺必须装回，
          // 否则样式清除后 img 没有可渲染的源。
          if (!same.getAttribute('src')) same.src = dataUrl
        }
        return
      }
      // 交叉淡入：新图以隐藏态插入、盖在旧图上淡入，完成后才移除旧图。
      // 新图真正可解码前旧壁纸始终可见——不再有"加载中露出底色"的空窗。
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
        backdropEl.querySelectorAll('img').forEach(x => { if (x !== el) x.remove() })
        backdropEl.querySelectorAll('video').forEach(x => x.remove())
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

// 自愈看门狗：设置里有壁纸但图层丢了媒体（卡在隐藏态/被热重载孤立/被竞争弄丢）
// ——3 秒内自动重建。兜住所有想不到的丢失路径。
let _healTimer = null
function startHealWatch() {
  if (_healTimer || typeof window === 'undefined') return
  _healTimer = setInterval(() => {
    const st = getSettings()
    if (!st.wallpaperId || (!st.mediaPath && !st.previewPath)) return
    const media = backdropEl && backdropEl.isConnected && backdropEl.querySelector('img,video')
    if (!media) { applyBackdrop(st); return }
    if (media.style.opacity === '0' && (media.tagName === 'IMG' || media.readyState >= 2)) {
      media.style.opacity = '1'
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
    opacity: '壁纸不透明度', blur: '模糊', dim: '暗化', brightness: '亮度', panel: '面板不透明度', blurDim: '失焦暗化',
    composerAlpha: '输入框不透明度', timelineAlpha: '时间线浮窗',
    fitLabel: '对齐方式', fitCover: '覆盖', fitContain: '填充', fitCenter: '居中', fitFill: '拉伸', fitFree: '自由', fitTile: '平铺',
    posLabel: '位置', scaleLabel: '缩放',
    typeAll: '全部类型', typeVideo: '视频', typeScene: '图片',
    ratingAll: '全部分级', ratingEveryone: '所有人', ratingUnrated: '未分级', ratingMature: '成人',
    filter: '筛选', upload: '上传壁纸', uploaded: '已上传', uploadFail: '上传失败: ',
    reloadHint: '壁纸选择页没有打开？重启一次 Hermes 即可恢复（启用插件后的已知时序问题）。',
    reloadHintLoading: '壁纸页加载卡住了（后端没响应）——重启一次 Hermes 即可恢复。',
  },
  en: {
    title: 'Wallpaper Engine Backdrop', count: n => `${n} wallpapers`,
    current: t => 'Current: ' + t, clear: 'Clear',
    loading: 'Loading Wallpaper Engine library…', empty: 'No playable wallpapers found.',
    opacity: 'Opacity', blur: 'Blur', dim: 'Dim', brightness: 'Brightness', panel: 'Panel opacity', blurDim: 'Blur-dim',
    composerAlpha: 'Composer opacity', timelineAlpha: 'Timeline popup',
    fitLabel: 'Alignment', fitCover: 'Cover', fitContain: 'Fill', fitCenter: 'Center', fitFill: 'Stretch', fitFree: 'Free', fitTile: 'Tile',
    posLabel: 'Position', scaleLabel: 'Scale',
    typeAll: 'All types', typeVideo: 'Video', typeScene: 'Image',
    ratingAll: 'All ratings', ratingEveryone: 'Everyone', ratingUnrated: 'Unrated', ratingMature: 'Mature',
    filter: 'Filter', upload: 'Upload', uploaded: 'Uploaded', uploadFail: 'Upload failed: ',
    reloadHint: "The wallpaper page didn't open — restarting Hermes once fixes it (known enable-timing issue).",
    reloadHintLoading: 'The wallpaper page is stuck loading (backend not responding) — restarting Hermes fixes it.',
  },
  ja: {
    title: 'Wallpaper Engine チャット背景', count: n => `${n} 枚の壁紙`,
    current: t => '現在：' + t, clear: 'クリア',
    loading: '壁紙ライブラリを読み込み中…', empty: '利用可能な壁紙がありません。Wallpaper Engine がインストール済みでワークショップに壁紙があるか確認してください。',
    opacity: '壁紙の不透明度', blur: 'ぼかし', dim: '暗さ', brightness: '明るさ', panel: 'パネルの不透明度', blurDim: '非アクティブ減光',
    composerAlpha: '入力欄不透明度', timelineAlpha: 'タイムライン',
    fitLabel: '配置', fitCover: 'カバー', fitContain: 'フィット', fitCenter: '中央', fitFill: '引き伸ばし', fitFree: 'フリー', fitTile: 'タイル',
    posLabel: '位置', scaleLabel: 'サイズ',
    typeAll: 'すべてのタイプ', typeVideo: '動画', typeScene: '画像',
    ratingAll: 'すべてのレーティング', ratingEveryone: '全ユーザー', ratingUnrated: '未評価', ratingMature: '成人向け',
    filter: 'フィルター', upload: 'アップロード', uploaded: 'アップロード済み', uploadFail: 'アップロード失敗: ',
    reloadHint: '壁紙ページが開かない場合、Hermes を再起動すると解消します（有効化直後の既知のタイミング問題）。',
    reloadHintLoading: '壁紙ページが読み込み中で止まっています（バックエンド無応答）— Hermes を再起動すると解消します。',
  },
  ko: {
    title: 'Wallpaper Engine 채팅 배경', count: n => `배경 ${n}개`,
    current: t => '현재: ' + t, clear: '지우기',
    loading: '배경 라이브러리 불러오는 중…', empty: '사용 가능한 배경이 없습니다. Wallpaper Engine이 설치되어 있고 워크숍에 배경이 있는지 확인하세요.',
    opacity: '배경 불투명도', blur: '흐림', dim: '어둡게', brightness: '밝기', panel: '패널 불투명도', blurDim: '비활성 어둡게',
    composerAlpha: '입력창 불투명도', timelineAlpha: '타임라인',
    fitLabel: '정렬', fitCover: '커버', fitContain: '맞춤', fitCenter: '가운데', fitFill: '늘리기', fitFree: '자유', fitTile: '타일',
    posLabel: '위치', scaleLabel: '크기',
    typeAll: '전체 유형', typeVideo: '동영상', typeScene: '이미지',
    ratingAll: '전체 등급', ratingEveryone: '전체 이용가', ratingUnrated: '미분류', ratingMature: '성인용',
    filter: '필터', upload: '업로드', uploaded: '업로드됨', uploadFail: '업로드 실패: ',
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

// 亮/暗两套调色板，由 useTheme().renderedMode（屏幕实际呈现的模式）选定。
// 两种下面板都保持高不透明度 + backdrop 模糊，壁纸永远不会干扰文字对比度。
// 防闪烁设计：调色板是主题值的纯函数（不写 state、不动 DOM），切换主题/会话
// 时原地重渲染，壁纸层绝不拆毁重建。
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
  // "当前：壁纸名" 胶囊——排在对齐下拉右侧，宽度有上限固定，
  // 再长的壁纸名也绝不会把旁边的控件挤走。
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

// 自绘下拉框（替代原生 <select>）：圆角、开合动效、配色随面板不透明度联动，
// 选项文字完全可国际化。
function Dropdown({ P, value, options, onChange, title, maxWidth }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!open) return
    // 每次展开只播一次入场动画（用 callback ref 会在菜单打开期间
    // 每次组件重渲染都重放一遍）。
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
        display: 'inline-flex', alignItems: 'center', maxWidth: maxWidth || '170px',
        padding: '5px 10px 5px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
        cursor: 'pointer', background: P.panelSoft, color: P.text, border: `1px solid ${P.border}`,
        transition: 'background 140ms ease, border-color 140ms ease',
      },
      onClick: () => setOpen(o => !o),
      children: [
        jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: cur ? cur.label : '—' }),
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
  // 筛选状态存进持久化设置（用户要求：重启后记得上次选的类型/分级）
  const typeFilter = s.typeFilter || 'all'
  const ratingFilter = s.ratingFilter || 'all'
  const setTypeFilter = v => setSettings({ ...s, typeFilter: v })
  const setRatingFilter = v => setSettings({ ...s, ratingFilter: v })
  const [page, setPage] = useState(1)
  const sentinelRef = useRef(null)

  // ALL hooks before any conditional return (React #310 invariant).
  useEffect(() => { if (!inv.loaded) reloadInventory() }, [inv.loaded])
  useEffect(() => { setPage(1) }, [typeFilter, ratingFilter])

  const filtered = inv.wallpapers
    .filter(w => !s.hidden.includes(w.id))
    .filter(w => typeFilter === 'all' || w.type === typeFilter)
    .filter(w => ratingFilter === 'all' || w.contentrating.toLowerCase() === ratingFilter)
    .filter(w => w.type !== 'web')
  const items = filtered.slice(0, page * PAGE_SIZE)
  const hasMore = filtered.length > items.length

  useEffect(() => {
    if (inv.loaded) loadPreviews(items.slice(0, 24).map(w => w.id))
  }, [typeFilter, ratingFilter, inv.loaded, page])

  // 自动定位（用户要求）：进入页面即跳转到"当前选中"的壁纸——先按需翻页
  // 让它出现在网格里，再平滑滚动到视图中央。每次挂载只执行一次，
  // 之后用户手动浏览不受打扰。
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

    // 布局（与用户约定）：左侧控件位置固定；易变的"当前壁纸"胶囊排在对齐
    // 下拉之后；中间弹性空间；语言选择 + 上传永远钉在最右侧。
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
            _ctx.rest('/upload', {
              method: 'POST', upload: { file: f, name: f.name }, timeoutMs: 120000,
            }).then(r => {
              if (!r?.ok) { host.notify({ kind: 'error', message: t('uploadFail') + (r?.detail || 'unknown') }); return }
              host.notify({ kind: 'info', message: t('uploaded') + ': ' + r.name })
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
          children: items.map(w => jsx(WallpaperCard, { w, pv, s, St, loadPreviews })) }),
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

// ---------------------------------------------------------------- 聊天区去白/磨砂
// 需求（用户 2026-09-11）：去掉用户消息背后的全宽实心遮带（现在完全透明、
// 不留薄膜），给气泡补磨砂模糊（气泡填充透明度归内置"设置→外观→消息气泡"
// 滑条管，两者不冲突），再给输入框一根插件专属滑条（composerAlpha 0-100，
// 核心没有这项控制）。
// 所有规则都限定在 :root[data-hermes-glass] 作用域内——非玻璃主题零影响。
// 样式表随每次设置变更整表重写；插件停用/卸载时彻底移除，可完全还原。
let bubbleStyleEl = null

function frostCss(compA, tlA) {
  const c = Math.min(Math.max(compA ?? 45, 0), 100)
  const tl = Math.min(Math.max(tlA ?? 55, 0), 100)
  return `
    /* 用户消息的 sticky 整行：核心在它背后画了一条不透明遮带（滚动时遮挡穿行文字）。
           用户要求彻底去掉——完全透明、不填不糊；滚动时的文字重叠是接受的代价。
           行上方的 ::before 补缝板一并置透明。 */
    :root[data-hermes-glass] [data-slot='aui_user-message-root'] {
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    :root[data-hermes-glass] [data-slot='aui_user-message-root']::before {
      background: transparent !important;
    }
    /* 气泡填充色的所有权在内置"设置→外观→消息气泡"滑条（--user-bubble-keep）。
           插件曾覆盖它、导致内置滑条失效（用户报告的冲突）。终稿：插件绝不写气泡
           background，只补该滑条给不了的 backdrop 模糊。 */
    :root[data-hermes-glass] .composer-human-message {
      backdrop-filter: blur(18px) saturate(1.25) !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.25) !important;
    }
    /* 助手侧小组件卡片（"N 个文件已更改"、clarify 追问）：磨砂+降浓度。 */
    :root[data-hermes-glass] {
      --ui-widget-surface-background: color-mix(in srgb, var(--ui-bg-editor) 55%, transparent);
    }
    :root[data-hermes-glass] [data-slot='aui_assistant-message-content'] .rounded-3xl {
      backdrop-filter: blur(14px) saturate(1.15) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.15) !important;
    }
    /* 回复中的代码卡片（CodeCard 用 --ui-bg-editor 实心填充）。磨砂化，
           让壁纸像透过用户气泡一样透出来。 */
    /* 右侧滚动时间线的悬停浮窗（核心写死 96% 浮层色）。不透明度由滑条驱动，
           核心自带的背景模糊保留。 */
    :root[data-hermes-glass] [data-slot='thread-timeline-popover'] {
      background: color-mix(in srgb, var(--ui-bg-elevated) ${tl}%, transparent) !important;
    }
    :root[data-hermes-glass] [data-slot='code-card'] {
      background: color-mix(in srgb, var(--ui-bg-editor) 50%, transparent) !important;
      backdrop-filter: blur(14px) saturate(1.15) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.15) !important;
    }
    /* pane 标签（SESSIONS/BOTS/TERMINAL 等）：核心用 --glass-field（跟随全局
           透明度的底色混合）绘制——透明度调低时它反而是近实心的灰片，壁纸完全
           透不出。这里改成插件自己的磨砂填充。 */
    /* 参考 Linear 定价页标签范式（本地 awesome-design-md/linear.app）：
           空闲态极薄，选中态靠 accent 染色 + 核心蓝色下划线表达——不靠填充浓度差。
           margin-block 让芯片浮离标签条；去掉全高标签间的发丝分隔线。 */
    /* 只做上圆角（8px，太圆会像药丸）：选中态的 accent 下划线是贴底内阴影，
       下圆角会把它切掉（用户：下方不用弧度）。光泽全部走内阴影（外阴影会被标签条的
       overflow 裁掉）：顶部 1px 高光线 + 选中芯片的 accent 底部辉光。
       background 与 box-shadow 同为 200ms ease-out——aria-selected 翻转瞬间，
       旧芯片的染色/下划线淡出、新芯片淡入，实现用户要的丝滑渐变切换。 */
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
    /* 标签背后的整条栏（PaneTabStrip）：极薄的磨砂，让芯片有"浮在条上"的层次。
           注意 CSS 类名斜杠前要留一个字面反斜杠（模板字符串里必须双写）。 */
    :root[data-hermes-glass] .group\\/pane-header {
      background: color-mix(in srgb, var(--ui-bg-sidebar) calc((var(--wpe-panel-a, 0.85) - 0.6) * 100%), transparent) !important;
    }
    /* 【红线】终端：绝不覆写 --ui-terminal-surface-background！它会被
           resolveSurfaceColor() 读走、直接喂给 xterm 的 WebGL 主题背景色；给半透明值
           会毁掉不透明画布快路径（终端变透明空壳、无字无光标，2026-09-11 事故当天回滚）。
           终端正文保持实心是设计使然；只有它上方的 DOM 层（标签）可以碰。 */
    /* 输入框没有内置透明度控制——由插件滑条驱动其填充色。 */
    :root[data-hermes-glass] [data-slot='composer-root'] {
      --composer-fill: color-mix(in srgb, var(--dt-card) ${c}%, transparent) !important;
    }
  `
}

function applyFrostStyle(s) {
  if (typeof document === 'undefined') return
  // 把面板透明度发布为根 CSS 变量，让不归我们管的界面（pane 标签/标签条）
  // 也能挂在这根滑条上，而不是各写各的固定数。
  const a = Math.min(Math.max(s.panelOpacity ?? 85, 0), 100) / 100
  document.documentElement.style.setProperty('--wpe-panel-a', String(a))
  // 热重载时认领上一代实例的样式元素——绝不叠加两份样式表。
  if (!bubbleStyleEl) bubbleStyleEl = document.getElementById('wpe-user-bubble-style')
  if (!bubbleStyleEl) {
    bubbleStyleEl = document.createElement('style')
    bubbleStyleEl.id = 'wpe-user-bubble-style'
    document.head.appendChild(bubbleStyleEl)
  }
  bubbleStyleEl.textContent = frostCss(s.composerAlpha, s.timelineAlpha)
}

function removeBubbleStyle() {
  if (bubbleStyleEl) { bubbleStyleEl.remove(); bubbleStyleEl = null }
  if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--wpe-panel-a')
}

function WallpaperCard({ w, pv, s, St, loadPreviews: load }) {
  const selected = w.id === s.wallpaperId
  const thumb = pv[w.id]
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
      jsx('div', { style: St.meta, children: `${w.type === 'video' ? t('typeVideo') : w.type === 'scene' ? t('typeScene') : w.type} · ${w.contentrating}` }),
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
    // 命令面板（⌘K）第二入口：若侧栏行的点击因 app 侧启用时序竞争而没打开
    // 页面，面板里的直达命令是不依赖那条路径的备用入口。
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

    // 失焦补偿：窗口失焦期间加深暗化层（DWM 会提亮非活跃亚克力——插件碰不到
    // DWM，只能在自己的层上对冲）。
    const onBlur = () => { _windowBlurred = true; refreshDim() }
    const onFocus = () => { _windowBlurred = false; refreshDim(); if (backdropVideo) backdropVideo.play().catch(() => {}) }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    // 把壁纸层清理同时注册为 ctx 销毁器——让框架自己的卸载路径（而非只有
    // deactivate）也能移除图层，不留孤儿 DOM。
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

// 包装组件：让 useTheme（上下文 hook）运行在选页组件的提前 return 分支之外。
// renderedMode = 应用实际画出来的模式（按亮度推导），正是"Hermes 亮它就亮、
// 暗它就暗"。
function ThemeAwarePicker() {
  const theme = useTheme()
  const mode = theme?.renderedMode === 'light' ? 'light' : 'dark'
  useEffect(() => { _pickerMounted = true }, [])
  return jsx(WallpaperPicker, { mode })
}

// 库存真正到达（或明确失败）后标记 loaded——加载卡死看门狗以此判定是否豁免。
function LoadingSentinel() {
  const inv = useInventory()
  useEffect(() => {
    if (inv.loaded) _pickerLoaded = true
  }, [inv.loaded])
  return null
}

// ---------------------------------------------------------------- 页面打开看门狗
// 已知的应用侧时序竞争（较新的桌面版）：启用插件后侧栏入口会出现，但点击
// 有时要等下次重启才真正挂载页面。插件无法修复应用的路由表，退而求其次：
// 检测到"用户点了页面却没出现"时，直接弹提示告诉唯一的解法（重启），
// 而不是留下一次死点击。
// 变体：页面挂载了但卡在"加载中"（后端没响应）——同样的解法、不同的文案，
// 免得用户去排查根本不是问题的 Wallpaper Engine 设置。
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
