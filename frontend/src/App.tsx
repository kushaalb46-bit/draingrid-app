import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
function ThinkingOrb({ state, size = 64 }: { state?: string; size?: number; theme?: string }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={`inline-block rounded-full bg-gradient-to-tr from-sky-500/90 via-cyan-300/85 to-teal-200/90 shadow-[0_0_32px_rgba(56,189,248,0.75)] border border-white/50 ${state === 'solving' ? 'animate-spin' : 'animate-pulse'
        }`}
      aria-hidden="true"
    />
  )
}
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Clock,
  Link2,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Moon,
  Phone,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  TriangleAlert,
  X,
} from 'lucide-react'
import * as drainVisionMod from './lib/drainVision'

async function runBrowserDrainVision(imageDataUrl: string): Promise<unknown> {
  try {
    const mod = drainVisionMod as Record<string, unknown>
    const fn =
      (typeof mod.analyzeDrainImage === 'function' && mod.analyzeDrainImage) ||
      (typeof mod.analyzeDrainPhoto === 'function' && mod.analyzeDrainPhoto) ||
      (typeof mod.classifyDrainImage === 'function' && mod.classifyDrainImage) ||
      (typeof mod.analyzeImage === 'function' && mod.analyzeImage) ||
      (typeof mod.default === 'function' && mod.default) ||
      Object.values(mod).find((v) => typeof v === 'function')
    if (typeof fn === 'function') {
      return await (fn as (img: string) => Promise<unknown>)(imageDataUrl)
    }
  } catch (err) {
    console.warn('Browser vision analysis fallback:', err)
  }
  return undefined
}

/* ============================================================
   Config
   ============================================================ */
// Set VITE_API_BASE in .env (e.g. https://api.example.com) for production builds.
const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000').replace(
  /\/+$/,
  '',
)
const SHOW_DEMO_HINT = Boolean(import.meta.env.DEV) // the passkey hint is shown in dev builds only

// Public contact details. Leave a field empty to hide it; the links only render when filled in.
const CONTACT: { phone: string; email: string } = { phone: '', email: '' }

const PASS_THRESHOLD = 80 // % confidence treated as "verified"
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_DIMENSION = 1024 // uploaded photos are downscaled to this many px
const JPEG_QUALITIES = [0.82, 0.7, 0.58] // tried in order until the photo is small enough
const TARGET_DATA_URL_CHARS = 480_000 // roughly 350 KB of image
const MAX_LOCATION = 300
const MAX_DESCRIPTION = 1000
const MIN_ANALYZE_MS = 2600 // keeps the "solving" state on screen long enough to read
const REQUEST_TIMEOUT_MS = 20_000
const VERIFY_TIMEOUT_MS = 60_000
const LEAVE_MS = 200 // must match .dg-modal-out / .dg-fade-out in index.css
const URL_RE = /^https?:\/\/\S+$/i
const SESSION_KEY = 'draingrid-worker-session'

const ANALYSIS_STEPS = [
  'Analyzing water flow clearance...',
  'Calculating obstruction delta...',
  'Comparing before and after frames...',
  'Scoring confidence...',
]

/* ============================================================
   Types
   ============================================================ */
type Ticket = {
  id: string | number
  location: string
  description: string
  before_image_url: string
  after_image_url?: string | null
  status?: string | null
  ai_confidence_score?: number | null
  created_at?: string | null
  latitude?: number | null
  longitude?: number | null
}

type ViewKey = 'citizen' | 'worker' | 'ledger'
type Filter = 'all' | 'pending' | 'verified'
type Tone = 'success' | 'error'
type Notify = (message: string, tone?: Tone) => void
type Go = (to: string) => void
type Coords = { lat: number; lng: number }
type GeoStatus = 'scanning' | 'locked' | 'denied' | 'error' | 'unsupported'
type GeoState = ReturnType<typeof useGeolocation>
type IconType = typeof MapPin

/* ============================================================
   API helpers
   ============================================================ */
async function api<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const body = await res.json()
        const d = body?.detail
        if (typeof d === 'string') {
          detail = d
        } else if (Array.isArray(d)) {
          // FastAPI validation errors
          detail = d
            .map((x: { loc?: unknown[]; msg?: string }) => `${(x.loc ?? []).slice(1).join('.')}: ${x.msg}`)
            .join('; ')
        }
      } catch {
        // response had no JSON body
      }
      throw new Error(detail.slice(0, 280) || `Request failed (${res.status})`)
    }

    try {
      return (await res.json()) as T
    } catch {
      throw new Error('The server sent an unexpected response.')
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('The request timed out. Please try again.')
    }
    throw e
  } finally {
    window.clearTimeout(timer)
  }
}

