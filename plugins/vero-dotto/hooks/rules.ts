import type { BandItem, Meta, Stats } from '../types'

// VeroDotto's rules, pure: no `$`, tested by tests/rules.test.ts. What is converted, what
// is kept, how a saving is judged and shown, where paths hide in a prompt.

// The formats converted, as the system note names them and classify() reads them.
export const CONVERTED = [
  '.docx', '.xlsx', '.xls', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf',
  '.epub', '.html', '.htm', '.msg', '.eml',
] as const
// Binary Word 97: no pure-Python converter; kept, and the band says to save as .docx.
export const LEGACY = ['.doc'] as const

export type Classified = 'convert' | 'keep' | 'doc'

export const extOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function classify(path: string): Classified {
  const ext = extOf(path)
  if ((CONVERTED as readonly string[]).includes(ext)) return 'convert'
  if ((LEGACY as readonly string[]).includes(ext)) return 'doc'
  return 'keep'
}

// A PDF read with `pages` asks for page images: never redirected.
export const isPageRead = (path: string, pages: unknown) =>
  extOf(path) === '.pdf' && typeof pages === 'string' && pages.trim() !== ''

// --- options ---------------------------------------------------------------------------

export type Config = {
  autoSetup: boolean
  minSavingPercent: number
  maxFileMb: number
  maxSheetCells: number
  maxSheetRows: number
  maxTokens: number
  bandForReads: boolean
  bandSeconds: number
  cacheDays: number
  cacheMaxMb: number
  convertTimeoutSec: number
}

export const DEFAULTS: Config = {
  autoSetup: true,
  minSavingPercent: 10,
  maxFileMb: 100,
  maxSheetCells: 5000,
  maxSheetRows: 20,
  maxTokens: 50000,
  bandForReads: true,
  bandSeconds: 120,
  cacheDays: 10,
  cacheMaxMb: 100,
  convertTimeoutSec: 100,
}

// The options as register() receives them, each checked: a value of the wrong kind or out
// of range falls back to its default rather than breaking a read.
export function configOf(options: Readonly<Record<string, unknown>> = {}): Config {
  const num = (key: keyof Config, min: number, max: number) => {
    const v = options[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : (DEFAULTS[key] as number)
  }
  const bool = (key: keyof Config) => (typeof options[key] === 'boolean' ? (options[key] as boolean) : (DEFAULTS[key] as boolean))
  return {
    autoSetup: bool('autoSetup'),
    minSavingPercent: num('minSavingPercent', 0, 100),
    maxFileMb: num('maxFileMb', 1, 100_000),
    maxSheetCells: Math.round(num('maxSheetCells', 1, 10_000_000)),
    maxSheetRows: Math.round(num('maxSheetRows', 1, 10_000)),
    maxTokens: Math.round(num('maxTokens', 100, 10_000_000)),
    bandForReads: bool('bandForReads'),
    bandSeconds: num('bandSeconds', 0, 3600),
    cacheDays: num('cacheDays', 1, 3650),
    cacheMaxMb: num('cacheMaxMb', 1, 1_000_000),
    convertTimeoutSec: num('convertTimeoutSec', 5, 590),
  }
}

// The options that differ from their defaults, for `/vero-dotto`.
export const changedOptions = (cfg: Config) =>
  (Object.keys(DEFAULTS) as (keyof Config)[]).filter(key => cfg[key] !== DEFAULTS[key]).map(key => `${key} = ${String(cfg[key])}`)

// --- estimates -------------------------------------------------------------------------

// Characters / 4 for mostly-Latin text, / 3 when over 30% of the letters are not Latin
// (Cyrillic, CJK, ...). The same rule as convert.py's.
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let letters = 0
  let nonLatin = 0
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) {
      letters++
      if ((ch.codePointAt(0) ?? 0) > 0x24f) nonLatin++
    }
  }
  const divisor = letters > 0 && nonLatin / letters > 0.3 ? 3 : 4
  return Math.ceil([...text].length / divisor)
}

