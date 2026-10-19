// What `verodotto.sh convert` prints of one conversion (its meta.json), as the module
// reads it. Token counts are estimates (README: "How the numbers are estimated").
// `keep` is the converter's own verdict: `little-text` for a PDF with under 200
// characters a page (a scan, drawings), `empty` when nothing came out.
export type Meta = {
  source: string
  ext: string
  size: number
  mdChars: number
  mdTokens: number
  origTokens: number
  // the original's estimate is a floor (the raw XML text of an Office file)
  isLowerBound: boolean
  lost: string[]
  converter: string
  kind: 'full' | 'summary'
  keep?: 'little-text' | 'empty'
  pages?: number
  convertedAt: string
}

// One file of the last prompt, as the band draws it.
// `converted`: read as markdown. `sibling`: the hand-kept `<file>.md` beside it was read.
// `kept`: the original was read as it is, `reason` says why. `pending`: a path written in
// the prompt whose conversion is still running. `unchanged`: the model already held this
// markdown, so the engine sent nothing again.
export type BandItem = {
  name: string
  path: string
  state: 'converted' | 'sibling' | 'kept' | 'pending' | 'unchanged'
  reason?: 'small-saving' | 'little-text' | 'doc' | 'preparing' | 'not-ready' | 'failed' | 'empty' | 'too-large'
  mdTokens?: number
  origTokens?: number
  saving?: number
  lost?: string[]
  // the conversion's folder in the cache, what Save copies from
  docDir?: string
  // the hand-kept copy is older than the original (state `sibling`: it was read anyway,
  // no conversion could be made); `hasStaleCopy` (state `converted`): it was not read, a
  // fresh conversion was, and the band offers to update the copy
  isStale?: boolean
  hasStaleCopy?: boolean
  // for `too-large`: the file's size and the limit it is over, in MB
  sizeMb?: number
  limitMb?: number
  isSaved?: boolean
}

// Counts for `/vero-dotto stats`: this session in `view`, all time in `$.store`.
export type FormatStats = { reads: number; saved: number }
export type Stats = {
  conversions: number
  reads: number
  saved: number
  kept: number
  byFormat: Record<string, FormatStats>
}

// `ready`: whether the converters can run - `yes`, `preparing` (setup running), `failed`
// (`failReason` says why), `off` (autoSetup off and never set up), `unknown` before the
// first status check. `source`: where this copy was installed from (hooks/source-check.ts);
// a `foreign` copy does nothing but show how to move. `legacy`: an older copy of this
// plugin still enabled from another marketplace, which stops this one too until removed.
// `confirmingFill`: the move command a band button waits to put over a draft; '' for none.
// `isPaused`: `/vero-dotto off` - every file is read as it is until `/vero-dotto on` or
// the session ends.
export type View = {
  ready: 'yes' | 'preparing' | 'failed' | 'off' | 'unknown'
  failReason: string
  lastTurn: BandItem[]
  // the original whose Save waits for Yes or No; '' for none
  confirmingSave: string
  // files the model was told about once this session (Read context, Bash nudge)
  toldAbout: string[]
  session: Stats
  source: { kind: 'home' } | { kind: 'dev' } | { kind: 'foreign'; marketplace: string }
  legacy?: { marketplace: string; scope: 'user' | 'project' | 'local' }
  confirmingFill: string
  isPaused: boolean
  // setup in progress, as the band shows it: the step the script last reported ('' for a
  // setup another session runs), seconds since it started, and whether the person closed
  // the row of a failed setup
  // the band shows a turn that has ended: the next prompt's first mention, Read or the
  // prompt itself (whichever the engine raises first) clears it
  isBandStale: boolean
  setupStep: string
  setupElapsed: number
  isSetupNoteHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'vero-dotto': { view: View }
  }
}