function errMsg(e: unknown): string {
  if (e instanceof TypeError) {
    return `Can't reach the server at ${API_BASE}. Check your connection and try again.`
  }
  return e instanceof Error ? e.message : 'Something went wrong.'
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/* ============================================================
   Domain helpers
   ============================================================ */
const VERIFIED_STATUSES = ['verified', 'resolved', 'closed', 'completed']

/** Accepts a 0–1 or 0–100 score and returns a 0–100 value with one decimal. */
function toPercent(score?: number | null): number | null {
  if (score == null || Number.isNaN(score)) return null
  const pct = score <= 1 ? score * 100 : score
  return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10
}

type StatusKey = 'pending' | 'verified' | 'review' | 'failed'

function statusOf(t: Ticket): { key: StatusKey; label: string; pct: number | null } {
  const pct = toPercent(t.ai_confidence_score)
  if (pct == null) {
    return VERIFIED_STATUSES.includes((t.status ?? '').toLowerCase())
      ? { key: 'verified', label: 'VERIFIED', pct }
      : { key: 'pending', label: 'PENDING', pct }
  }
  if (pct >= PASS_THRESHOLD) return { key: 'verified', label: 'AI-VERIFIED', pct }
  if (pct >= 50) return { key: 'review', label: 'NEEDS REVIEW', pct }
  return { key: 'failed', label: 'NOT CLEARED', pct }
}

/** A ticket leaves the worker queue only once it is verified as cleared. */
function isCleared(t: Ticket): boolean {
  return statusOf(t).key === 'verified'
}

function formatDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'Linked image'
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Strips control characters and tidies whitespace. React escapes output; this just keeps the data clean. */
function cleanText(s: string, multiline = false): string {
  const t = s.replace(CONTROL_RE, '')
  return (multiline ? t.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ')).trim()
}

/* ---------- XSS guard for image sources ---------- */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i

/**
 * Every <img src> in the app goes through this. Only http(s) URLs and raster data: URLs pass.
 * Anything else (script-scheme URLs, SVG documents, malformed values) falls back to the placeholder.
 * Relative paths resolve against the API, so server-hosted uploads keep working.
 */
function safeImageSrc(src?: string | null): string | null {
  if (!src) return null
  const s = src.trim()
  if (s.length === 0 || s.length > 4_000_000) return null
  if (DATA_IMAGE_RE.test(s)) return s
  try {
    const u = new URL(s, `${API_BASE}/`)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/* ---------- Contact links (built once, only from the CONTACT config above) ---------- */
const EMAIL_RE = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/
const contactEmail = EMAIL_RE.test(CONTACT.email.trim()) ? CONTACT.email.trim() : ''
const contactPhoneHref = (() => {
  const cleaned = CONTACT.phone.replace(/(?!^\+)[^\d]/g, '')
  return cleaned.replace(/\D/g, '').length >= 7 ? cleaned : ''
})()
const hasContact = contactEmail !== '' || contactPhoneHref !== ''

/* ---------- Geo helpers ---------- */
function formatCoords(c: Coords): string {
  const lat = `${Math.abs(c.lat).toFixed(4)}° ${c.lat >= 0 ? 'N' : 'S'}`
  const lng = `${Math.abs(c.lng).toFixed(4)}° ${c.lng >= 0 ? 'E' : 'W'}`
  return `${lat}, ${lng}`
}

const HEMI_RE = /(\d{1,3}(?:\.\d+)?)\s*°?\s*([NS])\s*[,;]?\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/i
const DECIMAL_RE = /(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/

function parseCoords(text: string): Coords | null {
  const a = HEMI_RE.exec(text)
  if (a) {
    return {
      lat: parseFloat(a[1]) * (a[2].toUpperCase() === 'S' ? -1 : 1),
      lng: parseFloat(a[3]) * (a[4].toUpperCase() === 'W' ? -1 : 1),
    }
  }
  const b = DECIMAL_RE.exec(text)
  if (b) {
    const lat = parseFloat(b[1])
    const lng = parseFloat(b[2])
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }
  }
  return null
}

/** Uses explicit latitude/longitude if the API provides them, else parses the location string. */
function ticketCoords(t: Ticket): Coords | null {
  if (typeof t.latitude === 'number' && typeof t.longitude === 'number') {
    return { lat: t.latitude, lng: t.longitude }
  }
  return parseCoords(t.location)
}

function distanceKm(a: Coords, b: Coords): number {
  const R = 6371
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`
}

/**
 * Decodes an image, downscales it and re-encodes it as JPEG (a plain string for the API).
 * Re-encoding through a canvas also strips EXIF metadata, including any embedded GPS position.
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      try {
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('Empty image')
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas is not supported in this browser.')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        let out = ''
        for (const q of JPEG_QUALITIES) {
          out = canvas.toDataURL('image/jpeg', q)
          if (out.length <= TARGET_DATA_URL_CHARS) break
        }
        resolve(out)
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Unreadable image'))
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Unreadable image'))
    }
    img.src = objectUrl
  })
}

/* ============================================================
   Hooks
   ============================================================ */
function useTickets() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api<Ticket[]>('/api/tickets')
      setTickets(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const upsert = useCallback((t: Ticket) => {
    setTickets((prev) =>
      prev.some((p) => String(p.id) === String(t.id))
        ? prev.map((p) => (String(p.id) === String(t.id) ? { ...p, ...t } : p))
        : [t, ...prev],
    )
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { tickets, loading, error, refresh, upsert }
}

/** Requests a high-accuracy GPS fix on mount; shared by the Citizen Portal and Worker Terminal. */
function useGeolocation() {
  const [status, setStatus] = useState<GeoStatus>('scanning')
  const [coords, setCoords] = useState<Coords | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)

  const scan = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('unsupported')
      return
    }
    setStatus('scanning')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setAccuracy(pos.coords.accuracy)
        setStatus('locked')
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    )
  }, [])

  useEffect(() => {
    scan()
  }, [scan])

  return { status, coords, accuracy, scan }
}

/* ---------- Tiny client-side router (real URLs, no extra dependency) ---------- */
const PATHS: Record<ViewKey, string> = { citizen: '/', worker: '/worker', ledger: '/ledger' }

function viewForPath(pathname: string): ViewKey | null {
  const p = pathname.replace(/\/+$/, '') || '/'
  const keys = Object.keys(PATHS) as ViewKey[]
  return keys.find((k) => PATHS[k] === p) ?? null
}

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback<Go>((to) => {
    if (to !== window.location.pathname) window.history.pushState({}, '', to)
    setPath(to)
    window.scrollTo(0, 0)
  }, [])

  return { path, go }
}

const PAGE_META: Record<ViewKey | 'notfound', { title: string; description: string }> = {
  citizen: {
    title: 'Report a blocked drain · DrainGRID',
    description:
      'Report a blocked drain in seconds. Your location is locked automatically, add a photo and a field team takes it from there.',
  },
  worker: {
    title: 'Worker Terminal · DrainGRID',
    description: 'Field worker terminal: see nearby drain tickets and verify repairs with an AI audit.',
  },
  ledger: {
    title: 'Public Audit Ledger · DrainGRID',
    description: 'A transparent public record of every drain report, repair and AI verification score.',
  },
  notfound: {
    title: 'Page not found · DrainGRID',
    description: 'The page you were looking for does not exist.',
  },
}

// Scroll lock shared by modals and the mobile menu (ref-counted so they can never fight each other).
let lockCount = 0
let savedOverflow = ''
function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    if (lockCount++ === 0) {
      savedOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    return () => {
      if (--lockCount === 0) document.body.style.overflow = savedOverflow
    }
  }, [active])
}

/* ============================================================
   Theme (Dark "Aquatic Obsidian Glass" / Light "Frosted Arctic Acrylic")
   The choice lives on <html> as the class `dark` or `light`; every colour is a CSS variable in index.css.
   ============================================================ */
type Theme = 'dark' | 'light'
const THEME_KEY = 'draingrid-theme'
const THEME_COLORS: Record<Theme, string> = { dark: '#041029', light: '#f1f5f9' }
const ThemeContext = createContext<Theme>('dark')

function readStoredTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null // storage blocked (private mode, strict settings)
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('dark', 'light')
  root.classList.add(theme)
  root.style.colorScheme = theme
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = THEME_COLORS[theme]
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

// Runs once at load, before React renders anything, so the first paint already has the right theme.
if (typeof document !== 'undefined') applyTheme(readStoredTheme() ?? systemTheme())

function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  const switchTimer = useRef<number | undefined>(undefined)

  const commit = useCallback((next: Theme, persist: boolean) => {
    const root = document.documentElement
    root.classList.add('dg-theme-switching') // enables the colour cross-fade
    window.clearTimeout(switchTimer.current)
    applyTheme(next)
    setTheme(next)
    if (persist) {
      try {
        window.localStorage.setItem(THEME_KEY, next)
      } catch {
        // storage unavailable; the choice lasts until reload
      }
    }
    switchTimer.current = window.setTimeout(() => root.classList.remove('dg-theme-switching'), 450)
  }, [])

  // Follow the OS setting live, but only while the person has not picked a theme themselves.
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (readStoredTheme() === null) commit(e.matches ? 'dark' : 'light', false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [commit])

  useEffect(() => () => window.clearTimeout(switchTimer.current), [])

  const toggleTheme = useCallback(() => commit(theme === 'dark' ? 'light' : 'dark', true), [commit, theme])

  return { theme, toggleTheme }
}

/* ============================================================
   Style tokens
   ============================================================ */
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--dg-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--dg-page)]'

const btnBase = `inline-flex items-center justify-center gap-2 text-sm font-medium transition duration-300 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${focusRing}`
const btnPrimary = `${btnBase} min-h-[48px] rounded-2xl dg-accent-bg px-5 py-3 font-semibold dg-on-accent enabled:hover:-translate-y-0.5 enabled:hover:brightness-110`
const btnSecondary = `${btnBase} min-h-[44px] rounded-2xl border dg-bd-2 dg-fill-2 px-5 py-2.5 dg-fg enabled:hover:-translate-y-0.5 dg-hover-fill-2`
const btnGhost = `${btnBase} min-h-[40px] rounded-full px-3 py-1.5 text-xs dg-fg-2 dg-hover-fill dg-hover-fg`

const inputCls =
  'dg-input block w-full rounded-2xl px-4 py-3 text-base transition focus:outline-none disabled:opacity-60 sm:text-[15px]'

const eyebrowCls = 'text-[11px] font-semibold uppercase tracking-[0.16em] dg-eyebrow'

/* ============================================================
   UI primitives
   ============================================================ */
function Spinner({ onLight = false }: { onLight?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 ${onLight ? 'dg-spinner-accent' : 'dg-spinner'
        }`}
    />
  )
}

/** Civic placeholder: a drain grate drawn in SVG, shown wherever a photo is missing or fails to load. */
function GratePlaceholder({ className = '', label = 'Photo unavailable' }: { className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`grid place-items-center dg-placeholder ${className}`}
    >
      <svg viewBox="0 0 64 64" fill="none" className="h-9 w-9" aria-hidden="true">
        <rect x="6" y="10" width="52" height="44" rx="9" stroke="currentColor" strokeWidth="2" />
        {[17, 26, 35, 44].map((y) => (
          <rect key={y} x="14" y={y - 2} width="36" height="4.5" rx="2.25" fill="currentColor" opacity="0.55" />
        ))}
      </svg>
    </span>
  )
}

type PhotoProps = { src?: string | null; alt: string; className?: string }

function PhotoInner({ src, alt, className = '' }: PhotoProps) {
  const [failed, setFailed] = useState(false)
  const safe = useMemo(() => safeImageSrc(src), [src])
  if (!safe || failed) return <GratePlaceholder className={className} label={alt} />
  return (
    <img
      src={safe}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  )
}

// keyed by src so the "failed" state resets when the image changes
function Photo(props: PhotoProps) {
  return <PhotoInner key={props.src ?? 'none'} {...props} />
}

function Figure({ src, label, aspect = 'aspect-[4/3]' }: { src?: string | null; label: string; aspect?: string }) {
  return (
    <figure className="min-w-0">
      <div className="overflow-hidden rounded-2xl border dg-bd dg-media-bg">
        <Photo src={src} alt={label} className={`${aspect} w-full`} />
      </div>
      <figcaption className="mt-1.5 text-xs font-medium dg-fg-2">{label}</figcaption>
    </figure>
  )
}

// Status tones come from CSS variables, so the same badge is soft glass at night and a vivid, high-contrast chip by day.
const BADGE_TONES: Record<StatusKey, { wrap: string; divider: string; dot: string }> = {
  pending: { wrap: 'dg-badge dg-badge--amber', divider: 'dg-badge-div--amber', dot: 'dg-dot-amber' },
  verified: { wrap: 'dg-badge dg-badge--green', divider: 'dg-badge-div--green', dot: 'dg-dot-green' },
  review: { wrap: 'dg-badge dg-badge--orange', divider: 'dg-badge-div--orange', dot: 'dg-dot-orange' },
  failed: { wrap: 'dg-badge dg-badge--red', divider: 'dg-badge-div--red', dot: 'dg-dot-red' },
}

const METER_COLORS: Record<StatusKey, string> = {
  pending: 'dg-meter--amber',
  verified: 'dg-meter--green',
  review: 'dg-meter--orange',
  failed: 'dg-meter--red',
}

/** Micro-badge: status label, plus the AI confidence metric once a score exists. */
function StatusBadge({ t }: { t: Ticket }) {
  const s = statusOf(t)
  const tone = BADGE_TONES[s.key]
  return (
    <span
      className={`inline-flex items-center overflow-hidden rounded-full border text-[10px] font-semibold tracking-wider backdrop-blur-md ${tone.wrap}`}
    >
      <span className="flex items-center gap-1.5 px-2 py-1">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${s.key === 'pending' ? 'animate-pulse' : ''}`} />
        {s.label}
      </span>
      {s.pct != null && <span className={`border-l px-2 py-1 tabular-nums ${tone.divider}`}>{s.pct.toFixed(1)}%</span>}
    </span>
  )
}

function ConfidenceBar({ pct, statusKey }: { pct: number; statusKey: StatusKey }) {
  const [shown, setShown] = useState(0)

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(pct))
    return () => cancelAnimationFrame(id)
  }, [pct])

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-0.5">
          <span className="text-5xl font-semibold tabular-nums tracking-tight dg-fg">{pct.toFixed(1)}</span>
          <span className="text-xl font-medium dg-fg-2">%</span>
        </div>
        <span className="pb-1.5 text-xs dg-fg-2">AI confidence</span>
      </div>
      <div className="relative mt-3 h-2 rounded-full dg-fill-3">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-out ${METER_COLORS[statusKey]}`}
          style={{ width: `${shown}%` }}
        />
        <div className="absolute -top-1 h-4 w-px dg-marker" style={{ left: `${PASS_THRESHOLD}%` }} />
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] dg-fg-3">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${PASS_THRESHOLD}%` }}>
          {PASS_THRESHOLD}% pass
        </span>
      </div>
    </div>
  )
}