// 1 - md / original, in whole percent; never negative, never with a decimal.
export function savingPercent(mdTokens: number, origTokens: number): number {
  if (origTokens <= 0) return 0
  return Math.max(0, Math.round((1 - mdTokens / origTokens) * 100))
}

// 850, 4.2k, 31k, 1.2M.
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// --- the decision ----------------------------------------------------------------------

export type Decision = { serve: true } | { serve: false; reason: 'small-saving' | 'little-text' | 'empty' }

// Whether the markdown is read in place of the original.
export function decide(meta: Meta, minSavingPercent: number): Decision {
  if (meta.keep === 'little-text') return { serve: false, reason: 'little-text' }
  if (meta.keep === 'empty') return { serve: false, reason: 'empty' }
  // A summary is never "kept": the original is too large to read whole anyway.
  if (meta.kind === 'summary') return { serve: true }
  if (savingPercent(meta.mdTokens, meta.origTokens) < minSavingPercent) return { serve: false, reason: 'small-saving' }
  return { serve: true }
}

// What `verodotto.sh convert` prints: the conversion's folder TAB cached|new, then meta.
export type Converted = { docDir: string; isCached: boolean; meta: Meta }

export function parseConverted(stdout: string): Converted | undefined {
  const [head = '', ...rest] = stdout.replace(/\r/g, '').split('\n')
  const [docDir = '', state = ''] = head.split('\t')
  if (docDir === '' || (state !== 'cached' && state !== 'new')) return undefined
  try {
    const meta = JSON.parse(rest.join('\n')) as Meta
    if (typeof meta.mdTokens !== 'number' || typeof meta.origTokens !== 'number') return undefined
    return { docDir, isCached: state === 'cached', meta: { ...meta, lost: Array.isArray(meta.lost) ? meta.lost : [] } }
  } catch {
    return undefined
  }
}

export const mdPathOf = (docDir: string) => `${docDir}/doc.md`

// --- what the model reads --------------------------------------------------------------

// The system note (prompt.compose): once per session, generated from CONVERTED so it
// always matches what is converted. Kept short: it is paid on every request.
export function systemNote(): string {
  return [
    `Documents (${CONVERTED.filter(ext => ext !== '.htm').join(' ')}): open them with the Read tool.`,
    'VeroDotto converts them to markdown automatically. Do not unzip them or parse them with',
    'scripts unless you need something markdown cannot hold (embedded images, formulas, exact layout).',
  ].join(' ')
}

export function lostText(lost: readonly string[]): string {
  return lost.length === 0 ? 'none detected beyond formatting and layout' : lost.join(', ')
}

// What the model reads beside a converted file. Never claims nothing was lost.
export function convertedContext(original: string, meta: Meta): string {
  const what = meta.kind === 'summary' ? 'summarised as markdown (too large to read whole)' : 'converted to markdown'
  return (
    `${original} was ${what} by VeroDotto (${meta.converter}); what you read is that markdown, from the VeroDotto cache. ` +
    `Lost: ${lostText(meta.lost)}. ` +
    `The original is at ${original} if you need what was lost.`
  )
}

export function siblingContext(original: string, sibling: string, isStale: boolean): string {
  // stale: read only where no fresh conversion could be made (converters not ready, the
  // file too large); the model is not to convert the original by hand
  const stale = isStale
    ? ' The original changed since this copy was saved, and VeroDotto could not convert it now. ' +
      'Do not convert the original yourself; say the copy may be out of date.'
    : ''
  return `This is the hand-kept markdown of ${original} (${sibling}), read by VeroDotto in its place.${stale}`
}

// Beside a fresh conversion read in place of a hand-kept copy whose original changed.
export const staleCopyContext = (copy: string) =>
  `A hand-kept markdown copy, ${copy}, is older than the original and was not used; the person can update it from the band.`

export const plainPathContext = (shown: string) => `${shown} is available as markdown through Read (VeroDotto).`

