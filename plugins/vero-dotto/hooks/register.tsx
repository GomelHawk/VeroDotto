import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandItem, Meta, Stats, View } from '../types'

// A band item before showInBand stamps it with the time and the prompt.
type BandDraft = Omit<BandItem, 'at' | 'prompt'>
import {
  CONVERTED,
  EMPTY_STATS,
  addKept,
  addRead,
  bandLine,
  bashNudge,
  baseName,
  changedOptions,
  classify,
  configOf,
  convertedContext,
  decide,
  fenceFor,
  findPaths,
  formatTokens,
  isCacheDir,
  isPageRead,
  isParserCommand,
  lostText,
  mdPathOf,
  mentionsOf,
  parseConverted,
  plainPathContext,
  resolvePath,
  retryAfterMs,
  savingPercent,
  saveable,
  siblingContext,
  statsText,
  PAUSE,
  WARN,
  formatMb,
  setupLine,
  staleCopyContext,
  systemNote,
} from './rules'
import type { Config, Converted } from './rules'
import {
  MOVE_LABELS,
  REMOVE_LABELS,
  REPLACE_NO,
  REPLACE_QUESTION,
  REPLACE_YES,
  RESTART_NOTE,
  fillRefusedToast,
  legacyBand,
  legacyCopies,
  legacyMarkdown,
  legacyToast,
  moveSteps,
  removeSteps,
  sourceOf,
  stoppedBand,
  stoppedMarkdown,
  stoppedToast,
} from './source-check'
import type { LegacyCopy, ScopeSettings, Source } from './source-check'

// VeroDotto: documents Claude cannot read well - Word, Excel, PowerPoint, PDF,
// OpenDocument, HTML, EPUB, e-mail - reach it as clean markdown. A mention, a path
// written in the prompt or the model's own Read is converted once (scripts/verodotto.sh,
// scripts/convert.py), cached in ~/.cache/verodotto, and the saving is shown in a band.
// Anything that fails passes the original file through, as if VeroDotto were not there.

const PLUGIN = 'vero-dotto'
const DISPLAY = 'VeroDotto'
// What the move leaves in place, named in the stopped message.
const KEEPS = "VeroDotto's converters and converted documents live in ~/.cache/verodotto"
const NOTE_ID = 'vero-dotto:documents'
// $.store keys, across sessions.
const PRUNED_AT_KEY = 'prunedAt'
const SETUP_FAILED_AT_KEY = 'setupFailedAt'
const SETUP_FAILURES_KEY = 'setupFailures'
const NOTICE_SHOWN_KEY = 'noticeShown'
const ALL_TIME_KEY = 'allTime'
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
const SETUP_TIMEOUT_MS = 600_000
const QUICK_TIMEOUT_MS = 20_000
// Paths written in one prompt that are looked at; past it, the rest are left alone.
const MAX_PLAIN_PATHS = 10
const SHOW_LINES = 40

const INITIAL: View = {
  ready: 'unknown',
  failReason: '',
  lastTurn: [],
  confirmingSave: '',
  toldAbout: [],
  session: EMPTY_STATS,
  source: { kind: 'dev' },
  confirmingFill: '',
  isPaused: false,
  isBandStale: false,
  prompts: 0,
  setupStep: '',
  setupElapsed: 0,
  isSetupNoteHidden: false,
}
const view = atom({ plugin: 'vero-dotto', key: 'view' } as const, INITIAL)
const patch = ($: EngineInterface, fields: Partial<View>) => update($, view, cur => ({ ...cur, ...fields }))

// The one way into verodotto.sh. On Windows Claude Code runs Git Bash, which may not be on
// PATH: CLAUDE_CODE_GIT_BASH_PATH names it when set.
async function bashPath($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CODE_GIT_BASH_PATH').catch(() => undefined)) || 'bash'
}

async function script($: EngineInterface, args: string[], timeoutMs = QUICK_TIMEOUT_MS) {
  return $.process.run([await bashPath($), `${$.plugin.root}/scripts/verodotto.sh`, ...args], {
    cwd: await $.session.root(),
    timeoutMs,
  })
}

async function homeOf($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
}

// --- the source check ----------------------------------------------------------------

// Where this copy came from, and whether an older copy of it is still enabled. The path
// decides (hooks/source-check.ts); a development copy may be re-pointed through
// VERO_TEST_ROOT, the test seam - only a dev copy consults it, so no installed copy can
// opt out through it. A home copy then reads each scope's settings for an old copy.
async function checkSource($: EngineInterface): Promise<{ source: Source; legacy?: LegacyCopy }> {
  try {
    let source = sourceOf($.plugin.root)
    if (source.kind === 'dev') {
      const testRoot = await $.env.get('VERO_TEST_ROOT').catch(() => undefined)
      if (testRoot) source = sourceOf(testRoot)
    }
    if (source.kind !== 'home') return { source }
    const sources: ScopeSettings[] = []
    for (const scope of ['user', 'project', 'local'] as const) {
      sources.push({ scope, settings: await $.settings.read({ source: scope }).catch(() => undefined) })
    }
    return { source, legacy: legacyCopies(PLUGIN, sources)[0] }
  } catch {
    return { source: { kind: 'dev' } }
  }
}

function isStopped(v: View): boolean {
  return v.source.kind === 'foreign' || v.legacy !== undefined
}

// The stopped message: the command's answer and the README's text.
function stoppedText(v: View): string {
  if (v.legacy) return legacyMarkdown(DISPLAY, PLUGIN, v.legacy)
  return stoppedMarkdown(DISPLAY, PLUGIN, v.source.kind === 'foreign' ? v.source.marketplace : '', KEEPS)
}