/** Orb with a soft halo. Floats gently so it never feels stuck to the page. */
function OrbStage({ state, small = false }: { state: 'searching' | 'solving'; small?: boolean }) {
  const theme = useContext(ThemeContext)
  return (
    <div className={`dg-orb-wrap ${small ? 'dg-orb-wrap--sm' : ''}`}>
      <span className="dg-orb-halo" aria-hidden="true" />
      <span className="dg-orb-ring" aria-hidden="true" />
      <ThinkingOrb state={state} size={64} theme={theme} />
    </div>
  )
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Accessible dialog: focus trap, Escape to close, scroll lock, and a weightless rise/float-away animation.
 * On phones it docks to the bottom edge as a sheet. Children receive `close`, which plays the exit animation.
 */
function Modal({
  children,
  onClose,
  closable = true,
  labelledBy,
  widthClass = 'sm:max-w-md',
}: {
  children: (close: () => void) => ReactNode
  onClose: () => void
  closable?: boolean
  labelledBy: string
  widthClass?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  const leaveTimer = useRef<number | undefined>(undefined)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const close = useCallback(() => {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => onCloseRef.current(), LEAVE_MS)
  }, [])

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  useScrollLock(true)

  // Move focus into the dialog, and give it back when the dialog goes away.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) {
      const first = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
        (el) => !el.hasAttribute('data-modal-close') && el.getClientRects().length > 0,
      )
        ; (first ?? panel).focus()
    }
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    if (!closable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closable, close])

  function onKeyDown(e: ReactKeyEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.getClientRects().length > 0,
    )
    if (items.length === 0) {
      e.preventDefault()
      panelRef.current?.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        aria-hidden="true"
        onClick={closable ? close : undefined}
        className={`absolute inset-0 dg-scrim backdrop-blur-md ${leaving ? 'dg-fade-out' : 'dg-fade-in'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`glass-strong relative max-h-[92dvh] w-full overflow-y-auto overscroll-contain rounded-t-[28px] outline-none sm:max-h-[90dvh] sm:rounded-[28px] ${widthClass} ${leaving ? 'dg-modal-out' : 'dg-modal-in'
          }`}
      >
        {closable && (
          <button
            type="button"
            data-modal-close=""
            aria-label="Close dialog"
            onClick={close}
            className={`absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full dg-fill-3 dg-fg-2 transition dg-hover-fill-2 dg-hover-fg active:scale-95 ${focusRing}`}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {children(close)}
      </div>
    </div>
  )
}

/** Real <a href> links so URLs can be opened in a new tab, bookmarked and shared; plain clicks stay in-app. */
function NavLink({
  to,
  go,
  className,
  current = false,
  onNavigate,
  children,
}: {
  to: string
  go: Go
  className?: string
  current?: boolean
  onNavigate?: () => void
  children: ReactNode
}) {
  function onClick(e: ReactMouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onNavigate?.()
    go(to)
  }
  return (
    <a href={to} onClick={onClick} aria-current={current ? 'page' : undefined} className={className}>
      {children}
    </a>
  )
}

/** Animated Sun / Moon switch. `icon` is the round header button; `row` is the full-width drawer entry. */
function ThemeToggle({
  theme,
  onToggle,
  className = 'grid',
  variant = 'icon',
}: {
  theme: Theme
  onToggle: () => void
  className?: string
  variant?: 'icon' | 'row'
}) {
  const dark = theme === 'dark'
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  const iconMotion = 'absolute h-5 w-5 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]'
  const icons = (
    <span className="relative grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
      <Sun className={`${iconMotion} dg-tone-amber ${dark ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'}`} />
      <Moon className={`${iconMotion} dg-accent ${dark ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0'}`} />
    </span>
  )

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        className={`dg-theme-toggle flex min-h-[52px] w-full items-center gap-3 rounded-2xl px-4 text-[15px] font-medium transition active:scale-[0.98] ${focusRing} ${className}`}
      >
        {icons}
        <span className="flex-1 text-left">{dark ? 'Dark mode' : 'Light mode'}</span>
        <span className="text-xs font-normal dg-fg-3">{dark ? 'Switch to light' : 'Switch to dark'}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={`dg-theme-toggle h-11 w-11 shrink-0 place-items-center rounded-full transition active:scale-90 ${focusRing} ${className}`}
    >
      {icons}
    </button>
  )
}

function LogoMark({ className = 'h-14 w-14' }: { className?: string }) {
  const theme = useContext(ThemeContext)
  const src = theme === 'light' ? '/favicon-dark.svg?v=dual1' : '/favicon-light.svg?v=dual1'
  return <img src={src} alt="DrainGRID" className={`dg-logo ${className} object-contain`} />
}

function ContactLinks({ className = '' }: { className?: string }) {
  if (!hasContact) return null
  const item = `inline-flex min-h-[44px] items-center gap-2.5 rounded-xl px-2 text-sm dg-fg-2 transition dg-hover-fg ${focusRing}`
  return (
    <ul className={className}>
      {contactPhoneHref ? (
        <li>
          <a href={`tel:${contactPhoneHref}`} className={item}>
            <Phone className="h-4 w-4 dg-accent" aria-hidden="true" />
            {CONTACT.phone.trim()}
          </a>
        </li>
      ) : null}
      {contactEmail ? (
        <li>
          <a href={`mailto:${contactEmail}`} className={item}>
            <Mail className="h-4 w-4 dg-accent" aria-hidden="true" />
            <span className="min-w-0 break-all">{contactEmail}</span>
          </a>
        </li>
      ) : null}
    </ul>
  )
}

/* ============================================================
   Backdrop: watermark and drifting bubbles
   ============================================================ */
const BUBBLES: { left: string; size: number; dur: number; delay: number }[] = [
  { left: '5%', size: 10, dur: 21, delay: 2 },
  { left: '13%', size: 22, dur: 29, delay: 11 },
  { left: '24%', size: 8, dur: 18, delay: 6 },
  { left: '33%', size: 16, dur: 25, delay: 17 },
  { left: '45%', size: 12, dur: 22, delay: 4 },
  { left: '54%', size: 26, dur: 32, delay: 13 },
  { left: '63%', size: 9, dur: 19, delay: 8 },
  { left: '72%', size: 18, dur: 27, delay: 1 },
  { left: '81%', size: 11, dur: 23, delay: 15 },
  { left: '90%', size: 20, dur: 30, delay: 9 },
  { left: '96%', size: 8, dur: 20, delay: 5 },
]

function Backdrop() {
  return (
    <>

      <div className="dg-bubbles" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="dg-bubble"
            style={{
              left: b.left,
              width: b.size,
              height: b.size,
              animationName: i % 2 === 0 ? 'dg-bubble-a' : 'dg-bubble-b',
              animationDuration: `${b.dur}s`,
              animationDelay: `-${b.delay}s`,
            }}
          />
        ))}
      </div>
    </>
  )
}

/* ============================================================
   Photo input: SVG dropzone with URL fallback
   ============================================================ */
function DropIllustration() {
  return (
    <div className="dg-float-slow relative h-16 w-16">
      <svg viewBox="0 0 64 64" fill="none" className="h-16 w-16 dg-accent-soft" aria-hidden="true">
        <rect x="4" y="6" width="56" height="48" rx="12" stroke="currentColor" strokeWidth="2" />
        {[17, 26, 35, 44].map((y) => (
          <rect key={y} x="14" y={y - 2} width="36" height="4" rx="2" fill="currentColor" />
        ))}
      </svg>
      <span className="absolute -bottom-1.5 -right-1.5 grid h-7 w-7 place-items-center rounded-full border dg-bd-3 dg-chip-solid dg-accent">
        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
  )
}

