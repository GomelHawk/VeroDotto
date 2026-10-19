import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Meta } from '../types'

// The hooks drawn and raised through the engine on both surfaces. The test has no
// processes and no disk, so hooks beneath the plugin answer `$.process.run` the way
// verodotto.sh would and `$.fs.*` from a small fake disk, and stand for the engine's own
// read of a mentioned file and of a Read call.

const CACHE = '/home/me/.cache/verodotto'
const META: Meta = {
  source: 'spec.docx',
  ext: '.docx',
  size: 31000,
  mdChars: 16800,
  mdTokens: 4200,
  origTokens: 31000,
  isLowerBound: true,
  lost: ['2 images', '1 chart'],
  converter: 'mammoth 1.13.0',
  kind: 'full',
  convertedAt: '2026-10-14T00:00:00Z',
}
const READY = '{"expect":"x","uv":"0.12.24","uvSource":"bundled","converters":{"mammoth":"1.13.0"}}'

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// How the world differs from a ready machine with /repo/docs/spec.docx on disk. Read on
// every call, so a test can change it between two acts.
type World = {
  status?: 'ready' | 'missing' | 'preparing' | 'stale'
  setup?: string
  // per absolute path: the meta convert prints, or 'fail'
  conversions?: Record<string, Partial<Meta> | 'fail'>
  // the files on disk and their mtimes
  files?: Record<string, number>
  // sizes in bytes, where a test needs one; 100 otherwise
  sizes?: Record<string, number>
  // what `verodotto.sh sibling` says of a copy VeroDotto saved; unknown (dates decide) otherwise
  sibling?: 'fresh' | 'stale'
  // paths whose stat fails although they exist (the module reloading mid-read)
  statFails?: string[]
  save?: 'saved' | 'exists'
  where?: string
  // the settings each scope's file holds, as $.settings.read gives them
  settings?: Partial<Record<'user' | 'project' | 'local', unknown>>
  // what VERO_TEST_ROOT says (the test seam of the source check)
  testRoot?: string
  // the verdict the engine gives a Read of the original
  verdict?: 'allow' | 'ask' | 'deny'
  // a conversion that throws (the process timed out)
  isConvertThrowing?: boolean
  // holds the streamed setup after its steps until resolved, so a test sees it running
  setupHold?: Promise<void>
  // the engine's answer when the model already holds the file unchanged: nothing sent again
  isUnchanged?: boolean
  // a row another plugin beneath draws above the prompt (VeroDiff's, say)
  belowRow?: string
  // what `verodotto.sh purge` prints, and its exit code
  purge?: [string, number]
  // the prompt box refuses a fill (a dialog is open)
  isFillRefused?: boolean
}

const SPEC = '/repo/docs/spec.docx'