export const bashNudge = (shown: string) => `Note: \`Read ${shown}\` gives clean markdown via VeroDotto.`

// A shell command that parses a document by hand.
const PARSERS = ['unzip', 'python', 'python3', 'pandoc', 'textutil', 'strings', 'libreoffice', 'soffice', 'docx2txt', 'pdftotext']

export function isParserCommand(command: string): boolean {
  return command.split(/[\s;&|()]+/).some(word => PARSERS.includes(word.split('/').pop() ?? ''))
}

// --- the band ----------------------------------------------------------------------------

// ⚠ is drawn wider than the one cell a terminal gives it and covers the space after it,
// so it is always followed by two.
export const WARN = '\u26a0  '
// ⏸ the same
export const PAUSE = '\u23f8  '

// The band says as little as it can; the model's note and `/vero-dotto show` have the rest.
const KEPT_WHY: Record<NonNullable<BandItem['reason']>, string> = {
  'small-saving': 'kept as is',
  'little-text': 'kept as is: scan or drawings',
  empty: 'kept as is: no text',
  doc: 'kept as is: save as .docx to convert',
  preparing: 'read as is: converters preparing',
  'not-ready': 'read as is: converters not set up',
  failed: 'read as is: conversion failed',
  'too-large': 'skipped: too large',
}

// 0:07, 1:41, 12:03.
export const formatElapsed = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

// The band's row while setup runs: what it is, the step the script reported, the time.
// No step: another session runs the setup and this one waits for its marker.
export function setupLine(step: string, elapsed: number): string {
  const head = '\u23f3 one-time setup (~240 MB into ~/.cache/verodotto) \u00b7 '
  if (step === '') return `${head}another Claude Code session is running it`
  return `${head}${step} \u00b7 ${formatElapsed(elapsed)}`
}

// 150, 12.5, 0.4: a size in MB, one decimal only below 100.
export const formatMb = (mb: number) => (mb >= 100 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10))

export const tooLargeText = (name: string, sizeMb: number, limitMb: number) =>
  `${name} skipped: ${formatMb(sizeMb)} MB > ${formatMb(limitMb)} MB limit`

function keptText(item: BandItem): string {
  if (item.reason === 'too-large') return tooLargeText(item.name, item.sizeMb ?? 0, item.limitMb ?? 0)
  if (item.reason === 'small-saving') {
    return `${item.name} kept as is (saving only ≈ ${item.saving ?? 0}%)`
  }
  return `${item.name} ${KEPT_WHY[item.reason ?? 'failed']}`
}

function costText(md: number, orig: number): string {
  return `≈ ${formatTokens(md)} vs ${formatTokens(orig)} tokens (−${savingPercent(md, orig)}%)`
}

// What markdown cannot hold, in the band: the noun alone (`1 formula`, `2 images`), its
// explanation left to the model's note - `1 formula with no saved result (formula shown)`.
export const shortLost = (lost: string) => lost.replace(/ \(.*\)$/, '').replace(/ with .*$/, '').replace(/^rows past .*/, 'rows (summary)')