function ImageDrop({
  subject,
  value,
  onChange,
  disabled = false,
}: {
  subject: string
  value: string
  onChange: (url: string) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [dragging, setDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ name: string; size: number } | null>(null)
  const [urlText, setUrlText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function switchMode(next: 'file' | 'url') {
    setMode(next)
    setError(null)
    setMeta(null)
    setUrlText('')
    onChange('')
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (JPG or PNG).')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is larger than 10 MB. Please choose a smaller photo.')
      return
    }
    setError(null)
    setProcessing(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      setMeta({ name: file.name, size: file.size })
      onChange(dataUrl)
    } catch {
      setError("We couldn't read that image. Try a JPG or PNG instead.")
    } finally {
      setProcessing(false)
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    void handleFile(file)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!disabled) setDragging(true)
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    void handleFile(e.dataTransfer.files?.[0])
  }

  function onZoneKey(e: ReactKeyEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled) fileRef.current?.click()
    }
  }

  function onUrlChange(text: string) {
    setUrlText(text)
    const t = text.trim()
    onChange(URL_RE.test(t) ? t : '')
  }

  const urlInvalid = urlText.trim() !== '' && !URL_RE.test(urlText.trim())

  const preview = (title: string, subtitle: string, actions?: ReactNode) => (
    <div className="dg-fade-in flex items-center gap-3 rounded-2xl border dg-bd dg-fill-2 p-2.5">
      <Photo src={value} alt="Photo preview" className="h-16 w-20 shrink-0 rounded-xl border dg-bd" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium dg-fg">{title}</p>
        <p className="text-xs dg-fg-2">{subtitle}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-col gap-0.5 sm:flex-row sm:gap-1">{actions}</div>}
    </div>
  )

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
      />

      {mode === 'file' ? (
        value ? (
          preview(
            meta?.name ?? 'Photo',
            `${meta ? `${formatBytes(meta.size)} · ` : ''}Ready to submit`,
            <>
              <button type="button" className={btnGhost} disabled={disabled} onClick={() => fileRef.current?.click()}>
                Replace
              </button>
              <button
                type="button"
                className={btnGhost}
                disabled={disabled}
                onClick={() => {
                  setMeta(null)
                  setError(null)
                  onChange('')
                }}
              >
                Remove
              </button>
            </>,
          )
        ) : (
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={`Upload photo of ${subject}`}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled && !processing) fileRef.current?.click()
            }}
            onKeyDown={onZoneKey}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`dg-drop flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-5 py-9 text-center transition duration-300 ${focusRing} ${disabled ? 'pointer-events-none opacity-50' : ''
              } ${dragging ? 'dg-drop--active scale-[1.01]' : ''}`}
          >
            {processing ? (
              <>
                <Spinner />
                <p className="mt-3 text-sm dg-fg-2">Processing photo…</p>
              </>
            ) : (
              <>
                <DropIllustration />
                <p className="mt-4 text-sm dg-fg-2">
                  <span className="font-semibold dg-fg">Click to upload</span> or drag photo of {subject}
                </p>
                <p className="mt-1 text-xs dg-fg-3">JPG or PNG, up to 10 MB</p>
              </>
            )}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <input
            type="url"
            inputMode="url"
            aria-label="Image URL"
            className={inputCls}
            placeholder="https://example.com/photo.jpg"
            value={urlText}
            disabled={disabled}
            maxLength={2000}
            onChange={(e) => onUrlChange(e.target.value)}
          />
          {value && preview(hostOf(value), 'Linked image')}
          {urlInvalid && (
            <p role="alert" className="text-xs dg-tone-red">
              Enter a full web address starting with http:// or https://
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs dg-tone-red">
          {error}
        </p>
      )}

      <div className="mt-3 flex justify-center">
        <button
          type="button"
          className={btnGhost}
          disabled={disabled}
          onClick={() => switchMode(mode === 'file' ? 'url' : 'file')}
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {mode === 'file' ? 'Use an image link instead' : 'Upload a photo instead'}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
   Citizen Portal
   ============================================================ */