function fakeWorld(on: On, world: World = {}, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  const seen = {
    ran: [] as string[][],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    mentionReads: [] as string[],
    toolReads: [] as string[],
    checks: [] as string[],
    // the context each prompt reached the engine with, the system note's fallback left
    // out (it rides the first prompt where prompt.compose never reaches the plugin)
    contexts: [] as (readonly string[] | undefined)[],
    // offset and limit of each Read the engine ran
    offsets: [] as unknown[][],
    // how many system notes each prompt carried as context
    notes: [] as number[],
    // what the plugin put into the prompt box, with the mode, and the draft it finds there
    filled: [] as [string, string | undefined][],
    draft: '',
    clock,
  }
  mock.store(on, store)
  // the environment is read on every call, so a test can move VERO_TEST_ROOT mid-session
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'VERO_TEST_ROOT' ? world.testRoot : undefined }))
  on('settings.read', ($, e) => ({ value: (e.source && world.settings?.[e.source as 'user']) ?? {} }))
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    if (world.isFillRefused) return { isFilled: false, text: seen.draft }
    seen.filled.push([e.text, e.mode])
    return { isFilled: true, text: e.text }
  })
  const files = () => world.files ?? { [SPEC]: 1000 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', ($, e) => ({ value: e.path in files() }))
  on('fs.stat', ($, e) => {
    const mtime = files()[e.path]
    if (mtime === undefined || world.statFails?.includes(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: world.sizes?.[e.path] ?? 100, mtimeMs: mtime, isLink: false } }
  })
  on('fs.read', () => ({ value: '# Product specification\n\nline two\n' }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    seen.ran.push(argv)
    const [, , cmd, ...args] = argv
    if (cmd === 'where') return ok(`${world.where ?? CACHE}\n`)
    if (cmd === 'status') return ok(`${world.status ?? 'ready'}\n${READY}\n`)
    if (cmd === 'setup') return ok(world.setup ?? 'ready\n', world.setup && world.setup !== 'ready\n' ? 1 : 0)
    if (cmd === 'sizes') return ok('docs\t2048\ntoolchain\t614400\ncount\t3\n')
    if (cmd === 'clean') return ok('removed 3\n')
    if (cmd === 'purge') return ok(world.purge?.[0] ?? `removed ${world.where ?? CACHE}\n`, world.purge?.[1] ?? 0)
    if (cmd === 'save') return ok(`${world.save ?? 'saved'}\n`)
    if (cmd === 'sibling') return ok(`${world.sibling ?? 'unknown'}\n`)
    if (cmd === 'convert') {
      if (world.isConvertThrowing) throw new Error('timed out')
      const path = args[0] ?? ''
      const conv = (world.conversions ?? { [SPEC]: {} })[path]
      if (conv === undefined || conv === 'fail') return ok('', 5)
      const key = path.replace(/[^a-z]/gi, '')
      return ok(`${CACHE}/docs/${key}\tnew\n${JSON.stringify({ ...META, ...conv })}\n`)
    }
    return ok('')
  })
  // the engine's own read of a mentioned file, and of a Read call
  on('prompt.mention', ($, e) => {
    seen.mentionReads.push(e.path)
    return { type: world.isUnchanged ? ('already_read_file' as const) : ('file' as const) }
  })
  on('tool.call', { tool: 'Read' }, ($, e) => {
    if (e.tool === 'Read') {
      seen.toolReads.push(e.file_path)
      seen.offsets.push([e.offset, e.limit])
    }
    if (world.isUnchanged) return { result: { type: 'file_unchanged', file: { filePath: '' } } } as never
    return { result: { type: 'text', file: { filePath: '', content: '', numLines: 0, startLine: 1, totalLines: 0 } } } as never
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  on('tool.check', ($, e) => {
    seen.checks.push(String((e.input as { file_path?: string }).file_path))
    return { decision: world.verdict ?? ('allow' as const), reason: 'a rule' }
  })
  // setup runs streamed: its steps on stderr, then `ready` (or `failed: ...`) on stdout
  on('process.spawn', async function* ($, e) {
    seen.ran.push([...e.argv])
    yield { stream: 'stderr' as const, text: 'step: 1/3 using uv 0.12.24 from PATH\nstep: 2/3 installing Python 3.12 and the converters (~200 MB)\n' }
    if (world.setupHold) await world.setupHold
    const said = world.setup ?? 'ready\n'
    yield { stream: 'stdout' as const, text: said }
    return { value: { code: said === 'ready\n' ? 0 : 1, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    const paths = e.context?.filter(c => !c.startsWith('Documents ('))
    seen.contexts.push(paths && paths.length > 0 ? paths : undefined)
    seen.notes.push(e.context?.filter(c => c.startsWith('Documents (')).length ?? 0)
    return { text: e.text, context: e.context }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  // what the engine draws above the prompt when no plugin does: an empty row
  // (or another plugin's row, where the test has one beneath)
  on('ui.render', { component: 'AbovePrompt' }, () =>
    world.belowRow === undefined
      ? { type: 'Box', props: {}, children: [] }
      : { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: [world.belowRow] }] },
  )
  return seen
}

type T = Parameters<TestBody>[0]

const run = ($: T, args: string) =>
  $.command.run({ command: 'vero-dotto', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

// A prompt the person typed; the engine fills in where it came from.
const submit = ($: T, text: string) => $.prompt.submit({ text, wait: false } as never)

// The main turn ends, as after every prompt the person sends.
const endTurn = ($: T) =>
  $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)

const mention = ($: T, path: string) => $.prompt.mention({ mention: path.replace('/repo/', ''), path })

const readFile = ($: T, file_path: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Read', file_path, ...extra } as never)

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
} as const

const MD = `${CACHE}/docs/repodocsspecdocx/doc.md`

// Lets work a hook left running in the background (setup, a conversion started at
// submit) settle: each command is a round trip through the engine and the plugin.
async function settle($: T) {
  for (let i = 0; i < 15; i++) await run($, 'stats')
}

for (const surface of ['terminal', 'desktop'] as const) {
  const start = ($: T) => $.session.start({ cwd: '/repo', surface, isInteractive: true })
  const band = ($: T) => $.ui.mount({ plugin: 'vero-dotto', surface, component: 'AbovePrompt', props: BAND })

  describe(`mentions on ${surface}`, () => {
    test('a .docx is read as its markdown, and the context names the original and the losses', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      const result = await mention($, SPEC)

      expect(seen.mentionReads).toEqual([MD])
      expect(result.context?.[0]).toBe(
        `${SPEC} was converted to markdown by VeroDotto (mammoth 1.13.0); what you read is that markdown, from the VeroDotto cache. Lost: 2 images, 1 chart. The original is at ${SPEC} if you need what was lost.`,
      )
    })

    test('a .md or .png is read untouched, with no band', async ($, on) => {
      const seen = fakeWorld(on, { files: { '/repo/a.md': 1, '/repo/b.png': 1 } })
      await start($)
      const ui = await band($)
      await mention($, '/repo/a.md')
      await mention($, '/repo/b.png')

      expect(seen.mentionReads).toEqual(['/repo/a.md', '/repo/b.png'])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
      expect(await ui.find({ type: 'Text' })).toBeUndefined()
    })

    test('converters not ready: read as it is, and the band says why', async ($, on) => {
      const seen = fakeWorld(on, { status: 'preparing' })
      await start($)
      const ui = await band($)
      await mention($, SPEC)

      expect(seen.mentionReads).toEqual([SPEC])
      expect(await ui.find({ type: 'Text', text: 'spec.docx read as is: converters preparing' })).toBeDefined()
    })

    test('a hand-kept sibling wins over converting', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 1000, [`${SPEC}.md`]: 2000 } })
      await start($)
      const result = await mention($, SPEC)

      expect(seen.mentionReads).toEqual([`${SPEC}.md`])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
      expect(result.context?.[0]).toBe(`This is the hand-kept markdown of ${SPEC} (${SPEC}.md), read by VeroDotto in its place.`)
    })

    test('a copy whose date cannot be read is still used, never sent on to converting', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 1000, [`${SPEC}.md`]: 2000 }, statFails: [`${SPEC}.md`] })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([`${SPEC}.md`])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
    })

    test('a copy whose original changed: a fresh conversion is read in the same request, the copy left alone', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 3000, [`${SPEC}.md`]: 2000 } })
      await start($)
      const ui = await band($)
      const result = await mention($, SPEC)

      expect(seen.mentionReads).toEqual([MD])
      expect(result.context?.[0]?.endsWith(`A hand-kept markdown copy, ${SPEC}.md, is older than the original and was not used; the person can update it from the band.`)).toBe(true)
      expect(
        await ui.find({
          type: 'Text',
          text: 'spec.docx \u2192 markdown \u00b7 \u2248 4.2k vs 31k tokens (\u221286%) \u00b7 lost: 2 images, 1 chart \u00b7 \u26a0  spec.docx.md older, not used',
        }),
      ).toBeDefined()
      expect((await ui.find({ key: 'vd-save' }))?.text).toBe('Update spec.docx.md')
      expect(seen.ran.some(argv => argv[2] === 'save')).toBe(false)
    })

    test('Update <name>.md asks, then overwrites the copy', async ($, on) => {
      const world: World = { files: { [SPEC]: 3000, [`${SPEC}.md`]: 2000 }, save: 'exists' }
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-save' })
      expect(await ui.find({ type: 'Text', text: 'Overwrite spec.docx.md?' })).toBeDefined()

      world.save = 'saved'
      await ui.press({ key: 'vd-save-yes' })
      const forced = seen.ran.filter(argv => argv[2] === 'save' && argv.includes('--force'))
      expect(forced.map(argv => argv.slice(3))).toEqual([[`${CACHE}/docs/repodocsspecdocx`, `${SPEC}.md`, '--force']])
      expect(seen.toasts).toEqual(['Saved spec.docx.md'])
      expect(await ui.find({ key: 'vd-save' })).toBeUndefined()
    })

    test('No keeps the hand-kept copy as it is', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 3000, [`${SPEC}.md`]: 2000 }, save: 'exists' })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-save' })
      await ui.press({ key: 'vd-save-no' })
      expect(seen.ran.some(argv => argv[2] === 'save' && argv.includes('--force'))).toBe(false)
      expect(await ui.find({ key: 'vd-save' })).toBeDefined()
    })

    test('a copy VeroDotto saved is compared by content: a touched original is no change', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 3000, [`${SPEC}.md`]: 2000 }, sibling: 'fresh' })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([`${SPEC}.md`])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
    })

    test('... and an edited original is, whatever the dates say', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 1000, [`${SPEC}.md`]: 2000 }, sibling: 'stale' })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])
    })

    test('where no conversion can be made, the older copy is read, with the warning', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 3000, [`${SPEC}.md`]: 2000 }, status: 'preparing' })
      await start($)
      const ui = await band($)
      const result = await mention($, SPEC)
      expect(seen.mentionReads).toEqual([`${SPEC}.md`])
      expect(result.context?.[0]?.includes('VeroDotto could not convert it now. Do not convert the original yourself')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /original changed since$/ })).toBeDefined()
    })

    test('a saving below the threshold keeps the original, and the band says so', async ($, on) => {
      const seen = fakeWorld(on, { conversions: { [SPEC]: { mdTokens: 95, origTokens: 100 } } })
      await start($)
      const ui = await band($)
      const result = await mention($, SPEC)

      expect(seen.mentionReads).toEqual([SPEC])
      expect(result.context).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'spec.docx kept as is (saving only ≈ 5%)' })).toBeDefined()
    })

    test('the threshold is an option', { options: { minSavingPercent: 3 } }, async ($, on) => {
      const seen = fakeWorld(on, { conversions: { [SPEC]: { mdTokens: 95, origTokens: 100 } } })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])
    })

    test('a conversion that fails or times out reads the original: never worse than no plugin', async ($, on) => {
      const seen = fakeWorld(on, { isConvertThrowing: true })
      await start($)
      const result = await mention($, SPEC)

      expect(seen.mentionReads).toEqual([SPEC])
      expect(result.type).toBe('file')
    })

    test('a scanned PDF is kept', async ($, on) => {
      const pdf = '/repo/scan.pdf'
      const seen = fakeWorld(on, { files: { [pdf]: 1 }, conversions: { [pdf]: { keep: 'little-text', ext: '.pdf' } } })
      await start($)
      await mention($, pdf)
      expect(seen.mentionReads).toEqual([pdf])
    })
  })

  describe(`the band on ${surface}`, () => {
    test('drawn after a conversion, gone after the next prompt', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      // the engine's own order: a prompt's mentions are read before prompt.submit
      await mention($, SPEC)
      await submit($, '@docs/spec.docx summarise it')

      expect(
        await ui.find({
          type: 'Text',
          text: 'spec.docx → markdown · ≈ 4.2k vs 31k tokens (−86%) · lost: 2 images, 1 chart',
        }),
      ).toBeDefined()
      await endTurn($)
      // still there after the turn, until the next prompt
      expect(await ui.find({ key: 'vd-hide-band' })).toBeDefined()
      await submit($, 'thanks')
      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
    })

    test('the next prompt\'s mention replaces the band, whichever event comes first', async ($, on) => {
      const other = '/repo/b.xlsx'
      fakeWorld(on, { files: { [SPEC]: 1, [other]: 1 }, conversions: { [SPEC]: {}, [other]: { ext: '.xlsx' } } })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await submit($, '@docs/spec.docx')
      await endTurn($)
      await mention($, other)
      await submit($, '@b.xlsx')

      expect(await ui.find({ type: 'Text', text: /^b\.xlsx \u2192 markdown/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /spec\.docx/ })).toBeUndefined()
    })

    test('a prompt typed while the turn runs leaves the band alone', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await submit($, 'and also this')
      expect(await ui.find({ key: 'vd-hide-band' })).toBeDefined()
    })

    test('several mentions are totalled in one row', async ($, on) => {
      const other = '/repo/b.xlsx'
      fakeWorld(on, { files: { [SPEC]: 1, [other]: 1 }, conversions: { [SPEC]: {}, [other]: { mdTokens: 6800, origTokens: 37000, ext: '.xlsx' } } })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await mention($, other)

      expect(await ui.find({ type: 'Text', text: /^2 files → markdown · ≈ 11k vs 68k tokens \(−84%\)$/ })).toBeDefined()
      expect(await ui.find({ key: 'vd-save' })).toBeUndefined()
    })

    test('× closes it without a trace', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-hide-band' })

      expect(await ui.find({ type: 'Text' })).toBeUndefined()
      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
    })

    test('nothing to show draws nothing', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
    })

    test('Save copies the markdown next to the original', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-save' })

      const saves = seen.ran.filter(argv => argv[2] === 'save')
      expect(saves.map(argv => argv.slice(3))).toEqual([[`${CACHE}/docs/repodocsspecdocx`, `${SPEC}.md`]])
      expect(seen.toasts).toEqual(['Saved spec.docx.md'])
      expect(await ui.find({ key: 'vd-save' })).toBeUndefined()
    })

    test('Save over an existing copy asks first, then overwrites', async ($, on) => {
      const world: World = { save: 'exists' }
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-save' })

      expect(await ui.find({ type: 'Text', text: 'Overwrite spec.docx.md?' })).toBeDefined()
      await ui.press({ key: 'vd-save-no' })
      expect(await ui.find({ key: 'vd-save-yes' })).toBeUndefined()

      await ui.press({ key: 'vd-save' })
      world.save = 'saved'
      await ui.press({ key: 'vd-save-yes' })
      const forced = seen.ran.filter(argv => argv[2] === 'save' && argv.includes('--force'))
      expect(forced.length).toBe(1)
      expect(seen.toasts.length).toBe(1)
    })
  })

  describe(`Read on ${surface}`, () => {
    test('a .docx is read as its markdown, told once per session', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      const first = await readFile($, SPEC)
      const second = await readFile($, SPEC, { offset: 10, limit: 5 })

      expect(seen.toolReads).toEqual([MD, MD])
      expect(first.context?.length).toBe(1)
      expect(second.context).toBeUndefined()
      // the original's verdict was asked; the cache path is answered from it
      expect(seen.checks.includes(SPEC)).toBe(true)
    })

    test('offset and limit carry over to the markdown', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await readFile($, SPEC, { offset: 10, limit: 5 })
      expect(seen.offsets).toEqual([[10, 5]])
    })

    test('a PDF read by pages is left alone', async ($, on) => {
      const pdf = '/repo/a.pdf'
      const seen = fakeWorld(on, { files: { [pdf]: 1 }, conversions: { [pdf]: { ext: '.pdf' } } })
      await start($)
      await readFile($, pdf, { pages: '1-3' })

      expect(seen.toolReads).toEqual([pdf])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
    })

    test('a deny rule on the original stands: the read is not redirected', async ($, on) => {
      const seen = fakeWorld(on, { verdict: 'deny' })
      await start($)
      await readFile($, SPEC)
      expect(seen.toolReads).toEqual([SPEC])
    })

    test('a file Claude opened itself draws no band by default', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      await readFile($, SPEC)
      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
    })

    test('with bandForReads it does', { options: { bandForReads: true } }, async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      await readFile($, SPEC)
      expect(await ui.find({ key: 'vd-hide-band' })).toBeDefined()
    })
  })

  describe(`paths written in the prompt on ${surface}`, () => {
    test('one context line, never the content; the conversion starts at once', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await submit($, 'please summarise "docs/spec.docx"')
      await settle($)

      expect(seen.contexts).toEqual([['docs/spec.docx is available as markdown through Read (VeroDotto).']])
      expect(seen.ran.filter(argv => argv[2] === 'convert').length).toBe(1)
    })

    test('the Read that follows is served from that conversion', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await submit($, 'please summarise docs/spec.docx')
      await readFile($, SPEC)

      expect(seen.toolReads).toEqual([MD])
      expect(seen.ran.filter(argv => argv[2] === 'convert').length).toBe(1)
    })

    test('a missing file adds nothing', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await submit($, 'what about docs/other.docx?')
      expect(seen.contexts).toEqual([undefined])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
    })

    test('a file also @-mentioned is handled once, by the mention', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await submit($, 'compare @docs/spec.docx with docs/spec.docx')
      expect(seen.contexts).toEqual([undefined])
    })

    test('at most ten paths a prompt', async ($, on) => {
      const names = Array.from({ length: 12 }, (_, i) => `/repo/f${i}.docx`)
      const seen = fakeWorld(on, {
        files: Object.fromEntries(names.map(n => [n, 1])),
        conversions: Object.fromEntries(names.map(n => [n, {}])),
      })
      await start($)
      await submit($, names.map(n => n.replace('/repo/', '')).join(' '))
      await settle($)
      expect(seen.contexts[0]?.length).toBe(10)
      expect(seen.ran.filter(argv => argv[2] === 'convert').length).toBe(10)
    })
  })

  const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [surface], tools: ['Read'], outputStyle: null, traits: [] }

  describe(`the system note on ${surface}`, () => {
    test('added when the converters are ready, last, for the session', async ($, on) => {
      fakeWorld(on)
      await start($)
      const { sections } = await $.prompt.compose(COMPOSE)
      const note = sections[sections.length - 1]
      expect(note?.id).toBe('vero-dotto:documents')
      expect(note?.scope).toBe('session')
      expect(note?.text.startsWith('Documents (.docx .xlsx .xls .pptx .pdf .odt .ods .odp .rtf .epub .html .msg .eml): open them with the Read tool.')).toBe(true)
    })

    test('where prompt.compose never reaches the plugin, the note rides the first prompt, once', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await submit($, 'hello')
      await submit($, 'again')
      expect(seen.notes).toEqual([1, 0])
    })

    test('where it does, no prompt carries it', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await $.prompt.compose(COMPOSE)
      await submit($, 'hello')
      expect(seen.notes).toEqual([0])
    })

    test('absent when they are not', async ($, on) => {
      fakeWorld(on, { status: 'missing' }, { setupFailures: 1, setupFailedAt: Date.now() })
      await start($)
      const { sections } = await $.prompt.compose(COMPOSE)
      expect(sections.map(s => s.id)).toEqual(['intro'])
    })
  })

  describe(`the Bash nudge on ${surface}`, () => {
    test('a parser on a document runs unchanged, then a note, once per file', async ($, on) => {
      fakeWorld(on)
      await start($)
      const first = await $.tool.call({ tool: 'Bash', command: 'unzip -p docs/spec.docx word/document.xml' } as never)
      const second = await $.tool.call({ tool: 'Bash', command: 'python3 parse.py docs/spec.docx' } as never)

      expect(first.context).toEqual(['Note: `Read docs/spec.docx` gives clean markdown via VeroDotto.'])
      expect(second.context).toBeUndefined()
    })

    test('a listing gets no note', async ($, on) => {
      fakeWorld(on)
      await start($)
      const result = await $.tool.call({ tool: 'Bash', command: 'ls -la docs/spec.docx' } as never)
      expect(result.context).toBeUndefined()
    })
  })

  describe(`setup on ${surface}`, () => {
    test('a first session sets up in the background: a short notice, each step above the prompt, a ready toast', async ($, on) => {
      let release = () => {}
      const world: World = { status: 'missing', setupHold: new Promise<void>(done => (release = done)) }
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await settle($)

      expect(seen.ran.some(argv => argv[2] === 'setup')).toBe(true)
      expect(seen.toasts).toEqual(['VeroDotto: one-time setup started, see above the prompt'])
      expect(
        await ui.find({ type: 'Text', text: /^\u23f3 one-time setup \(~240 MB into ~\/\.cache\/verodotto\) \u00b7 2\/3 installing Python 3\.12 and the converters \(~200 MB\) \u00b7 0:\d\d$/ }),
      ).toBeDefined()
      // meanwhile documents pass through, and the band says why
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC])

      release()
      await settle($)
      expect(seen.toasts[1]).toBe('VeroDotto is ready: documents now read as markdown')
      expect(await ui.find({ type: 'Text', text: /one-time setup/ })).toBeUndefined()
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC, MD])
    })

    test('every toast fits one line', async ($, on) => {
      const seen = fakeWorld(on, { status: 'missing', setup: 'failed: could not download uv - check the network\n' })
      await start($)
      await settle($)
      for (const text of seen.toasts) expect(text.length <= 60).toBe(true)
    })

    test('a failed setup says why above the prompt, with Retry, until closed', async ($, on) => {
      const world: World = { status: 'missing', setup: 'failed: could not download uv - check the network\n' }
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await settle($)

      expect(seen.toasts[1]).toBe('VeroDotto setup failed, see above the prompt')
      expect(await ui.find({ type: 'Text', text: '\u26a0  setup failed: could not download uv - check the network' })).toBeDefined()
      expect((await run($, '')).text?.includes('setup failed: could not download uv')).toBe(true)

      world.setup = 'ready\n'
      await ui.press({ key: 'vd-retry-setup' })
      await settle($)
      expect(await ui.find({ key: 'vd-retry-setup' })).toBeUndefined()
      expect(seen.toasts[seen.toasts.length - 1]).toBe('VeroDotto is ready: documents now read as markdown')
    })

    test('the failed row closes with its \u00d7', async ($, on) => {
      fakeWorld(on, { status: 'missing', setup: 'failed: no network\n' })
      await start($)
      const ui = await band($)
      await settle($)
      await ui.press({ key: 'vd-hide-setup' })
      expect(await ui.find({ key: 'vd-retry-setup' })).toBeUndefined()
    })

    test('a setup another session runs is named, and this one does not start its own', async ($, on) => {
      const seen = fakeWorld(on, { status: 'preparing' })
      await start($)
      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: /another Claude Code session is running it$/ })).toBeDefined()
      expect(seen.ran.some(argv => argv[2] === 'setup')).toBe(false)
    })

    test('autoSetup off: nothing is downloaded, and /vero-dotto says why', { options: { autoSetup: false } }, async ($, on) => {
      const seen = fakeWorld(on, { status: 'missing' })
      await start($)
      expect(seen.ran.some(argv => argv[2] === 'setup')).toBe(false)
      expect(seen.toasts).toEqual([])
      expect((await run($, '')).text?.startsWith('**VeroDotto** - *Read true. Spend less.*\nStatus: not set up (autoSetup is off) - run /vero-dotto setup')).toBe(true)
      expect((await run($, '')).text?.includes('Options changed from defaults: autoSetup = false')).toBe(true)
    })

  })

  describe(`the source check on ${surface}`, () => {
    const FOREIGN = '/h/.claude/plugins/cache/some-marketplace/vero-dotto/1.0.0'
    const HOME = '/h/.claude/plugins/cache/vero-plugins/vero-dotto/1.0.0'
    const MOVE = [
      '/plugin marketplace add GomelHawk/VeroPlugins',
      '/plugin install vero-dotto@vero-plugins',
      '/plugin uninstall vero-dotto@some-marketplace',
    ]

    test('a copy from another marketplace does nothing: no setup, no conversion, no note, one toast', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: FOREIGN, status: 'missing' })
      await start($)
      await settle($)
      await mention($, SPEC)
      await readFile($, SPEC)
      await submit($, 'please summarise docs/spec.docx')
      const { sections } = await $.prompt.compose(COMPOSE)

      expect(seen.ran).toEqual([])
      expect(seen.mentionReads).toEqual([SPEC])
      expect(seen.toolReads).toEqual([SPEC])
      expect(seen.contexts).toEqual([undefined])
      expect(sections.map(s => s.id)).toEqual(['intro'])
      expect(seen.toasts).toEqual(['VeroDotto is paused: installed from some-marketplace. See the band above the prompt to move it to VeroPlugins.'])
      await $.turn.start({ turnId: 't2', text: 'next' } as never)
      expect(seen.toasts.length).toBe(1)
    })

    test('the command answers the message, whatever the subcommand', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: FOREIGN })
      await start($)
      const text = (await run($, '')).text ?? ''
      expect(text.startsWith('**VeroDotto is paused.** It was installed from `some-marketplace`')).toBe(true)
      expect(text).toContain(MOVE.join('\n    '))
      expect(text).toContain("Your data is kept (VeroDotto's converters and converted documents live in ~/.cache/verodotto).")
      expect((await run($, 'stats')).text).toBe(text)
      expect((await run($, 'purge')).text).toBe(text)
      expect((await run($, 'setup')).text).toBe(text)
      expect(seen.ran).toEqual([])
    })

    test('the band shows the three buttons and no \u00d7; each fills exactly its command', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: FOREIGN })
      await start($)
      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: '\u26d4 VeroDotto is paused - it was installed from some-marketplace. Vero plugins install only from VeroPlugins.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'then restart Claude Code' })).toBeDefined()
      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', text: '\u00d7' })).toBeUndefined()
      for (const [i, label] of ['1 \u2193 Add VeroPlugins', '2 \u2193 Install from VeroPlugins', '3 \u2193 Remove this copy'].entries()) {
        expect(await ui.find({ key: `vd-move:${i + 1}`, text: label })).toBeDefined()
        await ui.press({ key: `vd-move:${i + 1}` })
      }
      expect(seen.filled).toEqual(MOVE.map(cmd => [cmd, 'replace']))
    })

    test('a draft in the prompt box is asked about first', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: FOREIGN })
      seen.draft = 'half a question'
      await start($)
      const ui = await band($)
      await ui.press({ key: 'vd-move:2' })
      expect(seen.filled).toEqual([])
      expect(await ui.find({ type: 'Text', text: 'Replace your draft?' })).toBeDefined()
      expect(await ui.find({ key: 'vd-move:2' })).toBeUndefined()
      await ui.press({ key: 'vd-move:cancel' })
      expect(seen.filled).toEqual([])
      expect(await ui.find({ key: 'vd-move:2' })).toBeDefined()
      await ui.press({ key: 'vd-move:2' })
      await ui.press({ key: 'vd-move:replace' })
      expect(seen.filled).toEqual([[MOVE[1], 'replace']])
      expect(await ui.find({ key: 'vd-move:replace' })).toBeUndefined()
    })

    test('a refused fill says so in a toast', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: FOREIGN, isFillRefused: true })
      await start($)
      const ui = await band($)
      await ui.press({ key: 'vd-move:1' })
      expect(seen.toasts.at(-1)).toBe('VeroDotto: close the dialog and press the button again.')
    })

    test('once moved, the next turn resumes normal work in the same session', async ($, on) => {
      const world: World = { testRoot: FOREIGN }
      const seen = fakeWorld(on, world)
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC])
      world.testRoot = HOME
      await $.turn.start({ turnId: 't2', text: 'next' } as never)
      await settle($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC, MD])
      const ui = await band($)
      expect(await ui.find({ key: 'vd-move:1' })).toBeUndefined()
    })

    test('a home copy beside an old copy of itself pauses with one Remove button', async ($, on) => {
      const world: World = { testRoot: HOME, settings: { project: { enabledPlugins: { 'vero-dotto@old-place': true } } } }
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC])
      expect(seen.ran).toEqual([])
      expect(seen.toasts).toEqual(['VeroDotto is paused: an old copy from old-place is still installed. See the band above the prompt.'])
      expect(await ui.find({ type: 'Text', text: '\u26d4 VeroDotto is paused - an old copy from old-place is still installed. Remove it, then restart.' })).toBeDefined()
      expect(await ui.find({ key: 'vd-move:1' })).toBeUndefined()
      await ui.press({ key: 'vd-move:remove' })
      expect(seen.filled).toEqual([['/plugin uninstall vero-dotto@old-place --scope project', 'replace']])
      expect((await run($, '')).text).toContain('/plugin uninstall vero-dotto@old-place --scope project')

      world.settings = {}
      await $.turn.start({ turnId: 't2', text: 'next' } as never)
      await settle($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC, MD])
      expect(await ui.find({ key: 'vd-move:remove' })).toBeUndefined()
    })

    test('a working copy re-reads its source at most every 10 seconds', async ($, on) => {
      const world: World = { testRoot: HOME }
      const seen = fakeWorld(on, world)
      await start($)
      // an old copy appears right away: not looked for yet, so the next turn still converts
      world.settings = { user: { enabledPlugins: { 'vero-dotto@old-place': true } } }
      await seen.clock.advance(9_000)
      await $.turn.start({ turnId: 't2', text: 'next' } as never)
      await settle($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])
      // ten seconds on: looked for, found, and the copy pauses
      await seen.clock.advance(1_000)
      await $.turn.start({ turnId: 't3', text: 'next' } as never)
      await settle($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD, SPEC])
      const ui = await band($)
      expect(await ui.find({ key: 'vd-move:remove' })).toBeDefined()
    })

    test('a development copy and a home copy work as before', async ($, on) => {
      const seen = fakeWorld(on, { testRoot: HOME })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])
      expect(seen.toasts).toEqual([])
    })
  })

  describe(`limits and pause on ${surface}`, () => {
    const BIG = 150 * 1024 * 1024

    test('a file over maxFileMb is read as is, with one notice', async ($, on) => {
      const seen = fakeWorld(on, { sizes: { [SPEC]: BIG } })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await mention($, SPEC)

      expect(seen.mentionReads).toEqual([SPEC, SPEC])
      expect(seen.ran.some(argv => argv[2] === 'convert')).toBe(false)
      expect(seen.toasts).toEqual(['VeroDotto skipped spec.docx: 150 MB > 100 MB'])
      expect(await ui.find({ type: 'Text', text: 'spec.docx skipped: 150 MB > 100 MB limit' })).toBeDefined()
    })

    test('the limit is an option', { options: { maxFileMb: 200 } }, async ($, on) => {
      const seen = fakeWorld(on, { sizes: { [SPEC]: BIG } })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])
    })

    test('a hand-kept sibling is read even for a big original', async ($, on) => {
      const seen = fakeWorld(on, { files: { [SPEC]: 1, [`${SPEC}.md`]: 2 }, sizes: { [SPEC]: BIG } })
      await start($)
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([`${SPEC}.md`])
      expect(seen.toasts).toEqual([])
    })

    test('/vero-dotto off: everything passes through, the band says so, Resume turns it back on', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      const ui = await band($)
      expect((await run($, 'off')).text?.startsWith('VeroDotto is paused for this session')).toBe(true)

      await mention($, SPEC)
      await readFile($, SPEC)
      const { sections } = await $.prompt.compose(COMPOSE)
      expect(seen.mentionReads).toEqual([SPEC])
      expect(seen.toolReads).toEqual([SPEC])
      expect(sections.map(s => s.id)).toEqual(['intro'])
      expect(await ui.find({ type: 'Text', text: /^\u23f8  paused for this session/ })).toBeDefined()
      expect((await run($, '')).text?.includes('Paused for this session')).toBe(true)

      await ui.press({ key: 'vd-resume' })
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([SPEC, MD])
      expect(await ui.find({ key: 'vd-resume' })).toBeUndefined()
    })

    test('/vero-dotto on resumes; a new session starts on', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      await run($, 'off')
      expect((await run($, 'on')).text).toBe('VeroDotto is on again: documents are read as markdown.')
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD])

      await run($, 'off')
      await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
      await mention($, SPEC)
      expect(seen.mentionReads).toEqual([MD, MD])
    })
  })

  describe(`sharing the band on ${surface}`, () => {
    const DIFF = 'VeroDiff turn 3 \u00b7 1 file \u00b7 +15 \u221215'

    test('another plugin\'s row stays, under ours', async ($, on) => {
      fakeWorld(on, { belowRow: DIFF })
      await start($)
      const ui = await band($)
      await mention($, SPEC)

      expect(await ui.find({ type: 'Text', text: /^spec\.docx \u2192 markdown/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: DIFF })).toBeDefined()
    })

    test('our \u00d7 closes our row only', async ($, on) => {
      fakeWorld(on, { belowRow: DIFF })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await ui.press({ key: 'vd-hide-band' })

      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: DIFF })).toBeDefined()
    })

    test('with nothing of ours, the band is theirs alone', async ($, on) => {
      fakeWorld(on, { belowRow: DIFF })
      await start($)
      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: DIFF })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /VeroDotto/ })).toBeUndefined()
    })

    test('the setup row and the files row stack above theirs', async ($, on) => {
      fakeWorld(on, { belowRow: DIFF, status: 'preparing' })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      expect(await ui.find({ type: 'Text', text: /^\u23f3 one-time setup/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'spec.docx read as is: converters preparing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: DIFF })).toBeDefined()
    })
  })

  describe(`a file Claude already holds on ${surface}`, () => {
    test('a Read the engine answers "unchanged" says so in the band, and saves nothing', async ($, on) => {
      const world: World = {}
      const seen = fakeWorld(on, world)
      await start($)
      const ui = await band($)
      await submit($, 'what is in docs/book.docx and docs/spec.docx?')
      await settle($)
      world.isUnchanged = true
      await readFile($, SPEC)

      expect(await ui.find({ type: 'Text', text: 'spec.docx already read, nothing sent' })).toBeDefined()
      // the conversion is in the cache: Save is still on offer
      expect((await ui.find({ key: 'vd-save' }))?.text).toBe('Save markdown next to original')
      await ui.press({ key: 'vd-save' })
      expect(seen.toasts).toEqual(['Saved spec.docx.md'])
      expect((await run($, 'stats')).text?.startsWith('**This session**: 0 reads')).toBe(true)
    })

    test('a repeated mention the same', async ($, on) => {
      fakeWorld(on, { isUnchanged: true })
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      expect(await ui.find({ type: 'Text', text: 'spec.docx already read, nothing sent' })).toBeDefined()
      expect((await run($, 'stats')).text?.startsWith('**This session**: 0 reads')).toBe(true)
    })

    test('a first read counts', async ($, on) => {
      fakeWorld(on)
      await start($)
      await mention($, SPEC)
      expect((await run($, 'stats')).text?.startsWith('**This session**: 1 read')).toBe(true)
    })
  })

  describe(`the command on ${surface}`, () => {
    test('/vero-dotto: status, versions, cache, formats', async ($, on) => {
      fakeWorld(on)
      await start($)
      const text = (await run($, '')).text ?? ''
      expect(text.startsWith('**VeroDotto** - *Read true. Spend less.*\nStatus: ready')).toBe(true)
      expect(text.includes('uv 0.12.24 (bundled), mammoth 1.13.0')).toBe(true)
      expect(text.includes(`Cache: ${CACHE} - conversions 2 MB (3), converters 600 MB`)).toBe(true)
    })

    test('/vero-dotto stats counts the session and all time', async ($, on) => {
      fakeWorld(on, {}, { allTime: { conversions: 5, reads: 9, saved: 100000, kept: 1, byFormat: {} } })
      await start($)
      await mention($, SPEC)
      const text = (await run($, 'stats')).text ?? ''
      expect(text.includes('**This session**: 1 read served as markdown (1 new conversion), ≈ 27k tokens saved (est.), 0 kept as original')).toBe(true)
      expect(text.includes('- .docx: 1 read, ≈ 27k saved')).toBe(true)
      expect(text.includes('**All time**: 10 reads')).toBe(true)
    })

    test('/vero-dotto show prints the numbers and the head of the markdown', async ($, on) => {
      fakeWorld(on)
      await start($)
      const text = (await run($, 'show docs/spec.docx')).text ?? ''
      expect(text.startsWith('**spec.docx** (30 KB, mammoth 1.13.0)')).toBe(true)
      expect(text.includes('the original ≈ at least 31k (−86%, est.)')).toBe(true)
      expect(text.includes('```markdown\n# Product specification')).toBe(true)
    })

    test('/vero-dotto save writes the copy for a file the band no longer shows', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      expect((await run($, 'save docs/spec.docx')).text).toBe('Saved spec.docx.md - VeroDotto will use it instead of converting spec.docx.')
      expect(seen.ran.some(argv => argv[2] === 'save')).toBe(true)
    })

    test('/vero-dotto purge removes the cache', async ($, on) => {
      const seen = fakeWorld(on)
      await start($)
      expect((await run($, 'purge')).text?.startsWith(`Removed ${CACHE}`)).toBe(true)
      expect(seen.ran.some(argv => argv[2] === 'purge')).toBe(true)
    })

    test('/vero-dotto purge refuses an odd path', async ($, on) => {
      fakeWorld(on, { where: '/home/me', purge: ['refused: /home/me is not a VeroDotto cache\n', 1] })
      await start($)
      expect((await run($, 'purge')).text).toBe('Refusing to delete /home/me: not a VeroDotto cache.')
    })

    test('a /clear empties what the model was told and the band', async ($, on) => {
      fakeWorld(on)
      await start($)
      const ui = await band($)
      await mention($, SPEC)
      await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })

      expect(await ui.find({ key: 'vd-hide-band' })).toBeUndefined()
      const again = await readFile($, SPEC)
      expect(again.context?.length).toBe(1)
    })
  })
}