// The band's line for the files of the last prompt, after its dim `VeroDotto` label.
export function bandLine(items: readonly BandItem[]): string {
  if (items.length === 0) return ''
  const served = items.filter(item => item.state === 'converted')
  const siblings = items.filter(item => item.state === 'sibling')
  const kept = items.filter(item => item.state === 'kept')
  const pending = items.filter(item => item.state === 'pending')
  const unchanged = items.filter(item => item.state === 'unchanged')
  const parts: string[] = []

  if (items.length === 1) {
    const [item] = items
    if (!item) return ''
    if (item.state === 'converted') {
      const copy = item.hasStaleCopy ? ` · ${WARN}${item.name}.md older, not used` : ''
      const lost = (item.lost && item.lost.length > 0 ? ` · lost: ${item.lost.map(shortLost).join(', ')}` : '') + copy
      return `${item.name} → markdown · ${costText(item.mdTokens ?? 0, item.origTokens ?? 0)}${lost}`
    }
    if (item.state === 'sibling') {
      const stale = item.isStale ? ` · ${WARN}original changed since` : ''
      return `${item.name} → your ${item.name}.md${stale}`
    }
    if (item.state === 'pending') return `${item.name}: converting…`
    if (item.state === 'unchanged') return `${item.name} already read, nothing sent`
    return keptText(item)
  }

  if (served.length > 0) {
    const md = served.reduce((sum, item) => sum + (item.mdTokens ?? 0), 0)
    const orig = served.reduce((sum, item) => sum + (item.origTokens ?? 0), 0)
    const files = served.length === 1 ? served[0]?.name ?? '1 file' : `${served.length} files`
    parts.push(`${files} → markdown · ${costText(md, orig)}`)
  }
  for (const item of siblings) parts.push(`${item.name} → your .md${item.isStale ? ` (${WARN}original changed)` : ''}`)
  for (const item of kept) parts.push(keptText(item))
  if (unchanged.length > 0) parts.push(`${unchanged.map(item => item.name).join(', ')} already read`)
  if (pending.length > 0) parts.push(`${pending.length === 1 ? pending[0]?.name : `${pending.length} files`} converting…`)
  return parts.join(' · ')
}

// The one file the band's button is for: a single converted file not saved yet - Save
// markdown next to original, or Update <name>.md where a hand-kept copy is older than the
// original - also when the model already held it and nothing was sent again.
export function saveable(items: readonly BandItem[]): BandItem | undefined {
  const [only] = items
  if (items.length !== 1 || !only || only.isSaved) return undefined
  return (only.state === 'converted' || only.state === 'unchanged') && only.docDir ? only : undefined
}

// --- stats -----------------------------------------------------------------------------

export const EMPTY_STATS: Stats = { conversions: 0, reads: 0, saved: 0, kept: 0, byFormat: {} }

export function addRead(stats: Stats, ext: string, saved: number, isNew: boolean): Stats {
  const format = stats.byFormat[ext] ?? { reads: 0, saved: 0 }
  return {
    ...stats,
    conversions: stats.conversions + (isNew ? 1 : 0),
    reads: stats.reads + 1,
    saved: stats.saved + saved,
    byFormat: { ...stats.byFormat, [ext]: { reads: format.reads + 1, saved: format.saved + saved } },
  }
}

export const addKept = (stats: Stats): Stats => ({ ...stats, kept: stats.kept + 1 })

export function statsText(title: string, stats: Stats): string {
  const lines = [
    `**${title}**: ${stats.reads} ${stats.reads === 1 ? 'read' : 'reads'} served as markdown ` +
      `(${stats.conversions} new ${stats.conversions === 1 ? 'conversion' : 'conversions'}), ` +
      `≈ ${formatTokens(stats.saved)} tokens saved (est.), ${stats.kept} kept as original`,
  ]
  const formats = Object.entries(stats.byFormat).sort((a, b) => b[1].saved - a[1].saved)
  for (const [ext, f] of formats) lines.push(`- ${ext}: ${f.reads} ${f.reads === 1 ? 'read' : 'reads'}, ≈ ${formatTokens(f.saved)} saved`)
  return lines.join('\n')
}

// --- paths -----------------------------------------------------------------------------