function LocationCard({
  geo,
  override,
  onOverride,
  manual,
  onManual,
  disabled,
}: {
  geo: GeoState
  override: boolean
  onOverride: (v: boolean) => void
  manual: string
  onManual: (v: string) => void
  disabled: boolean
}) {
  const { status, coords, accuracy, scan } = geo
  const manualForced = status === 'denied' || status === 'error' || status === 'unsupported'
  const showManual = override || manualForced
  const accurate = accuracy != null && accuracy <= 50

  return (
    <div className="rounded-2xl border dg-bd dg-fill p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={eyebrowCls}>Location</span>
        {status === 'locked' && !override && (
          <div className="flex items-center gap-1">
            <button type="button" className={btnGhost} disabled={disabled} onClick={() => onOverride(true)}>
              Override
            </button>
            <button type="button" className={btnGhost} disabled={disabled} onClick={scan} aria-label="Re-scan GPS">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
        {override && coords && (
          <button type="button" className={btnGhost} disabled={disabled} onClick={() => onOverride(false)}>
            Use GPS
          </button>
        )}
      </div>

      {showManual ? (
        <div className="space-y-2.5">
          {manualForced && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl dg-note dg-note--amber px-3 py-2 text-xs"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1">
                {status === 'denied'
                  ? 'Location access is off. Describe where the drain is, or allow location and try again.'
                  : status === 'unsupported'
                    ? 'This browser can’t share its location. Describe where the drain is.'
                    : 'We couldn’t get a GPS fix. Describe where the drain is, or try again.'}
              </p>
              {status !== 'unsupported' && (
                <button
                  type="button"
                  className={`shrink-0 rounded font-semibold underline underline-offset-2 ${focusRing}`}
                  onClick={scan}
                >
                  Try again
                </button>
              )}
            </div>
          )}
          <input
            className={inputCls}
            placeholder="Street, landmark or nearest junction"
            value={manual}
            maxLength={MAX_LOCATION}
            onChange={(e) => onManual(e.target.value)}
            disabled={disabled}
            aria-label="Location description"
          />
          {coords && <p className="text-xs dg-fg-3">GPS coordinates ({formatCoords(coords)}) will be attached.</p>}
        </div>
      ) : status === 'scanning' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <OrbStage state="searching" small />
          <div className="min-w-0 flex-1" role="status">
            <p className="text-sm font-medium dg-fg">Scanning for GPS signal</p>
            <p className="text-xs dg-fg-2">Locking your exact position…</p>
          </div>
          <button type="button" className={btnGhost} onClick={() => onOverride(true)}>
            Enter manually
          </button>
        </div>
      ) : (
        coords && (
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full dg-accent-bg dg-on-accent">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-medium tabular-nums dg-fg">{formatCoords(coords)}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="dg-chip-green inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  Auto-Locked
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border dg-bd-2 dg-fill-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider dg-fg-2">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                  {accurate ? 'High accuracy' : 'Approximate'}
                  {accuracy != null && <span className="tabular-nums">· ±{Math.round(accuracy)} m</span>}
                </span>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  )
}

function CitizenView({
  geo,
  onCreated,
  notify,
}: {
  geo: GeoState
  onCreated: () => void | Promise<void>
  notify: Notify
}) {
  const [override, setOverride] = useState(false)
  const [manual, setManual] = useState('')
  const [note, setNote] = useState('')
  const [image, setImage] = useState('')
  const [imageKey, setImageKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [visionStatus, setVisionStatus] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id?: string | number } | null>(null)

  const manualForced = geo.status === 'denied' || geo.status === 'error' || geo.status === 'unsupported'
  const useManual = override || manualForced
  const manualText = cleanText(manual)

  let locationString = ''
  if (useManual) {
    locationString = manualText && geo.coords ? `${manualText} (${formatCoords(geo.coords)})` : manualText
  } else if (geo.status === 'locked' && geo.coords) {
    locationString = formatCoords(geo.coords)
  }

  const ready = locationString !== '' && image !== ''
  const missing = [locationString === '' ? 'a location' : '', image === '' ? 'a photo' : ''].filter(Boolean)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      setVisionStatus('Analyzing drain photo with AI vision…')
      const visualAnalysis = await runBrowserDrainVision(image)
      setVisionStatus(null)
      const res = await api<Partial<Ticket>>('/api/tickets/new', {
        method: 'POST',
        body: JSON.stringify({
          location: locationString.slice(0, MAX_LOCATION),
          description: cleanText(note, true).slice(0, MAX_DESCRIPTION) || 'Clogged drain reported via Citizen Portal.',
          before_image_url: image,
          ...(visualAnalysis != null ? { visual_analysis: visualAnalysis } : {}),
        }),
      })
      setCreated({ id: res?.id })
      setNote('')
      setImage('')
      setImageKey((k) => k + 1)
      void onCreated()
      notify('Report submitted')
    } catch (err) {
      const message = errMsg(err)
      setSubmitError(message)
      notify(message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="text-center">
        <span className="dg-float glass-soft inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium dg-fg">
          <Sparkles className="h-3.5 w-3.5 dg-accent" aria-hidden="true" />
          No account needed
        </span>
        <h1 className="mt-5 text-[2rem] font-semibold leading-[1.1] tracking-tight dg-fg sm:text-5xl">
          See a blocked drain?
          <br />
          <span className="dg-text-aqua">Report it in seconds.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed dg-fg-2 sm:text-[17px]">
          We lock your location automatically. Add a photo and our field team takes it from there.
        </p>
      </div>

      <div className="glass dg-rise relative mt-9 overflow-hidden rounded-3xl p-4 sm:mt-10 sm:p-6" style={{ animationDelay: '120ms' }}>
        {submitting && (
          <div className="dg-fade-in absolute inset-0 z-10 grid place-items-center dg-overlay backdrop-blur-sm" role="status">
            <div className="flex flex-col items-center text-center">
              <OrbStage state="searching" />
              <p className="mt-2 text-sm font-medium dg-fg">{visionStatus ?? 'Submitting your report…'}</p>
              <p className="mt-1 text-xs dg-fg-2">Securing your location and photo</p>
            </div>
          </div>
        )}

        {created ? (
          <div className="dg-fade-in flex flex-col items-center py-8 text-center" role="status">
            <span className="dg-pop dg-float grid h-16 w-16 place-items-center rounded-full dg-circle-green">
              <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
            </span>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight dg-fg">Report received</h2>
            <p className="mt-1.5 max-w-xs text-sm dg-fg-2">
              Thank you. Your report is now in the field worker queue.
            </p>
            {created.id != null && (
              <div className="mt-5 inline-flex items-center gap-2 rounded-full border dg-bd-2 dg-fill-2 px-3.5 py-1.5 text-sm">
                <span className="dg-fg-2">Reference</span>
                <span className="font-semibold tabular-nums dg-fg">#{String(created.id)}</span>
              </div>
            )}
            <button className={`${btnSecondary} mt-7`} onClick={() => setCreated(null)}>
              Report another drain
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <LocationCard
              geo={geo}
              override={override}
              onOverride={setOverride}
              manual={manual}
              onManual={setManual}
              disabled={submitting}
            />

            <div>
              <label htmlFor="note" className={`${eyebrowCls} mb-2 block`}>
                Note <span className="font-normal normal-case tracking-normal dg-fg-3">(optional)</span>
              </label>
              <textarea
                id="note"
                rows={2}
                className={`${inputCls} resize-none`}
                placeholder="Water pooling after rain, grate covered in debris…"
                value={note}
                maxLength={MAX_DESCRIPTION}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div>
              <span className={`${eyebrowCls} mb-2 block`}>Photo</span>
              <ImageDrop
                key={imageKey}
                subject="clogged drain"
                value={image}
                onChange={setImage}
                disabled={submitting}
              />
            </div>

            {submitError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl dg-note dg-note--red px-3 py-2.5 text-sm"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p className="min-w-0 flex-1">
                  <span className="font-semibold">We couldn’t send your report.</span> {submitError}
                </p>
              </div>
            )}

            <button type="submit" className={`${btnPrimary} w-full text-[15px]`} disabled={!ready || submitting}>
              {submitting ? (
                <>
                  <Spinner onLight /> Submitting…
                </>
              ) : (
                <>
                  Submit report
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
            <p className="text-center text-xs dg-fg-3">
              {ready
                ? 'Your location and photo will be shared with the field team.'
                : `Add ${missing.join(' and ')} to continue.`}
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

/* ============================================================
   Worker Terminal
   ============================================================ */
function PasskeyModal({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function submit(value: string) {
    if (!/^\d{4}$/.test(value)) {
      setError('Enter all 4 digits of your passkey.')
      return
    }
    setError(null)
    setChecking(true)
    timer.current = window.setTimeout(onSuccess, 450)
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4)
    setCode(v)
    setError(null)
    if (v.length === 4) submit(v)
  }

  return (
    <Modal onClose={onClose} labelledBy="passkey-title" widthClass="sm:max-w-sm">
      {() => (
        <form
          className="px-6 pb-7 pt-9 text-center sm:px-7"
          onSubmit={(e) => {
            e.preventDefault()
            if (!checking) submit(code)
          }}
        >
          <span className="dg-float mx-auto grid h-14 w-14 place-items-center rounded-full dg-accent-bg dg-on-accent">
            <Lock className="h-6 w-6" aria-hidden="true" />
          </span>
          <h2 id="passkey-title" className="mt-5 text-xl font-semibold tracking-tight dg-fg">
            Worker Terminal
          </h2>
          <p className="mt-1.5 text-sm dg-fg-2">
            Enter your 4-digit passkey to continue.
            {SHOW_DEMO_HINT && (
              <>
                {' '}
                <span className="dg-fg-3">Dev build: any 4-digit code works.</span>
              </>
            )}
          </p>

          <div className="relative mx-auto mt-7 w-fit">
            <div className="flex gap-2.5 sm:gap-3">
              {[0, 1, 2, 3].map((i) => {
                const active = i === code.length && !checking
                return (
                  <div
                    key={i}
                    data-state={error ? 'error' : active ? 'active' : 'idle'}
                    className="dg-digit grid h-14 w-12 place-items-center rounded-2xl border text-2xl font-semibold dg-fg transition duration-200"
                  >
                    {i < code.length ? '•' : ''}
                  </div>
                )
              })}
            </div>
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="4-digit worker passkey"
              maxLength={4}
              value={code}
              onChange={onChange}
              disabled={checking}
              className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent opacity-0 caret-transparent"
            />
          </div>

          {error && (
            <p role="alert" className="mt-3 text-xs dg-tone-red">
              {error}
            </p>
          )}

          <button type="submit" className={`${btnPrimary} mt-6 w-full`} disabled={code.length !== 4 || checking}>
            {checking ? (
              <>
                <Spinner onLight /> Verifying…
              </>
            ) : (
              <>
                Unlock terminal
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      )}
    </Modal>
  )
}

function VerifyModal({
  ticket,
  onClose,
  onVerified,
}: {
  ticket: Ticket
  onClose: () => void
  onVerified: (t: Ticket) => void
}) {
  const [phase, setPhase] = useState<'capture' | 'analyzing' | 'result'>('capture')
  const [afterImage, setAfterImage] = useState('')
  const [result, setResult] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stepIdx, setStepIdx] = useState(0)

  useEffect(() => {
    if (phase !== 'analyzing') return
    const id = window.setInterval(() => setStepIdx((i) => (i + 1) % ANALYSIS_STEPS.length), 1500)
    return () => window.clearInterval(id)
  }, [phase])

  async function run() {
    if (!afterImage) return
    setError(null)
    setStepIdx(0)
    setPhase('analyzing')
    try {
      const [updated] = await Promise.all([
        api<Ticket>(
          `/api/tickets/${encodeURIComponent(String(ticket.id))}/verify`,
          { method: 'POST', body: JSON.stringify({ after_image_url: afterImage }) },
          VERIFY_TIMEOUT_MS,
        ),
        sleep(MIN_ANALYZE_MS),
      ])
      const merged: Ticket = {
        ...ticket,
        ...updated,
        after_image_url: updated.after_image_url ?? afterImage,
      }
      setResult(merged)
      onVerified(merged)
      setPhase('result')
    } catch (e) {
      setError(errMsg(e))
      setPhase('capture')
    }
  }

  const s = result ? statusOf(result) : null

  return (
    <Modal
      onClose={onClose}
      closable={phase !== 'analyzing'}
      labelledBy="verify-title"
      widthClass={phase === 'result' ? 'sm:max-w-xl' : 'sm:max-w-md'}
    >
      {(close) => (
        <>
          {phase === 'capture' && (
            <div className="p-5 sm:p-7">
              <p className={eyebrowCls}>AI audit · Ticket #{String(ticket.id)}</p>
              <h2 id="verify-title" className="mt-1.5 pr-10 text-xl font-semibold tracking-tight dg-fg">
                {ticket.location}
              </h2>

              <div className="mt-5 flex items-center gap-3 rounded-2xl border dg-bd dg-fill p-2.5">
                <Photo
                  src={ticket.before_image_url}
                  alt="Reported drain"
                  className="h-14 w-[72px] shrink-0 rounded-xl border dg-bd"
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium dg-fg-2">Original report</p>
                  <p className="line-clamp-2 text-sm dg-fg-2">{ticket.description}</p>
                </div>
              </div>

              <div className="mt-5">
                <span className={`${eyebrowCls} mb-2 block`}>Cleared photo</span>
                <ImageDrop subject="cleared drain" value={afterImage} onChange={setAfterImage} />
              </div>

              {error && (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-xl dg-note dg-note--red px-3 py-2.5 text-sm"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold">Verification failed.</span> {error}
                  </p>
                </div>
              )}

              <div className="mt-6 flex gap-3">
                <button type="button" className={`${btnSecondary} flex-1`} onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${btnPrimary} flex-[1.4]`}
                  onClick={() => void run()}
                  disabled={!afterImage}
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Run AI Audit
                </button>
              </div>
            </div>
          )}

          {phase === 'analyzing' && (
            <div className="px-6 pb-9 pt-10 text-center sm:px-7">
              <h2 id="verify-title" className="sr-only">
                Running AI audit
              </h2>
              <div className="flex justify-center">
                <OrbStage state="solving" />
              </div>
              <p key={stepIdx} aria-live="polite" className="dg-fade-in mt-6 text-[15px] font-medium dg-fg">
                {ANALYSIS_STEPS[stepIdx]}
              </p>
              <p className="mt-1.5 text-xs dg-fg-2">Ticket #{String(ticket.id)} · This only takes a few seconds</p>

              <div className="mx-auto mt-7 flex max-w-xs items-center justify-center gap-3">
                <Photo
                  src={ticket.before_image_url}
                  alt="Before"
                  className="h-14 w-[72px] rounded-xl border dg-bd"
                />
                <ArrowRight className="h-4 w-4 shrink-0 dg-accent-soft" aria-hidden="true" />
                <Photo src={afterImage} alt="After" className="h-14 w-[72px] rounded-xl border dg-bd" />
              </div>
            </div>
          )}

          {phase === 'result' && result && s && (
            <div className="dg-fade-in p-5 sm:p-7">
              <p className={eyebrowCls}>AI audit · Ticket #{String(result.id)}</p>
              <h2 id="verify-title" className="mt-1.5 pr-10 text-xl font-semibold tracking-tight dg-fg">
                {result.location}
              </h2>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Figure src={result.before_image_url} label="Before" />
                <Figure src={result.after_image_url ?? afterImage} label="After" />
              </div>

              <div className="mt-6 rounded-2xl border dg-bd dg-fill p-5" role="status">
                <div className="mb-4 flex items-center gap-2">
                  <StatusBadge t={result} />
                </div>
                {s.pct != null ? (
                  <ConfidenceBar pct={s.pct} statusKey={s.key} />
                ) : (
                  <p className="text-sm dg-fg-2">The server returned no confidence score.</p>
                )}
                <p className="mt-3 text-sm dg-fg-2">
                  {s.pct == null
                    ? 'Verification finished, but no score was returned.'
                    : s.key === 'verified'
                      ? 'The drain is clear. This ticket is now closed and recorded in the public ledger.'
                      : s.key === 'review'
                        ? 'Inconclusive. The ticket stays open for a manual re-check.'
                        : 'The drain still appears to be blocked. The ticket stays open for another visit.'}
                </p>
              </div>

              <div className="mt-6 flex justify-end">
                <button className={`${btnPrimary} w-full sm:w-auto`} onClick={close}>
                  Done
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function WorkerView({
  authed,
  tickets,
  loading,
  geo,
  onRefresh,
  onVerified,
  onUnlock,
  onCancelLogin,
  onSignOut,
}: {
  authed: boolean
  tickets: Ticket[]
  loading: boolean
  geo: GeoState
  onRefresh: () => void | Promise<void>
  onVerified: (t: Ticket) => void
  onUnlock: () => void
  onCancelLogin: () => void
  onSignOut: () => void
}) {
  const [active, setActive] = useState<Ticket | null>(null)
  const origin = geo.coords

  const rows = useMemo(() => {
    const list = tickets
      .filter((t) => !isCleared(t))
      .map((t) => {
        const c = ticketCoords(t)
        return { t, km: origin && c ? distanceKm(origin, c) : null }
      })
    list.sort((a, b) => {
      if (a.km == null && b.km == null) return 0
      if (a.km == null) return 1
      if (b.km == null) return -1
      return a.km - b.km
    })
    return list
  }, [tickets, origin])

  if (!authed) {
    return (
      <div className="mx-auto max-w-md text-center">
        <span className="dg-float glass mx-auto grid h-16 w-16 place-items-center rounded-full dg-accent">
          <Lock className="h-7 w-7" aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight dg-fg">Worker Terminal</h1>
        <p className="mt-2 dg-fg-2">Restricted to field workers. Enter your passkey to continue.</p>
        <PasskeyModal onSuccess={onUnlock} onClose={onCancelLogin} />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="glass-soft inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium dg-fg">
            <ShieldCheck className="h-3.5 w-3.5 dg-tone-green" aria-hidden="true" />
            Authenticated · Field worker
          </span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight dg-fg sm:text-4xl">Active tickets</h1>
          <p className="mt-2 dg-fg-2">
            {origin
              ? `Sorted by distance from ${formatCoords(origin)}.`
              : 'Location unavailable. Showing tickets in the order they were submitted.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!origin && (
            <button className={btnSecondary} onClick={geo.scan}>
              <MapPin className="h-4 w-4" aria-hidden="true" />
              Locate me
            </button>
          )}
          <button className={btnSecondary} onClick={() => void onRefresh()} disabled={loading} aria-label="Refresh tickets">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
          <button className={btnSecondary} onClick={onSignOut}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>

      <div className="mt-8">
        {loading && tickets.length === 0 ? (
          <div className="space-y-3" role="status" aria-label="Loading tickets">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-52 animate-pulse rounded-3xl dg-fill-2" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="glass rounded-3xl px-6 py-16 text-center">
            <span className="dg-float mx-auto grid h-12 w-12 place-items-center rounded-full dg-circle-green">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </span>
            <p className="mt-4 text-lg font-medium dg-fg">All clear</p>
            <p className="mt-1 text-sm dg-fg-2">No pending tickets right now.</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {rows.map(({ t, km }, i) => (
              <li
                key={t.id}
                className="glass dg-rise dg-lift rounded-3xl p-4"
                style={{ animationDelay: `${Math.min(i, 6) * 70}ms` }}
              >
                <div className="flex gap-3 sm:gap-4">
                  <Photo
                    src={t.before_image_url}
                    alt="Reported drain"
                    className="h-20 w-20 shrink-0 rounded-2xl border dg-bd sm:h-24 sm:w-24"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {i === 0 && km != null && (
                        <span className="rounded-full dg-accent-bg px-2 py-1 text-[10px] font-semibold uppercase tracking-wider dg-on-accent">
                          Nearest
                        </span>
                      )}
                      <StatusBadge t={t} />
                    </div>
                    <p className="mt-2 break-words text-[15px] font-medium dg-fg">{t.location}</p>
                    <p className="mt-0.5 line-clamp-2 text-sm dg-fg-2">{t.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs dg-fg-2">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                        {km != null ? `${formatDistance(km)} away` : 'Distance unknown'}
                      </span>
                      <span className="tabular-nums">#{String(t.id)}</span>
                      {formatDate(t.created_at) && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                          {formatDate(t.created_at)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button className={`${btnPrimary} mt-4 w-full`} onClick={() => setActive(t)}>
                  <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 text-center">Upload Cleared Photo &amp; Run AI Audit</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {active && <VerifyModal ticket={active} onClose={() => setActive(null)} onVerified={onVerified} />}
    </div>
  )
}

/* ============================================================
   Public Audit Ledger
   ============================================================ */
// Bento spans: a 2x2 hero tile, then singles and a wide tile, repeating.
const BENTO = ['sm:col-span-2 lg:row-span-2', '', '', 'sm:col-span-2', '', ''] as const

function BentoCard({ t, index, onOpen }: { t: Ticket; index: number; onOpen: () => void }) {
  const hasAfter = Boolean(t.after_image_url)

  return (
    <button
      onClick={onOpen}
      aria-label={`Open ticket ${String(t.id)}: ${t.location}`}
      className={`dg-rise dg-lift group relative block overflow-hidden rounded-3xl border dg-bd dg-media-bg text-left dg-card-shadow ${focusRing} ${BENTO[index % BENTO.length]}`}
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}
    >
      {hasAfter ? (
        <span className="absolute inset-0 grid grid-cols-2 gap-px dg-media-sep">
          <Photo src={t.before_image_url} alt="Before" className="h-full w-full" />
          <Photo src={t.after_image_url} alt="After" className="h-full w-full" />
        </span>
      ) : (
        <Photo src={t.before_image_url} alt="Reported drain" className="absolute inset-0 h-full w-full" />
      )}
      <span className="absolute inset-0 dg-photo-shade" />

      <span className="absolute left-3 top-3">
        <StatusBadge t={t} />
      </span>

      <span className="absolute inset-x-3 bottom-3 block rounded-2xl border dg-bd-2 dg-caption-bg p-3 backdrop-blur-xl">
        <span className="block truncate text-sm font-medium dg-fg">{t.location}</span>
        <span className="mt-0.5 flex items-center justify-between gap-2 text-xs dg-fg-2">
          <span className="min-w-0 truncate">{t.description}</span>
          <span className="shrink-0 tabular-nums">{formatDate(t.created_at) || `#${String(t.id)}`}</span>
        </span>
      </span>
    </button>
  )
}

function TicketDetailModal({ t, onClose }: { t: Ticket; onClose: () => void }) {
  const s = statusOf(t)
  return (
    <Modal onClose={onClose} labelledBy="ticket-title" widthClass="sm:max-w-2xl">
      {() => (
        <div className="p-5 sm:p-7">
          <p className={eyebrowCls}>Ticket #{String(t.id)}</p>
          <h2 id="ticket-title" className="mt-1.5 pr-10 text-xl font-semibold tracking-tight dg-fg">
            {t.location}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <StatusBadge t={t} />
            {formatDate(t.created_at) && <span className="text-xs dg-fg-2">Reported {formatDate(t.created_at)}</span>}
          </div>
          <p className="mt-4 whitespace-pre-line text-sm leading-relaxed dg-fg-2">{t.description}</p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Figure src={t.before_image_url} label="Before: reported" />
            {t.after_image_url ? (
              <Figure src={t.after_image_url} label="After: repaired" />
            ) : (
              <figure>
                <div className="grid aspect-[4/3] place-items-center rounded-2xl border border-dashed dg-bd-3 dg-fill text-xs dg-fg-2">
                  Awaiting repair photo
                </div>
                <figcaption className="mt-1.5 text-xs font-medium dg-fg-2">After: pending</figcaption>
              </figure>
            )}
          </div>

          {s.pct != null && (
            <div className="mt-6 rounded-2xl border dg-bd dg-fill p-5">
              <ConfidenceBar pct={s.pct} statusKey={s.key} />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function LedgerView({
  tickets,
  loading,
  onRefresh,
}: {
  tickets: Ticket[]
  loading: boolean
  onRefresh: () => void | Promise<void>
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<Ticket | null>(null)

  const stats = useMemo(() => {
    const verified = tickets.filter(isCleared).length
    const scores = tickets
      .map((t) => toPercent(t.ai_confidence_score))
      .filter((s): s is number => s != null)
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
    return { total: tickets.length, verified, pending: tickets.length - verified, avg }
  }, [tickets])

  const shown = tickets.filter((t) => filter === 'all' || (filter === 'verified') === isCleared(t))

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'verified', label: 'Verified' },
  ]

  const summary: { label: string; value: string }[] = [
    { label: 'Reports', value: String(stats.total) },
    { label: 'AI-Verified', value: String(stats.verified) },
    { label: 'Pending', value: String(stats.pending) },
    { label: 'Avg. confidence', value: stats.avg != null ? `${stats.avg.toFixed(1)}%` : '—' },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <span className="glass-soft inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium dg-fg">
            <ShieldCheck className="h-3.5 w-3.5 dg-accent" aria-hidden="true" />
            Public record
          </span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight dg-fg sm:text-4xl">Audit Ledger</h1>
          <p className="mt-2 max-w-lg dg-fg-2">Every report, repair and AI verification, in one transparent log.</p>
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div
            role="tablist"
            aria-label="Filter tickets"
            className="glass-soft grid flex-1 grid-cols-3 rounded-full p-1 sm:flex-none"
          >
            {filters.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`min-h-[40px] rounded-full px-3.5 py-1.5 text-sm font-medium transition duration-300 ${focusRing} ${filter === f.key
                  ? 'dg-accent-bg dg-on-accent'
                  : 'dg-fg-2 dg-hover-fg'
                  }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className={`${btnSecondary} !min-h-[48px] !rounded-full !px-3.5`}
            onClick={() => void onRefresh()}
            disabled={loading}
            aria-label="Refresh ledger"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summary.map((s, i) => (
          <div
            key={s.label}
            className="dg-float glass rounded-2xl px-4 py-4 sm:px-5"
            style={{ animationDelay: `-${i * 1.7}s`, animationDuration: `${8 + i}s` }}
          >
            <dt className="text-xs font-medium dg-fg-2">{s.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight dg-fg">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6">
        {loading && tickets.length === 0 ? (
          <div
            className="grid auto-rows-[200px] grid-cols-1 gap-4 sm:auto-rows-[220px] sm:grid-cols-2 lg:grid-cols-4"
            role="status"
            aria-label="Loading ledger"
          >
            {BENTO.map((span, i) => (
              <div key={i} className={`animate-pulse rounded-3xl dg-fill-2 ${span}`} />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="glass rounded-3xl px-6 py-16 text-center">
            <p className="text-lg font-medium dg-fg">No records to show</p>
            <p className="mt-1 text-sm dg-fg-2">
              {tickets.length === 0 ? 'Submit the first report from the Citizen Portal.' : 'No tickets match this filter.'}
            </p>
          </div>
        ) : (
          <div className="grid auto-rows-[200px] grid-flow-dense grid-cols-1 gap-4 sm:auto-rows-[220px] sm:grid-cols-2 lg:grid-cols-4">
            {shown.map((t, i) => (
              <BentoCard key={t.id} t={t} index={i} onOpen={() => setOpen(t)} />
            ))}
          </div>
        )}
      </div>

      {open && <TicketDetailModal t={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

/* ============================================================
   404
   ============================================================ */
function NotFoundView({ go }: { go: Go }) {
  return (
    <div className="mx-auto w-full max-w-lg text-center">
      <div className="glass dg-float rounded-3xl px-6 py-12 sm:px-10">
        <p className="dg-text-aqua text-7xl font-bold tracking-tighter sm:text-8xl">404</p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight dg-fg">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm dg-fg-2">
          This page doesn’t exist, or the drain it pointed to has been rerouted.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <NavLink
            to="/"
            go={go}
            className={`${btnPrimary} hover:-translate-y-0.5 hover:brightness-110`}
          >
            <MapPin className="h-4 w-4" aria-hidden="true" />
            Report a drain
          </NavLink>
          <NavLink to="/ledger" go={go} className={`${btnSecondary} hover:-translate-y-0.5 dg-hover-fill`}>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            View the ledger
          </NavLink>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   Site chrome: header (with mobile menu), footer, toast
   ============================================================ */
const TABS: { key: ViewKey; to: string; label: string; Icon: IconType }[] = [
  { key: 'citizen', to: PATHS.citizen, label: 'Citizen Portal', Icon: MapPin },
  { key: 'worker', to: PATHS.worker, label: 'Worker Terminal', Icon: Lock },
  { key: 'ledger', to: PATHS.ledger, label: 'Ledger', Icon: ShieldCheck },
]

function SiteHeader({
  view,
  authed,
  go,
  theme,
  onToggleTheme,
}: {
  view: ViewKey | null
  authed: boolean
  go: Go
  theme: Theme
  onToggleTheme: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const firstLinkRef = useRef<HTMLDivElement>(null)
  useScrollLock(menuOpen)

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        menuBtnRef.current?.focus()
      }
    }
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => {
      if (mq.matches) setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    mq.addEventListener('change', onChange)
    firstLinkRef.current?.querySelector<HTMLElement>('a')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      mq.removeEventListener('change', onChange)
    }
  }, [menuOpen])

  const activeIndex = TABS.findIndex((t) => t.key === view)

  return (
    <>
      {menuOpen && (
        <div
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
          className="dg-fade-in fixed inset-0 z-30 dg-scrim backdrop-blur-sm md:hidden"
        />
      )}

      <header className="fixed inset-x-0 top-0 z-40 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
        <div className="relative mx-auto max-w-6xl">
          <div className="glass flex items-center justify-between gap-2 rounded-full py-2 pl-2.5 pr-2 sm:pl-3">
            <NavLink
              to="/"
              go={go}
              onNavigate={() => setMenuOpen(false)}
              className={`flex min-h-[44px] min-w-0 items-center gap-2.5 rounded-full pr-2 ${focusRing}`}
            >
              <LogoMark />
              <span className="flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold tracking-tight dg-fg">DrainGRID</span>
                <span className="rounded border dg-bd-3 px-1 py-px text-[10px] font-semibold tracking-wide dg-accent">
                  AI
                </span>
              </span>
            </NavLink>

            {/* Desktop: floating pill with a sliding indicator */}
            <nav
              aria-label="Primary"
              className="relative hidden w-[26rem] shrink-0 grid-cols-3 rounded-full border dg-bd dg-fill p-1 md:grid"
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-1 left-1 rounded-full dg-accent-bg transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${view ? 'opacity-100' : 'opacity-0'
                  }`}
                style={{
                  width: 'calc((100% - 0.5rem) / 3)',
                  transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
                }}
              />
              {TABS.map(({ key, to, label, Icon }) => {
                const active = view === key
                return (
                  <NavLink
                    key={key}
                    to={to}
                    go={go}
                    current={active}
                    className={`relative z-10 flex min-h-[40px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[13px] font-medium transition-colors duration-300 active:scale-[0.97] ${focusRing} ${active ? 'dg-on-accent' : 'dg-fg-2 dg-hover-fg'
                      }`}
                  >
                    {label}
                    {key === 'worker' && (
                      <span className="relative">
                        <Icon className="h-3 w-3 opacity-80" aria-hidden="true" />
                        {authed && (
                          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-[color:var(--dg-page)]" />
                        )}
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </nav>

            {/* Desktop: theme switch (the mobile drawer has its own) */}
            <ThemeToggle theme={theme} onToggle={onToggleTheme} className="hidden md:grid" />

            {/* Mobile: menu button */}
            <button
              ref={menuBtnRef}
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen((o) => !o)}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border dg-bd-2 dg-fill-2 dg-fg transition active:scale-95 md:hidden ${focusRing}`}
            >
              {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
          </div>

          {menuOpen && (
            <div
              id="mobile-menu"
              ref={firstLinkRef}
              className="glass-strong dg-modal-in absolute inset-x-0 top-[calc(100%+0.5rem)] rounded-3xl p-2 md:hidden"
            >
              <nav aria-label="Mobile">
                <ul className="space-y-1">
                  {TABS.map(({ key, to, label, Icon }) => {
                    const active = view === key
                    return (
                      <li key={key}>
                        <NavLink
                          to={to}
                          go={go}
                          current={active}
                          onNavigate={() => setMenuOpen(false)}
                          className={`flex min-h-[52px] items-center gap-3 rounded-2xl px-4 text-[15px] font-medium transition ${focusRing} ${active
                            ? 'dg-accent-bg dg-on-accent'
                            : 'dg-fg dg-hover-fill'
                            }`}
                        >
                          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                          <span className="flex-1">{label}</span>
                          {key === 'worker' && authed && (
                            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-label="Signed in" />
                          )}
                          <ArrowRight className="h-4 w-4 opacity-60" aria-hidden="true" />
                        </NavLink>
                      </li>
                    )
                  })}
                </ul>
              </nav>
              <div className="mt-2 border-t dg-bd pt-2">
                <ThemeToggle theme={theme} onToggle={onToggleTheme} variant="row" />
              </div>
              {hasContact && (
                <div className="mt-2 border-t dg-bd px-2 pt-2">
                  <ContactLinks />
                </div>
              )}
            </div>
          )}
        </div>
      </header>
    </>
  )
}

function SiteFooter({ view, go }: { view: ViewKey | null; go: Go }) {
  return (
    <footer className="relative z-10 px-4 pb-10 pt-6 sm:px-6">
      <div className="glass-soft mx-auto grid max-w-6xl gap-8 rounded-3xl p-6 sm:grid-cols-3 sm:p-8">
        <div>
          <NavLink to="/" go={go} className={`inline-flex min-h-[44px] items-center gap-2.5 rounded-xl ${focusRing}`}>
            <LogoMark className="h-8 w-8" />
            <span className="text-[15px] font-semibold tracking-tight dg-fg">DrainGRID</span>
          </NavLink>
          <p className="mt-2 max-w-xs text-sm dg-fg-2">
            Citizen-powered drainage reporting, verified by AI and published in an open ledger.
          </p>
        </div>

        <nav aria-label="Footer">
          <h2 className={eyebrowCls}>Explore</h2>
          <ul className="mt-2">
            {TABS.map(({ key, to, label }) => (
              <li key={key}>
                <NavLink
                  to={to}
                  go={go}
                  current={view === key}
                  className={`inline-flex min-h-[44px] items-center rounded-xl text-sm transition dg-hover-fg ${focusRing} ${view === key ? 'font-medium dg-fg' : 'dg-fg-2'
                    }`}
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className={eyebrowCls}>{hasContact ? 'Contact' : 'Safety'}</h2>
          {hasContact && <ContactLinks className="mt-2" />}
          <p className="mt-3 text-sm dg-fg-2">
            For urgent flooding or a safety hazard, call your local emergency services instead of using this form.
          </p>
        </div>
      </div>
      <p className="mx-auto mt-6 max-w-6xl text-center text-xs dg-fg-3">
        © {new Date().getFullYear()} DrainGRID AI
      </p>
    </footer>
  )
}

/* ============================================================
   App
   ============================================================ */

/* ============================================================
   iOS 26 ConcentricRectangle & Interactive BLR Triage Wrapper
   ============================================================ */
function ConcentricRectangle({
  outerRadius = 24,
  padding = 8,
  className = '',
  innerClassName = '',
  children,
}: {
  outerRadius?: number
  padding?: number
  className?: string
  innerClassName?: string
  children: ReactNode
}) {
  const innerRadius = Math.max(6, outerRadius - padding)
  return (
    <div
      style={{ borderRadius: `${outerRadius}px`, padding: `${padding}px` }}
      className={`glass ${className}`}
    >
      <div
        style={{ borderRadius: `${innerRadius}px` }}
        className={`border dg-bd-2 dg-inner ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  )
}

function InteractiveWorkerSection(props: any) {
  const [alertFilter, setAlertFilter] = useState<'ALL' | 'RED' | 'AMBER' | 'GREEN'>('ALL')
  const [areaFilter, setAreaFilter] = useState<string>('ALL')

  const enrichedTickets = useMemo(() => {
    return (props.tickets || []).map((t: any) => {
      const intensity = typeof t.clog_intensity === 'number' ? t.clog_intensity : 65
      const alert =
        t.status === 'VERIFIED_RESOLVED' || t.ai_confidence_score != null
          ? 'GREEN'
          : t.alert_level || (intensity >= 75 ? 'RED' : intensity >= 40 ? 'AMBER' : 'GREEN')
      const area = t.area || 'Central Bengaluru'
      return { ...t, clog_intensity: intensity, alert_level: alert, area }
    }).sort((a: any, b: any) => b.clog_intensity - a.clog_intensity)
  }, [props.tickets])

  const areas = useMemo(() => {
    const unique = Array.from(new Set(enrichedTickets.map((t: any) => t.area))) as string[]
    return ['ALL', ...unique]
  }, [enrichedTickets])

  const counts = useMemo(() => ({
    RED: enrichedTickets.filter((t: any) => t.alert_level === 'RED').length,
    AMBER: enrichedTickets.filter((t: any) => t.alert_level === 'AMBER').length,
    GREEN: enrichedTickets.filter((t: any) => t.alert_level === 'GREEN').length,
  }), [enrichedTickets])

  const filteredTickets = useMemo(() => {
    return enrichedTickets.filter(
      (t: any) =>
        (alertFilter === 'ALL' || t.alert_level === alertFilter) &&
        (areaFilter === 'ALL' || t.area === areaFilter)
    )
  }, [enrichedTickets, alertFilter, areaFilter])

  return (
    <div className="space-y-6">
      {props.authed && (
        <ConcentricRectangle outerRadius={26} padding={8} innerClassName="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold dg-accent">
                <Sparkles className="h-3.5 w-3.5" />
                <span>AI Clog Intensity & Bengaluru Zone Triage</span>
                <span className="dg-chip-green rounded-full px-2 py-0.5 text-[11px]">
                  Gatekeeper & Anti-Breach Active
                </span>
              </div>
              <p className="mt-1 text-xs dg-fg-2">
                Click any Alert Level or Bengaluru Area below to filter the live verification queue.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setAlertFilter('ALL')}
                data-active={alertFilter === 'ALL'}
                aria-pressed={alertFilter === 'ALL'}
                className="dg-alert dg-alert--all rounded-xl px-3 py-1.5 text-xs font-semibold"
              >
                All ({enrichedTickets.length})
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter('RED')}
                data-active={alertFilter === 'RED'}
                aria-pressed={alertFilter === 'RED'}
                className="dg-alert dg-alert--red flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold"
              >
                <span className="h-2 w-2 rounded-full bg-current animate-ping" />
                RED ≥75% ({counts.RED})
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter('AMBER')}
                data-active={alertFilter === 'AMBER'}
                aria-pressed={alertFilter === 'AMBER'}
                className="dg-alert dg-alert--amber flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold"
              >
                <span className="h-2 w-2 rounded-full bg-current" />
                AMBER 40–74% ({counts.AMBER})
              </button>
              <button
                type="button"
                onClick={() => setAlertFilter('GREEN')}
                data-active={alertFilter === 'GREEN'}
                aria-pressed={alertFilter === 'GREEN'}
                className="dg-alert dg-alert--green flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold"
              >
                <span className="h-2 w-2 rounded-full bg-current" />
                GREEN &lt;40% / Clear ({counts.GREEN})
              </button>
            </div>
          </div>

          {areas.length > 1 && (
            <div className="mt-3 flex items-center gap-2 overflow-x-auto pt-2 border-t dg-bd">
              <span className="text-[11px] font-semibold uppercase tracking-wider dg-fg-3 shrink-0">
                Bengaluru Area:
              </span>
              {areas.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAreaFilter(a)}
                  data-active={areaFilter === a}
                  aria-pressed={areaFilter === a}
                  className="dg-area-chip shrink-0 rounded-full px-3 py-1 text-xs font-medium"
                >
                  {a === 'ALL' ? 'All BLR Areas' : a}
                </button>
              ))}
            </div>
          )}
        </ConcentricRectangle>
      )}

      <WorkerView {...props} tickets={filteredTickets} />
    </div>
  )
}

export default function App() {
  const { path, go } = usePath()
  const view = viewForPath(path)
  const { theme, toggleTheme } = useTheme()

  const [authed, setAuthed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1'
    } catch {
      return false
    }
  })
  const geo = useGeolocation()
  const { tickets, loading, error, refresh, upsert } = useTickets()

  const [toast, setToast] = useState<{ id: number; message: string; tone: Tone } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback<Notify>((message, tone = 'success') => {
    setToast({ id: Date.now(), message, tone })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4200)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // Per-page title and description
  useEffect(() => {
    const meta = PAGE_META[view ?? 'notfound']
    document.title = meta.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description)
  }, [view])

  function signIn() {
    try {
      sessionStorage.setItem(SESSION_KEY, '1')
    } catch {
      // storage unavailable; the session lasts until reload
    }
    setAuthed(true)
    notify('Terminal unlocked')
  }

  function signOut() {
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // ignore
    }
    setAuthed(false)
    go('/')
    notify('Signed out')
  }

  return (
    <ThemeContext.Provider value={theme}>
    <div className="relative min-h-[100dvh] overflow-x-clip dg-fg">
      <a
        href="#main"
        className="dg-skip sr-only z-[70] rounded-full px-4 py-2 text-sm font-semibold focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      <Backdrop />
      <SiteHeader view={view} authed={authed} go={go} theme={theme} onToggleTheme={toggleTheme} />

      <div className="relative z-10 px-4 pb-6 pt-[6.5rem] sm:px-6 sm:pt-32">
        {error && (view === 'worker' || view === 'ledger') && (
          <div
            role="alert"
            className="mx-auto mb-6 flex max-w-3xl items-start gap-3 rounded-2xl dg-note dg-note--red p-3.5 text-sm backdrop-blur-xl"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">{error}</p>
            <button
              className={`shrink-0 rounded font-semibold underline underline-offset-2 ${focusRing}`}
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        )}

        <main id="main" tabIndex={-1} key={view ?? 'notfound'} className="dg-rise outline-none">
          {view === 'citizen' && <CitizenView geo={geo} onCreated={refresh} notify={notify} />}
          {view === 'worker' && (
            <InteractiveWorkerSection
              authed={authed}
              tickets={tickets}
              loading={loading}
              geo={geo}
              onRefresh={refresh}
              onVerified={upsert}
              onUnlock={signIn}
              onCancelLogin={() => go('/')}
              onSignOut={signOut}
            />
          )}
          {view === 'ledger' && <LedgerView tickets={tickets} loading={loading} onRefresh={refresh} />}
          {view === null && <NotFoundView go={go} />}
        </main>
      </div>

      {!(view === 'worker' && !authed) && <SiteFooter view={view} go={go} />}

      {/* Toast (the live region stays mounted so screen readers announce changes) */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        {toast && (
          <div
            key={toast.id}
            className="glass-strong dg-toast-in pointer-events-auto flex max-w-md items-center gap-2.5 rounded-full px-4 py-2.5 text-sm dg-fg"
          >
            {toast.tone === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 dg-tone-green" aria-hidden="true" />
            ) : (
              <TriangleAlert className="h-4 w-4 shrink-0 dg-tone-red" aria-hidden="true" />
            )}
            <span className="min-w-0">{toast.message}</span>
          </div>
        )}
      </div>
    </div>
    </ThemeContext.Provider>
  )
}