// Decided at session.start and re-read on every turn.start, so an install or uninstall
// mid-session is picked up. One toast per session, when the copy first finds itself stopped.
// While a copy works, its source is re-read at most this often: another copy appearing
// beside it mid-session is rare, and the band tells the person to restart anyway. A
// stopped copy re-reads on every turn, so the old copy's removal is seen at the next Enter.
const RECHECK_MS = 10_000
let checkedAt = -Infinity
async function refreshSource($: EngineInterface, isSessionStart: boolean) {
  const was = await read($, view)
  const now = await $.clock.now()
  if (!isSessionStart && !isStopped(was) && now - checkedAt < RECHECK_MS) return
  checkedAt = now
  const { source, legacy } = await checkSource($)
  await update($, view, cur => ({ ...cur, source, legacy, confirmingFill: '' }))
  const v = await read($, view)
  if (!isStopped(v) || (isStopped(was) && !isSessionStart)) return
  if (legacy) $.ui.toast(legacyToast(DISPLAY, legacy), { timeoutMs: 8000 })
  else if (source.kind === 'foreign') $.ui.toast(stoppedToast(DISPLAY, source.marketplace), { timeoutMs: 8000 })
}

// The band's buttons fill one command into the prompt box; nothing runs by itself. A
// draft already there is asked about first.
async function fillCommand($: EngineInterface, cmd: string, isConfirmed: boolean) {
  const { text } = await $.prompt.read().catch(() => ({ text: '' }))
  if (!isConfirmed && text.trim() !== '' && text !== cmd) {
    await patch($, { confirmingFill: cmd })
    return
  }
  await patch($, { confirmingFill: '' })
  const filled = await $.prompt.fill({ text: cmd, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(fillRefusedToast(DISPLAY))
}

// Whether this copy stands aside: stopped by the source check, or `/vero-dotto off`.
async function isIdle($: EngineInterface): Promise<boolean> {
  const v = await read($, view)
  return isStopped(v) || v.isPaused
}

// --- setup -------------------------------------------------------------------------------

async function checkStatus($: EngineInterface): Promise<{ state: string; ready: string }> {
  try {
    const out = await script($, ['status'])
    const [state = 'missing', ready = ''] = out.stdout.replace(/\r/g, '').split('\n')
    return { state: state.trim(), ready: ready.trim() }
  } catch {
    return { state: 'missing', ready: '' }
  }
}

// Runs setup in the background: never awaited by a hook, so the session works (passing
// files through) until it is done. The band above the prompt shows each step the script
// reports and the time it has taken; a toast says when it starts and how it ended - one
// short line each, as a toast is cut to one line.
async function runSetup($: EngineInterface, isAsked: boolean): Promise<string> {
  const startedAt = Date.now()
  await patch($, { ready: 'preparing', failReason: '', setupStep: 'starting', setupElapsed: 0, isSetupNoteHidden: false })
  if ((await $.store.get(NOTICE_SHOWN_KEY)) !== true) {
    await $.store.set(NOTICE_SHOWN_KEY, true)
    $.ui.toast('VeroDotto: one-time setup started, see above the prompt', { timeoutMs: 6000 })
  }
  const tick = $.clock.every(1000, () => {
    void patch($, { setupElapsed: Math.round((Date.now() - startedAt) / 1000) }).catch(() => undefined)
  })
  let failReason = ''
  let job: ReturnType<EngineInterface['process']['spawn']> | undefined
  // Past the limit the child is killed (leaving the loop ends it) and setup counts as failed.
  const limit = $.clock.after(SETUP_TIMEOUT_MS, () => {
    failReason = 'setup took over 10 minutes'
    void job?.return({ code: null, signal: 'timeout' })
  })
  try {
    job = $.process.spawn({
      argv: [await bashPath($), `${$.plugin.root}/scripts/verodotto.sh`, 'setup'],
      cwd: await $.session.root(),
    })
    let stdout = ''
    let pendingErr = ''
    let lastErr = ''
    for await (const chunk of job) {
      if (chunk.stream === 'stdout') {
        stdout += chunk.text
        continue
      }
      const lines = (pendingErr + chunk.text).split('\n')
      pendingErr = lines.pop() ?? ''
      for (const line of lines) {
        const step = line.match(/^step: (.+)$/)
        if (step?.[1]) await patch($, { setupStep: step[1].trim() })
        else if (line.trim() !== '') lastErr = line.trim()
      }
    }
    const end = await job.result
    const last = stdout.trim().split('\n').pop() ?? ''
    if (failReason === '' && (end.code !== 0 || last !== 'ready')) {
      failReason = last.replace(/^failed: /, '') || lastErr || 'setup failed'
    }
  } catch (err) {
    failReason ||= `setup did not finish: ${String(err)}`
  } finally {
    tick.cancel()
    limit.cancel()
  }
  if (failReason === '') {
    await $.store.set(SETUP_FAILURES_KEY, 0)
    await patch($, { ready: 'yes', failReason: '', setupStep: '' })
    $.ui.toast('VeroDotto is ready: documents now read as markdown')
    return 'VeroDotto is ready.'
  }
  const failures = Number((await $.store.get(SETUP_FAILURES_KEY)) ?? 0) + 1
  await $.store.set(SETUP_FAILURES_KEY, failures)
  await $.store.set(SETUP_FAILED_AT_KEY, Date.now())
  await patch($, { ready: 'failed', failReason, setupStep: '' })
  $.ui.toast('VeroDotto setup failed, see above the prompt', { timeoutMs: 6000 })
  const retry = isAsked ? '' : ' It tries again in a later session.'
  return `Setup failed: ${failReason}. Retry with /vero-dotto setup.${retry}`
}

// Whether this copy runs setup now; another session's is seen as `preparing` only.
let isSettingUp = false
// Whether prompt.compose reaches this module. Where an organization manages Claude Code
// it passes over the plugins a person installs, and the system note then rides the
// session's first prompt as context instead (isNoteSent), once.
let isComposing = false
let isNoteSent = false
// The files whose skip (over maxFileMb) was toasted this session: once each.
const skipNotified = new Set<string>()
const MB = 1024 * 1024

async function setup($: EngineInterface, isAsked: boolean): Promise<string> {
  if (isSettingUp) return 'VeroDotto is already preparing its converters.'
  isSettingUp = true
  try {
    return await runSetup($, isAsked)
  } catch {
    return 'Setup could not run.'
  } finally {
    isSettingUp = false
  }
}

// session.start: ready, or whether setup should start now (autoSetup, and past the
// back-off of earlier failures). The check is one quick script call, awaited; setup
// itself never is.
async function prepare($: EngineInterface, cfg: Config): Promise<boolean> {
  const { state } = await checkStatus($)
  if (state === 'ready') {
    await patch($, { ready: 'yes' })
    return false
  }
  if (state === 'preparing') {
    await patch($, { ready: 'preparing' })
    return false
  }
  if (!cfg.autoSetup) {
    await patch($, { ready: 'off' })
    return false
  }
  const failures = Number((await $.store.get(SETUP_FAILURES_KEY)) ?? 0)
  const failedAt = Number((await $.store.get(SETUP_FAILED_AT_KEY)) ?? 0)
  if (failures > 0 && Date.now() - failedAt < retryAfterMs(failures)) {
    await patch($, { ready: 'failed', failReason: 'the last setup failed; retry with /vero-dotto setup', isSetupNoteHidden: true })
    return false
  }
  return true
}

// Conversions unused for cacheDays go, then the least recently used past cacheMaxMb: at
// most once a day, in the background.
async function pruneCache($: EngineInterface, cfg: Config) {
  try {
    const last = Number((await $.store.get(PRUNED_AT_KEY)) ?? 0)
    if (Date.now() - last < PRUNE_EVERY_MS) return
    await $.store.set(PRUNED_AT_KEY, Date.now())
    await script($, ['clean', '--days', String(cfg.cacheDays), '--max-mb', String(cfg.cacheMaxMb)], 120_000)
  } catch {
    // a missed prune is tried again tomorrow
  }
}

// --- converting ----------------------------------------------------------------------

// What VeroDotto makes of one file. `pass`: not a document of ours, read as it is.
type Outcome =
  | { kind: 'pass' }
  // `staleCopy`: the hand-kept copy beside it, older than the original, which was not used
  | { kind: 'served'; md: string; conv: Converted; staleCopy?: string }
  | { kind: 'sibling'; md: string; isStale: boolean }
  | { kind: 'kept'; reason: NonNullable<BandItem['reason']>; conv?: Converted; sizeMb?: number; limitMb?: number }

// The hand-kept copy beside a document, and whether its original changed since. A copy
// VeroDotto saved is compared by content (the original's checksum then and now: a touch
// or a save without edits is no change); one written by hand, by file dates.
async function siblingOf($: EngineInterface, path: string): Promise<{ md: string; isStale: boolean } | undefined> {
  const md = `${path}.md`
  if (!(await $.fs.exists(md).catch(() => false))) return undefined
  const said = await script($, ['sibling', path]).then(out => out.stdout.trim(), () => 'unknown')
  if (said === 'fresh' || said === 'stale') return { md, isStale: said === 'stale' }
  // A stat that fails (the module reloading mid-read) leaves the copy in use, never
  // sends the read on to converting.
  const [orig, copy] = await Promise.all([$.fs.stat(path).catch(() => undefined), $.fs.stat(md).catch(() => undefined)])
  if (copy !== undefined && copy.kind !== 'file') return undefined
  return { md, isStale: orig !== undefined && copy !== undefined && orig.mtimeMs > copy.mtimeMs }
}

async function convert($: EngineInterface, cfg: Config, path: string): Promise<Converted | undefined> {
  const out = await script(
    $,
    [
      'convert', path,
      '--max-sheet-cells', String(cfg.maxSheetCells),
      '--max-sheet-rows', String(cfg.maxSheetRows),
      '--max-tokens', String(cfg.maxTokens),
      '--timeout', String(cfg.convertTimeoutSec),
    ],
    (cfg.convertTimeoutSec + 15) * 1000,
  )
  return out.exitCode === 0 ? parseConverted(out.stdout) : undefined
}

async function outcomeOf($: EngineInterface, cfg: Config, path: string): Promise<Outcome> {
  const kind = classify(path)
  if (kind === 'keep') return { kind: 'pass' }
  if (kind === 'doc') return { kind: 'kept', reason: 'doc' }
  // A current hand-kept copy is read in the original's place. One whose original changed
  // since is not: a fresh conversion is read in the same request - the person's copy is
  // left as it is (it may hold edits) and the band offers to update it. Only where no
  // conversion can be made is the old copy read, with the warning.
  const sibling = await siblingOf($, path)
  if (sibling && !sibling.isStale) return { kind: 'sibling', ...sibling }
  const fresh = await convertOutcome($, cfg, path, sibling !== undefined)
  if (sibling && fresh.kind !== 'served') return { kind: 'sibling', ...sibling }
  return fresh.kind === 'served' && sibling ? { ...fresh, staleCopy: sibling.md } : fresh
}

async function convertOutcome($: EngineInterface, cfg: Config, path: string, hasCopy: boolean): Promise<Outcome> {
  // Really big files are rare and handled by hand: skipped, and the person is told once.
  const size = (await $.fs.stat(path).catch(() => undefined))?.size ?? 0
  if (size > cfg.maxFileMb * MB) {
    const sizeMb = size / MB
    if (!skipNotified.has(path)) {
      skipNotified.add(path)
      $.ui.toast(`VeroDotto skipped ${baseName(path)}: ${formatMb(sizeMb)} MB > ${formatMb(cfg.maxFileMb)} MB`, { timeoutMs: 8000 })
    }
    return { kind: 'kept', reason: 'too-large', sizeMb, limitMb: cfg.maxFileMb }
  }
  const v = await read($, view)
  if (v.ready === 'preparing') return { kind: 'kept', reason: 'preparing' }
  if (v.ready !== 'yes') return { kind: 'kept', reason: 'not-ready' }
  const conv = await convert($, cfg, path).catch(() => undefined)
  if (!conv) return { kind: 'kept', reason: 'failed' }
  const decision = decide(conv.meta, cfg.minSavingPercent)
  // a document that has a markdown copy is wanted as markdown, whatever the saving
  const isKept = !decision.serve && !(hasCopy && decision.reason === 'small-saving')
  if (isKept && !decision.serve) return { kind: 'kept', reason: decision.reason, conv }
  return { kind: 'served', md: mdPathOf(conv.docDir), conv }
}

function itemOf(path: string, outcome: Outcome): BandDraft | undefined {
  const name = baseName(path)
  if (outcome.kind === 'pass') return undefined
  if (outcome.kind === 'sibling') return { name, path, state: 'sibling', isStale: outcome.isStale }
  if (outcome.kind === 'served') {
    const { meta, docDir } = outcome.conv
    return {
      name,
      path,
      state: 'converted',
      mdTokens: meta.mdTokens,
      origTokens: meta.origTokens,
      saving: savingPercent(meta.mdTokens, meta.origTokens),
      lost: meta.lost,
      docDir,
      ...(outcome.staleCopy ? { hasStaleCopy: true } : {}),
    }
  }
  const meta: Meta | undefined = outcome.conv?.meta
  return {
    name,
    path,
    state: 'kept',
    reason: outcome.reason,
    ...(outcome.sizeMb !== undefined ? { sizeMb: outcome.sizeMb, limitMb: outcome.limitMb } : {}),
    ...(meta ? { saving: savingPercent(meta.mdTokens, meta.origTokens), mdTokens: meta.mdTokens, origTokens: meta.origTokens } : {}),
  }
}

// A file the model already holds unchanged: nothing was sent, nothing saved this time.
// Its conversion is still in the cache, so Save stays on offer.
function unchangedItem(path: string, outcome: Outcome): BandDraft {
  const docDir = outcome.kind === 'served' ? outcome.conv.docDir : undefined
  return { name: baseName(path), path, state: 'unchanged', ...(docDir ? { docDir } : {}) }
}

// The band keeps an item while it is newer than the last BAND_PROMPTS prompts or younger
// than `bandSeconds`, whichever keeps it longer, so a quick follow-up does not wipe a row
// the person has not read yet; × closes everything at once. A finished turn marks the
// band stale, and the next prompt's first event counts the prompt and drops what has aged
// out: the engine reads a prompt's @ mentions before it raises prompt.submit, so neither
// can be relied on to come first.
const BAND_PROMPTS = 2
async function freshBand($: EngineInterface, cfg: Config) {
  const now = await $.clock.now()
  await update($, view, cur => {
    if (!cur.isBandStale) return cur
    const prompts = cur.prompts + 1
    const lastTurn = cur.lastTurn.filter(it => prompts - it.prompt <= BAND_PROMPTS || now - it.at < cfg.bandSeconds * 1000)
    const confirmingSave = lastTurn.some(it => it.path === cur.confirmingSave) ? cur.confirmingSave : ''
    return { ...cur, isBandStale: false, prompts, lastTurn, confirmingSave }
  })
}

// One item into the band, replacing the same file's earlier one (a pending conversion),
// stamped with now and the current prompt.
async function showInBand($: EngineInterface, cfg: Config, item: BandDraft) {
  await freshBand($, cfg)
  const at = await $.clock.now()
  await update($, view, cur => ({ ...cur, lastTurn: [...cur.lastTurn.filter(it => it.path !== item.path), { ...item, at, prompt: cur.prompts }] }))
}

async function bumpStats($: EngineInterface, fn: (s: Stats) => Stats) {
  await update($, view, cur => ({ ...cur, session: fn(cur.session) }))
  const all = ((await $.store.get(ALL_TIME_KEY)) as Stats | undefined) ?? EMPTY_STATS
  await $.store.set(ALL_TIME_KEY, fn({ ...EMPTY_STATS, ...all }))
}

async function count($: EngineInterface, outcome: Outcome) {
  if (outcome.kind === 'served') {
    const { meta, isCached } = outcome.conv
    await bumpStats($, s => addRead(s, meta.ext, Math.max(0, meta.origTokens - meta.mdTokens), !isCached))
  } else if (outcome.kind === 'kept' && outcome.conv) {
    await bumpStats($, addKept)
  }
}

// What the model reads beside the file it was handed.
function contextOf(path: string, outcome: Outcome): string | undefined {
  if (outcome.kind === 'served') {
    const copy = outcome.staleCopy ? ` ${staleCopyContext(outcome.staleCopy)}` : ''
    return convertedContext(path, outcome.conv.meta) + copy
  }
  if (outcome.kind === 'sibling') return siblingContext(path, outcome.md, outcome.isStale)
  return undefined
}

// --- save ----------------------------------------------------------------------------------

// Copies the conversion to <original>.md, beside the original and nowhere else; asks
// before overwriting one that exists.
async function save($: EngineInterface, item: BandItem, isConfirmed: boolean): Promise<string> {
  if (!item.docDir) return `Nothing to save for ${item.name}.`
  const dest = `${item.path}.md`
  const out = await script($, ['save', item.docDir, dest, ...(isConfirmed ? ['--force'] : [])]).catch(() => undefined)
  const said = out?.stdout.trim() ?? 'failed'
  if (said === 'exists') {
    await update($, view, cur => ({ ...cur, confirmingSave: item.path }))
    return `${baseName(dest)} exists.`
  }
  await update($, view, cur => ({
    ...cur,
    confirmingSave: '',
    lastTurn: cur.lastTurn.map(it => (it.path === item.path && said === 'saved' ? { ...it, isSaved: true, isStale: false } : it)),
  }))
  if (said !== 'saved') {
    $.ui.toast(`VeroDotto could not save ${baseName(dest)}`)
    return `Could not save ${baseName(dest)}: ${said}`
  }
  const text = `Saved ${baseName(dest)} - VeroDotto will use it instead of converting ${item.name}.`
  $.ui.toast(`Saved ${baseName(dest)}`)
  return text
}

// --- the command ---------------------------------------------------------------------

async function statusText($: EngineInterface, cfg: Config): Promise<string> {
  const v = await read($, view)
  const { ready } = await checkStatus($)
  const sizes = await script($, ['sizes']).then(
    out => Object.fromEntries(out.stdout.trim().split('\n').map(line => line.split('\t'))) as Record<string, string>,
    () => ({}) as Record<string, string>,
  )
  const where = await script($, ['where']).then(out => out.stdout.trim(), () => '?')
  const mb = (kb: string | undefined) => `${Math.round(Number(kb ?? 0) / 1024)} MB`
  const state = {
    yes: 'ready',
    preparing: 'preparing converters (one time)',
    failed: `setup failed: ${v.failReason || 'unknown reason'} - retry with /vero-dotto setup`,
    off: 'not set up (autoSetup is off) - run /vero-dotto setup',
    unknown: 'checking',
  }[v.ready]
  const lines = ['**VeroDotto** - *Read true. Spend less.*', `Status: ${state}`]
  if (v.isPaused) lines.push('_Paused for this session: documents are read as they are. Resume with /vero-dotto on._')
  let versions = ''
  try {
    const r = JSON.parse(ready) as { uv?: string; uvSource?: string; converters?: Record<string, string> }
    versions = [`uv ${r.uv ?? '?'} (${r.uvSource ?? '?'})`, ...Object.entries(r.converters ?? {}).map(([k, val]) => `${k} ${val}`)].join(', ')
  } catch {
    // no marker yet
  }
  if (versions) lines.push(`Versions: ${versions}`)
  lines.push(`Cache: ${where} - conversions ${mb(sizes.docs)} (${sizes.count ?? 0}), converters ${mb(sizes.toolchain)}`)
  lines.push(`Formats converted: ${CONVERTED.join(' ')}`)
  const changed = changedOptions(cfg)
  if (changed.length > 0) lines.push(`Options changed from defaults: ${changed.join(', ')}`)
  lines.push('', 'Commands: /vero-dotto on | off | stats | show <file> | save <file> | setup | clean | purge')
  return lines.join('\n')
}

async function argPath($: EngineInterface, arg: string): Promise<string> {
  const [first] = findPaths(arg)
  return resolvePath(await $.session.root(), await homeOf($), first ?? arg.trim())
}

async function show($: EngineInterface, cfg: Config, arg: string): Promise<string> {
  if (arg.trim() === '') return 'Usage: /vero-dotto show <file>'
  const path = await argPath($, arg)
  if (!(await $.fs.exists(path).catch(() => false))) return `No such file: ${path}`
  const outcome = await outcomeOf($, cfg, path)
  if (outcome.kind === 'pass') return `${baseName(path)} is not a format VeroDotto converts; Claude reads it as it is.`
  const sibling = await siblingOf($, path)
  const siblingLine = sibling
    ? `Sibling: ${baseName(sibling.md)} is used instead of converting${sibling.isStale ? ` (${WARN}the original is newer)` : ''}.`
    : 'Sibling: none (Save writes one).'
  if (outcome.kind === 'kept' && !outcome.conv) return `**${baseName(path)}**: ${bandLine([itemOf(path, outcome)!])}\n\n${siblingLine}`
  const conv = outcome.kind === 'sibling' ? await convert($, cfg, path).catch(() => undefined) : 'conv' in outcome ? outcome.conv : undefined
  if (!conv) return `**${baseName(path)}**\n\n${siblingLine}`
  const { meta } = conv
  const md = await $.fs.read(mdPathOf(conv.docDir)).catch(() => '')
  const head = md.split('\n').slice(0, SHOW_LINES).join('\n')
  const fence = fenceFor(head)
  const floor = meta.isLowerBound ? 'at least ' : ''
  return [
    `**${meta.source}** (${Math.round(meta.size / 1024)} KB, ${meta.converter}${meta.kind === 'summary' ? ', summary' : ''})`,
    `Markdown ≈ ${formatTokens(meta.mdTokens)} tokens; the original ≈ ${floor}${formatTokens(meta.origTokens)} ` +
      `(−${savingPercent(meta.mdTokens, meta.origTokens)}%, est.)`,
    `Lost: ${lostText(meta.lost)}`,
    `Decision: ${decide(meta, cfg.minSavingPercent).serve ? 'read as markdown' : 'kept as original'}`,
    `Cache: ${mdPathOf(conv.docDir)}`,
    siblingLine,
    '',
    `${fence}markdown\n${head}\n${fence}`,
  ].join('\n')
}

async function saveCommand($: EngineInterface, cfg: Config, arg: string): Promise<string> {
  const parts = arg.trim().split(/\s+/)
  const isForced = parts.includes('--force')
  const path = await argPath($, parts.filter(p => p !== '--force').join(' '))
  if (classify(path) !== 'convert') return `${baseName(path)} is not a format VeroDotto converts.`
  if (!(await $.fs.exists(path).catch(() => false))) return `No such file: ${path}`
  const v = await read($, view)
  if (v.ready !== 'yes') return 'The converters are not ready yet: see /vero-dotto.'
  const conv = await convert($, cfg, path).catch(() => undefined)
  if (!conv) return `Could not convert ${baseName(path)}.`
  const text = await save($, { name: baseName(path), path, state: 'converted', docDir: conv.docDir }, isForced)
  if (text.endsWith(' exists.')) {
    await update($, view, cur => ({ ...cur, confirmingSave: '' }))
    return `${text} Overwrite it with /vero-dotto save ${arg.trim()} --force`
  }
  return text
}

async function purge($: EngineInterface): Promise<string> {
  const where = (await script($, ['where'])).stdout.trim()
  if (!isCacheDir(where, await homeOf($))) {
    // the script itself accepts a VERODOTTO_DIR holding its marker; ask it
    const out = await script($, ['purge']).catch(() => undefined)
    if (out?.exitCode !== 0) return `Refusing to delete ${where}: not a VeroDotto cache.`
    await patch($, { ready: 'off', lastTurn: [] })
    return `Removed ${where}. Converters will be set up again: /vero-dotto setup.`
  }
  const out = await script($, ['purge'], 120_000)
  if (out.exitCode !== 0) return out.stdout.trim() || `Could not delete ${where}.`
  await patch($, { ready: 'off', lastTurn: [] })
  await $.store.set(SETUP_FAILURES_KEY, 0)
  return `Removed ${where}: every conversion and the converters. Set them up again with /vero-dotto setup.`
}

// --- hooks -------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const cfg = configOf(options)
  // A path written in a prompt is converted in the background; a Read of it while that
  // runs waits for it here rather than converting twice.
  const pending = new Map<string, Promise<Outcome>>()
  // Cache paths this module redirected a Read to, with the verdict the original had: the
  // tool.check hook answers it for the cache path, so the redirect asks exactly as a Read
  // of the original would have, and never more.
  const redirects = new Map<string, 'allow' | 'ask'>()

  // The source check comes first: a stopped copy registers its command, says so once,
  // and does nothing else - no status call, no setup, no prune.
  on('session.start', async ($, e, next) => {
    await update($, view, () => INITIAL)
    await refreshSource($, true)
    await $.command.register({
      name: 'vero-dotto',
      description: 'VeroDotto: documents as markdown (status, on, off, stats, show, save, setup, clean, purge)',
      argumentHint: '[on | off | stats | show <file> | save <file> | setup | clean | purge]',
    })
    if (isStopped(await read($, view))) return next(e)
    if (await prepare($, cfg).catch(() => false)) {
      await patch($, { ready: 'preparing' })
      void setup($, false)
    }
    void pruneCache($, cfg)

    return next(e)
  })

  // A /clear ends the conversation and goes on under a new session id with no
  // session.start: the band and what the model was told go with the old one.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    await update($, view, cur => ({ ...cur, lastTurn: [], confirmingSave: '', confirmingFill: '', toldAbout: [], session: EMPTY_STATS }))
    isNoteSent = false
    skipNotified.clear()
    await patch($, { isPaused: false })

    return done
  })

  // The source is read again: a move or an uninstall mid-session is picked up here, with
  // no restart. A copy that just stopped being stopped prepares as a session start would.
  on('turn.start', async ($, e, next) => {
    const wasStopped = isStopped(await read($, view))
    await refreshSource($, false)
    const v = await read($, view)
    if (isStopped(v)) return next(e)
    if (wasStopped) {
      if (await prepare($, cfg).catch(() => false)) {
        await patch($, { ready: 'preparing' })
        void setup($, false)
      }
      void pruneCache($, cfg)
      return next(e)
    }
    // another session's setup (the lock was taken) may have finished since
    if (!isSettingUp && v.ready === 'preparing') await prepare($, cfg).catch(() => false)
    return next(e)
  })

  // The main turn ended: its band stays on screen until the next prompt replaces it.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await patch($, { isBandStale: true }).catch(() => undefined)

    return done
  })

  // Once per session, in the system prompt, while the converters can run: open documents
  // with Read. With them missing it would send the model to a Read that cannot help.
  on('prompt.compose', async ($, e, next) => {
    isComposing = true
    const result = await next(e)
    const v = await read($, view)
    if (isStopped(v) || v.isPaused || v.ready !== 'yes' || result.sections.some(s => s.id === NOTE_ID)) return result

    return { sections: [...result.sections, { id: NOTE_ID, text: systemNote(), scope: 'session' as const }] }
  })

  // A new prompt: the band of a finished turn goes. Paths written as plain text get one line of context
  // each - never their content: a path in a prompt is not always meant to be read - and
  // their conversion starts in the background, so the Read that follows is instant.
  on('prompt.submit', async ($, e, next) => {
    const v = await read($, view)
    if (isStopped(v)) return next(e)
    await freshBand($, cfg)
    pending.clear()
    if (e.command || v.isPaused || v.ready !== 'yes') return next(e)
    const root = await $.session.root()
    const home = await homeOf($)
    const mentioned = mentionsOf(e.text).map(m => resolvePath(root, home, m))
    const lines: string[] = []
    if (!isComposing && !isNoteSent) {
      isNoteSent = true
      lines.push(systemNote())
    }
    const seen: string[] = []
    for (const written of findPaths(e.text)) {
      if (seen.length >= MAX_PLAIN_PATHS) break
      const path = resolvePath(root, home, written)
      if (classify(path) !== 'convert' || mentioned.includes(path) || seen.includes(path)) continue
      if (!(await $.fs.exists(path).catch(() => false))) continue
      seen.push(path)
      lines.push(plainPathContext(written))
      await showInBand($, cfg, { name: baseName(path), path, state: 'pending' })
      const job = outcomeOf($, cfg, path)
      pending.set(path, job)
      void job
        .then(async outcome => {
          const item = itemOf(path, outcome)
          if (item) await showInBand($, cfg, item)
        })
        .catch(() => update($, view, cur => ({ ...cur, lastTurn: cur.lastTurn.filter(it => it.path !== path) })))
        .catch(() => undefined)
    }
    if (lines.length === 0) return next(e)

    return next({ ...e, context: [...(e.context ?? []), ...lines] })
  }).catch(($, e, next) => next(e))

  // `@spec.docx`: converted before the model starts; the band says what it cost.
  on('prompt.mention', async ($, e, next) => {
    if (await isIdle($)) return next(e)
    await freshBand($, cfg)
    const outcome = await outcomeOf($, cfg, e.path)
    const item = itemOf(e.path, outcome)
    if (outcome.kind !== 'served' && outcome.kind !== 'sibling') {
      if (item) await showInBand($, cfg, item)
      await count($, outcome)
      return next(e)
    }
    const result = await next({ ...e, path: outcome.md })
    // the model holds this markdown already: the engine sent nothing again
    const isUnchanged = result.deny === undefined && result.type === 'already_read_file'
    if (item) await showInBand($, cfg, isUnchanged ? unchangedItem(e.path, outcome) : item)
    if (!isUnchanged) await count($, outcome)
    const context = contextOf(e.path, outcome)
    if (result.deny !== undefined || context === undefined) return result
    await update($, view, cur => ({ ...cur, toldAbout: [...cur.toldAbout.filter(p => p !== e.path), e.path] }))

    return { ...result, context: [...(result.context ?? []), context] }
  }).catch(($, e, next) => next(e))

  // The model's own Read of a document: redirected to its markdown. A PDF read by
  // `pages` asks for page images and is left alone; offset and limit carry over.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.tool !== 'Read' || (await isIdle($))) return next(e)
    const path = e.file_path
    if (classify(path) === 'keep' || isPageRead(path, e.pages)) return next(e)
    const job = pending.get(path)
    pending.delete(path)
    const outcome = await (job ?? outcomeOf($, cfg, path))
    // A row for this file is already up (a path written in the prompt), or reads get one.
    const isInBand = (await read($, view)).lastTurn.some(it => it.path === path)
    const band = async (item: BandDraft | undefined) => {
      if (item && (isInBand || cfg.bandForReads)) await showInBand($, cfg, item)
    }
    if (outcome.kind !== 'served' && outcome.kind !== 'sibling') {
      await band(itemOf(path, outcome))
      await count($, outcome)
      return next(e)
    }
    // The original's own verdict first: a deny rule on it stands, and the cache path
    // asks exactly when the original would have.
    const check = await $.tool.check({ tool: 'Read', input: { file_path: path } }).catch(() => ({ decision: 'ask' as const }))
    if (check.decision === 'deny') return next(e)
    redirects.set(outcome.md, check.decision)
    const result = await next({ ...e, file_path: outcome.md })
    if (result.deny !== undefined || result.isError) return result
    // the model holds this markdown already: the engine sent nothing again
    const isUnchanged = (result.result as { type?: string } | undefined)?.type === 'file_unchanged'
    await band(isUnchanged ? unchangedItem(path, outcome) : itemOf(path, outcome))
    if (!isUnchanged) await count($, outcome)
    const v = await read($, view)
    const context = contextOf(path, outcome)
    if (context === undefined || v.toldAbout.includes(path)) return result
    await update($, view, cur => ({ ...cur, toldAbout: [...cur.toldAbout, path] }))

    return { ...result, context: [...(result.context ?? []), context] }
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    if (isStopped(await read($, view))) return next(e)
    const input = e.input as { file_path?: unknown }
    const verdict = typeof input.file_path === 'string' ? redirects.get(input.file_path) : undefined
    if (verdict === 'allow') return { decision: 'allow' as const }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A shell command that parses a document by hand runs unchanged; afterwards the model
  // is told, once per file, that Read gives clean markdown. Never blocks or rewrites: it
  // may need the raw file (images, formulas).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (e.tool !== 'Bash' || result.deny !== undefined) return result
    const v = await read($, view)
    if (isStopped(v) || v.isPaused || v.ready !== 'yes' || !isParserCommand(e.command)) return result
    const root = await $.session.root()
    const home = await homeOf($)
    const notes: string[] = []
    const told: string[] = []
    for (const written of findPaths(e.command)) {
      const path = resolvePath(root, home, written)
      if (classify(path) !== 'convert' || v.toldAbout.includes(path) || told.includes(path)) continue
      if (!(await $.fs.exists(path).catch(() => false))) continue
      told.push(path)
      notes.push(bashNudge(written))
    }
    if (notes.length === 0) return result
    await update($, view, cur => ({ ...cur, toldAbout: [...cur.toldAbout, ...told] }))

    return { ...result, context: [...(result.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'vero-dotto' }, async ($, e) => {
    const trimmed = e.args.trim()
    const [sub = ''] = trimmed.split(/\s+/)
    const arg = trimmed.slice(sub.length).trim()
    const current = await read($, view)
    if (isStopped(current)) return { text: stoppedText(current) }
    if (sub === 'off') {
      await patch($, { isPaused: true, lastTurn: [], confirmingSave: '' })
      return { text: 'VeroDotto is paused for this session: documents are read as they are. Resume with /vero-dotto on.' }
    }
    if (sub === 'on') {
      await patch($, { isPaused: false })
      return { text: 'VeroDotto is on again: documents are read as markdown.' }
    }
    if (sub === '') return { text: await statusText($, cfg) }
    if (sub === 'stats') {
      const v = await read($, view)
      const all = ((await $.store.get(ALL_TIME_KEY)) as Stats | undefined) ?? EMPTY_STATS
      return { text: [statsText('This session', v.session), statsText('All time', { ...EMPTY_STATS, ...all })].join('\n\n') }
    }
    if (sub === 'show') return { text: await show($, cfg, arg) }
    if (sub === 'save') return { text: await saveCommand($, cfg, arg) }
    if (sub === 'setup') {
      await $.store.set(SETUP_FAILURES_KEY, 0)
      return { text: await setup($, true) }
    }
    if (sub === 'clean') {
      const out = await script($, ['clean'], 120_000).catch(() => undefined)
      return { text: out?.exitCode === 0 ? `Conversions ${out.stdout.trim()}; the converters are kept.` : 'Could not clean the cache.' }
    }
    if (sub === 'purge') return { text: await purge($) }
    return { text: `Unknown: ${sub}. Use /vero-dotto, on, off, stats, show <file>, save <file>, setup, clean or purge.` }
  })

  // The band above the prompt: while setup runs, its progress; after a prompt that named
  // documents, the saving, what was lost, Save markdown next to original (or Update <name>.md
  // where a hand-kept copy is older than its original), and ×; while paused, a reminder with Resume. Other plugins share
  // the band: what the ones beneath draw (VeroDiff's row, say) stays, under these rows,
  // so no plugin hides another's. Keys carry `vd-`, unique beside theirs. Out of the way
  // of a survey; nothing of its own when there is nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = []
    if (isStopped(v)) {
      // stopped: the row that moves this copy, every session, with no way to close it
      const marketplace = v.source.kind === 'foreign' ? v.source.marketplace : ''
      const legacy = v.legacy
      const fills: { key: string; label: string; cmd: string }[] = legacy
        ? removeSteps(PLUGIN, legacy).map((cmd, i) => ({ key: `vd-move:remove-${i + 1}`, label: REMOVE_LABELS[i] ?? cmd, cmd }))
        : moveSteps(PLUGIN, marketplace).map((cmd, i) => ({ key: `vd-move:${i + 1}`, label: MOVE_LABELS[i] ?? cmd, cmd }))
      rows.push(
        <Box key="vd-stopped" flexDirection="column">
          <Text color="yellow">{legacy ? legacyBand(DISPLAY, legacy) : stoppedBand(DISPLAY, marketplace)}</Text>
          <Box flexDirection="row" gap={1}>
            {v.confirmingFill === '' &&
              fills.map(f => (
                <Button key={f.key} onPress={() => void fillCommand($, f.cmd, false)}>
                  {f.label}
                </Button>
              ))}
            {v.confirmingFill !== '' && <Text>{REPLACE_QUESTION}</Text>}
            {v.confirmingFill !== '' && (
              <Button key="vd-move:replace" onPress={() => void fillCommand($, v.confirmingFill, true)}>
                {REPLACE_YES}
              </Button>
            )}
            {v.confirmingFill !== '' && (
              <Button key="vd-move:cancel" onPress={() => void patch($, { confirmingFill: '' })}>
                {REPLACE_NO}
              </Button>
            )}
            <Text dimColor>{RESTART_NOTE}</Text>
          </Box>
        </Box>,
      )
    } else if (v.isPaused) {
      // a pause is easy to forget: the row says so and offers the way back
      rows.push(
        <Box key="vd-paused" flexDirection="row" gap={1}>
          <Text dimColor>VeroDotto</Text>
          <Text dimColor>{PAUSE}paused for this session: documents are read as they are</Text>
          <Button key="vd-resume" dimColor onPress={() => void patch($, { isPaused: false })}>
            Resume
          </Button>
        </Box>,
      )
    } else {
      // while setup runs: its step and time; after it failed: why, with Retry, until closed
      if (v.ready === 'preparing') {
        rows.push(
          <Box key="vd-setup" flexDirection="row" gap={1}>
            <Text dimColor>VeroDotto</Text>
            <Text dimColor>{setupLine(v.setupStep, v.setupElapsed)}</Text>
          </Box>,
        )
      } else if (v.ready === 'failed' && !v.isSetupNoteHidden) {
        rows.push(
          <Box key="vd-setup-failed" flexDirection="row" gap={1}>
            <Text dimColor>VeroDotto</Text>
            <Text color="yellow">
              {WARN}setup failed: {v.failReason}
            </Text>
            <Button key="vd-retry-setup" onPress={() => void setup($, true)}>
              Retry
            </Button>
            <Button key="vd-hide-setup" plain dimColor role="dismiss" onPress={() => void patch($, { isSetupNoteHidden: true })}>
              {'\u00d7'}
            </Button>
          </Box>,
        )
      }
      if (v.lastTurn.length > 0) {
        const one = saveable(v.lastTurn)
        const isConfirming = one !== undefined && v.confirmingSave === one.path
        rows.push(
          <Box key="vd-files" flexDirection="row" gap={1}>
            <Text dimColor>VeroDotto</Text>
            <Text>{bandLine(v.lastTurn)}</Text>
            {one && !isConfirming && (
              <Button key="vd-save" dimColor onPress={() => void save($, one, false)}>
                {one.hasStaleCopy ? `Update ${one.name}.md` : 'Save markdown next to original'}
              </Button>
            )}
            {one && isConfirming && <Text>Overwrite {one.name}.md?</Text>}
            {one && isConfirming && (
              <Button key="vd-save-yes" onPress={() => void save($, one, true)}>
                Yes
              </Button>
            )}
            {one && isConfirming && (
              <Button key="vd-save-no" onPress={() => void update($, view, cur => ({ ...cur, confirmingSave: '' }))}>
                No
              </Button>
            )}
            <Button
              key="vd-hide-band"
              plain
              dimColor
              role="dismiss"
              onPress={() => void update($, view, cur => ({ ...cur, lastTurn: [], confirmingSave: '' }))}
            >
              {'\u00d7'}
            </Button>
          </Box>,
        )
      }
    }
    if (rows.length === 0) return next(e)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {rows}
        {below}
      </Box>
    )
  })
}