const EXT_RE = new RegExp(`\\.(${CONVERTED.map(ext => ext.slice(1)).join('|')})$`, 'i')
const TRAIL = /[.,;:!?)\]}>"'»`]+$/
const LEAD = /^[([{<"'«`]+/

function cleanCandidate(raw: string): string | undefined {
  let path = raw.trim()
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(localhost)?/i, '')
    try {
      path = decodeURIComponent(path)
    } catch {
      return undefined
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  }
  // a URL of any other scheme is a link, not a file
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return undefined
  path = path.replace(TRAIL, '')
  if (path === '' || path.length > 1024 || /[\n\0]/.test(path)) return undefined
  if (path.startsWith('@')) return undefined
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || !EXT_RE.test(name)) return undefined
  return path
}

// The paths of documents a text names: quoted, bare, Windows, `~`, file://, Markdown
// links. Fenced code (pasted output, not a request) and `@` mentions (prompt.mention's)
// are left out. False positives are cheap: nothing reaches the model unless the file
// exists, which the caller checks.
export function findPaths(text: string): string[] {
  const found: string[] = []
  const add = (raw: string) => {
    const path = cleanCandidate(raw)
    if (path !== undefined && !found.includes(path)) found.push(path)
  }
  let rest = text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1 ')

  // [text](path)
  rest = rest.replace(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, target: string) => {
    add(target)
    return ' '
  })
  // quoted spans, spaces allowed inside; a single quote only where it is not an apostrophe
  const quoted = [
    /"([^"\n]+)"/g,
    /`([^`\n]+)`/g,
    /«([^»\n]+)»/g,
    /(?<=^|[\s([{])'([^'\n]+)'(?=$|[\s.,;:!?)\]}])/g,
  ]
  for (const re of quoted) {
    rest = rest.replace(re, (whole: string, inner: string) => {
      if (cleanCandidate(inner) === undefined) return whole
      add(inner)
      return ' '
    })
  }
  for (const token of rest.split(/\s+/)) {
    if (token === '' || token.startsWith('@')) continue
    add(token.replace(LEAD, ''))
  }
  return found
}

// The `@` mentions of a prompt, as typed after the `@` (prompt.mention handles those).
export function mentionsOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|\s)@("([^"]+)"|\S+)/g)) {
    const raw = (m[2] ?? m[1] ?? '').replace(/#L\d+(-\d+)?$/, '').replace(TRAIL, '')
    if (raw !== '') out.push(raw)
  }
  return out
}

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

// A path from a prompt made absolute against the session's folder: `~` is the home
// folder, `.` and `..` are folded. A Windows drive path stays as written in a Windows
// session; in a POSIX session (WSL) it is read under the drive's mount, `/mnt/c/...`.
export function resolvePath(root: string, home: string, path: string): string {
  let full = path
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) full = home + path.slice(1)
  else if (!isAbsolute(path)) full = `${root.replace(/[\\/]+$/, '')}/${path}`
  const isWindows = /^[A-Za-z]:[\\/]/.test(full) || full.startsWith('\\\\')
  const sep = isWindows ? '\\' : '/'
  const lead = full.startsWith('\\\\') ? '\\\\' : full.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of full.slice(lead.length).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > (isWindows && !lead ? 1 : 0)) parts.pop()
      continue
    }
    parts.push(part)
  }
  const resolved = lead + parts.join(sep)
  const drive = /^([A-Za-z]):\\(.*)$/.exec(resolved)
  if (drive !== null && root.startsWith('/')) return `/mnt/${drive[1].toLowerCase()}/${drive[2].split('\\').join('/')}`
  return resolved
}

// --- safety ----------------------------------------------------------------------------

// Purge deletes only a cache directory VeroDotto made: an absolute path named verodotto,
// never `/`, a home folder or what an empty variable would leave. (verodotto.sh also
// accepts a VERODOTTO_DIR holding its marker; the module asks the script.)
export function isCacheDir(path: string, home: string): boolean {
  const clean = path.replace(/[\\/]+$/, '')
  if (!isAbsolute(clean) || clean === '' || clean === home.replace(/[\\/]+$/, '')) return false
  return /[\\/]verodotto$/.test(clean)
}

// A markdown fence one backtick longer than any run inside the text.
export function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(longest + 1)
}

// Setup back-off after failures: 1 h, 6 h, then a day.
export function retryAfterMs(failures: number): number {
  const hour = 60 * 60 * 1000
  if (failures <= 0) return 0
  if (failures === 1) return hour
  if (failures === 2) return 6 * hour
  return 24 * hour
}
