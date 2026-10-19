# VeroDotto - working notes

Context for continuing work on this repository. The current version is whatever
`plugins/vero-dotto/.claude-plugin/plugin.json` says; no other file states one. The
plugin's name is always written **VeroDotto** (display) or `vero-dotto` (key); the slogan
is *Read true. Spend less.*

## Working rules

- **A question gets an answer, nothing else.** When the owner asks for information -
  "how does X work", "what about Y", "why is Z" - reply with the information and change
  no files. Do not edit, stage, create or delete anything as a side effect of answering.
- **Ask before changing anything that was not asked for.** If you spot something worth
  changing - wrong documentation, a bug, a stale reference, an obvious improvement - say
  what it is and why it should change, then wait for a yes. Noticing a problem while
  doing something else is a reason to report it, not a licence to fix it. Approval for
  one change never extends to the next thing you notice.
- **Never commit.** Do not run `git commit`, `git push`, `git tag`, `git rebase` or
  anything else that writes history - not even when the work is finished, the tree is
  clean and the change is obviously correct. Editing files and staging them is fine;
  creating a commit is the repo owner's call, always.
- **Finish with a really short commit description.** When an implementation is done, hand
  back a one-line commit message for the owner to use. One line, no body, no explanation
  wrapped around it.
- **Documentation describes the plugin as it is, not its history.** No "was decided",
  "replaced", "earlier design" or similar in any published file; a section that moves a
  user from an older release is the one exception.

## What this is

A Claude Code plugin - a **mod**: one TypeScript hooks module, like VeroDiff 1.x - that
lets Claude read documents it otherwise cannot read well (Word, Excel, PowerPoint, PDF,
OpenDocument, HTML, EPUB, e-mail) as clean markdown, automatically, with fewer tokens. A
mention, a path written in the prompt or the model's own Read is converted once, cached
by content in `~/.cache/verodotto`, handed to the model as markdown, and the saving is
shown in a band above the prompt. *Read true. Spend less.*

Repository `GomelHawk/VeroDotto`, plugin `vero-dotto`, display name `VeroDotto`, command
`/vero-dotto`, MIT. English only, by the owner's decision. Installed only from
[VeroPlugins](https://github.com/GomelHawk/VeroPlugins) (marketplace `vero-plugins`), the
one catalog for every Vero plugin; that repository's CLAUDE.md has the catalog rules and
the canonical source check, and its STANDARD.md the rules every Vero plugin follows.

## Repository layout

```
VeroDotto/                                  the plugin's repository (no catalog: VeroPlugins is the marketplace)
├── .gitattributes                          forces LF (scripts are bash); fixtures are bytes
├── .github/workflows/ci.yml                manifests + tests, shell, python, smoke, convert, endings
├── .github/workflows/release.yml           a v* tag tells VeroPlugins' CI to re-check the entry
├── .github/dependabot.yml                  github-actions only (Python pins are in convert.py)
├── assets/                                 logo.png, horizontal-logo.png
├── tests/smoke.sh                          verodotto.sh's suite: bash + coreutils, a fake uv
├── tests/convert.sh                        real conversions of every fixture (network once)
├── tests/fixtures/                         one tiny file per format + .expect / .reject
├── tests/make-fixtures.py                  regenerates the fixtures; run by hand, output committed
├── install.sh                              validate -> VeroPlugins marketplace add -> plugin install (--scope)
├── uninstall.sh                            plugin uninstall (+ --scope, --purge)
├── CLAUDE.md                               this file
├── CONTRIBUTING.md                         testing, CI, publishing
├── README.md                               user docs (byte-identical copy in the plugin)
└── plugins/vero-dotto/
    ├── .claude-plugin/plugin.json          name, version, userConfig, "types"
    ├── hooks/hooks.json                    { "modules": ["./register.tsx"] } and nothing else
    ├── hooks/register.tsx                  the mod: hooks, band, command
    ├── hooks/rules.ts                      pure: formats, decisions, estimates, band text, paths
    ├── hooks/source-check.ts               the source check, byte-identical to VeroPlugins/shared/hooks
    ├── types/index.d.ts                    PluginState['vero-dotto']
    ├── scripts/verodotto.sh                where / status / setup / convert / save / sibling / sizes / clean / purge
    ├── scripts/convert.py                  PEP 723 script: the converters
    ├── tests/rules.test.ts                 claude plugin test: rules.ts
    ├── tests/hooks.test.ts                 claude plugin test: every hook, both surfaces
    ├── tests/source-check.test.ts          claude plugin test: the source check's table (VeroPlugins/shared/tests)
    ├── CHANGELOG.md
    ├── LICENSE
    └── README.md
```

## How it works

**`verodotto.sh`** is the one shell entry point and the only place that knows the cache
layout; the module asks it (`where`), never recomputes. Cache:
`${VERODOTTO_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/verodotto}` - `bin/uv` (absent when a
system uv ≥ 0.5 is used), `python/` and `uv-cache/` (uv's own, private), `ready` (setup
marker, one-line JSON), `setup.lock/` (only while setting up; stale after 15 min),
`docs/<key>/{doc.md,meta.json}`, `index.tsv` (key, last used, reads, tokens saved),
`memo.tsv` (path+size+mtime → sha, so an unchanged file is not re-hashed).
Every uv call goes through `run_uv()`: private `UV_CACHE_DIR` and `UV_PYTHON_INSTALL_DIR`,
`UV_PYTHON_PREFERENCE=only-managed`, `UV_NO_CONFIG=1`, `UV_PYTHON_INSTALL_BIN=0` (no link
in `~/.local/bin`), `UV_PYTHON_INSTALL_REGISTRY=0` (no Windows registry entry), and
`VIRTUAL_ENV`, `PYTHONPATH`, `PYTHONHOME` unset. Conversions run `--offline`.
`tests/convert.sh` runs everything with an empty `HOME` and fails if anything lands in it.

**Setup** (`setup`): lock by `mkdir`; uv from PATH, else the pinned release
(`UV_VERSION`, per-target SHA-256 in the script, never the `.sha256` next to the
download); `uv run --python 3.12 --script convert.py --selftest` installs the PEP 723
dependencies and converts one built-in sample per converter; then `ready` records the
dependency header's hash, uv's version and source, and the converters' versions.
`status` says `ready` only while that hash and (for our own uv) its version match - a
release that changes the pins sets up again, downloading only what changed.

**The module's setup flow**: `session.start` awaits `status` (one quick call); ready →
`view.ready = 'yes'`. Otherwise, with `autoSetup` and past the back-off (1 h, 6 h, 24 h,
`$.store` `setupFailures`/`setupFailedAt`), it starts `setup` in the background
(`setup()`, never awaited): a toast before the first download (`noticeShown`),
a toast with the outcome. Setup runs through `$.process.spawn`, so each `step: N/3 ...`
line the script writes to stderr lands in `view.setupStep` as it comes, and a
`$.clock.every(1000)` tick keeps `view.setupElapsed`; the band draws them as a row. A
failure leaves a row with the reason, **Retry** and **×** (`isSetupNoteHidden`); a
failure remembered from an earlier session (the back-off) draws none. `autoSetup` off →
`ready = 'off'`, only `/vero-dotto setup` downloads. Another session holding the lock
reads as `preparing` (row: "another Claude Code session is running it"); `turn.start`
re-checks.

**Closed mid-setup**: the spawned child dies with the session or module; the script's
trap removes the lock, and a lock left by a hard kill names a pid that is gone, so
`lock_is_fresh()` counts it stale at once (age only for a lock with no pid). `ready` is
written last, so a half setup is never ready; uv's cache keeps finished downloads, and a
rerun took 26 s instead of ~100 s (measured).

**Conversion** (`convert FILE`): key = sha256(file sha | convert.py's own hash | the three
size options), so a converter change or another option converts again. Output line 1 is
`<folder>TAB cached|new`, then `meta.json`. `convert.py` is a **lean stack** by the
owner's decision (~240 MB with uv and Python, against ~600 MB with markitdown + pandoc +
pandas): mammoth + markdownify for docx, python-pptx, openpyxl / xlrd / odfpy for sheets
(streamed: sized first, summarised past the limits), its own odfpy walker for odt and odp,
striprtf, pdfplumber for PDF (kept for its table detection, +10 MB: tables become markdown
tables in reading order), markdownify for html and epub (spine order), olefile for msg,
Python `email` for eml. It counts what markdown loses (images, charts, embedded objects,
formulas, attachments, summary rows), estimates tokens, and flags `keep: little-text` (PDF
under 200 chars a page) or `empty`. A watchdog thread ends it past `--timeout`.

**Decisions** (`rules.ts`): `classify()` → convert / keep / doc; `decide()` → serve, or
keep for `little-text`, `empty`, or a saving under `minSavingPercent` (a summary is always
served). Estimates: characters ÷ 4, ÷ 3 when over 30% of letters are non-Latin; original =
PDF pages × 1,600 + text, Office/ODF raw XML text (a floor), HTML/RTF/eml raw text.

**Flows** (all in `register.tsx`, every gating hook with a `.catch` that falls back to
`next(e)`, so failure is never worse than no plugin):

- **Siblings**: `siblingOf()` asks `verodotto.sh sibling` first - a copy VeroDotto saved
  is in `saves.tsv` with its original's checksum then, so fresh/stale is by content; a
  copy written by hand is `unknown` and file dates decide. A fresh copy is read. A stale
  one is passed over: the original is converted and that conversion is read in the same
  request (`staleCopy` on the outcome, `hasStaleCopy` on the band item, the context names
  the copy), served even under `minSavingPercent`; the copy itself is never written
  without Yes. Only when no conversion can be made (not ready, too large, failed) is the
  stale copy read, with a context that tells the model not to convert by hand. Decided
  with the owner: the earlier "Update from original" button came after the model had
  already read the old copy, which made it useless for that request.
- `outcomeOf()` order: classify → sibling `<path>.md` wins → over `maxFileMb` (stat) →
  kept as `too-large`, one toast per file per session (`skipNotified`) → not ready → as is
  → convert → decide.
- `prompt.mention` → `outcomeOf()`: sibling `<path>.md` wins; not ready → as is; convert →
  decide → `next({ ...e, path: doc.md })` + context naming the original and the losses.
  Band item recorded; stats counted.
- `tool.call {Read}` → the same, except a PDF read by `pages`; offset/limit carry over.
  Before redirecting it asks `$.tool.check` for the **original**: a deny stands (no
  redirect); otherwise the verdict is remembered in `redirects`, and the `tool.check
  {Read}` hook answers the cache path with it - so the redirect asks exactly when a Read of
  the original would have. Context once per file per session (`view.toldAbout`). No band
  unless `bandForReads`.
- **The band's lifetime**: `turn.complete` (main agent) sets `view.isBandStale`; the next
  prompt's first event - a mention, the submit, or a band-drawing Read - clears it
  (`freshBand()`). Never cleared at submit unconditionally: see the event-order gotcha.
- `prompt.submit` → `freshBand()`; `findPaths()` on the text (fenced code and `@`
  mentions left out), resolved against the session root, existing and convertible, at
  most 10: one context line each, never the content, and a background conversion kept in
  `pending` for the Read that follows. Also carries the system note's fallback (below).
- `prompt.compose` → the system note (`systemNote()`, generated from `CONVERTED`) as the
  last `session` section, while ready and not stopped or paused.
- `tool.call {Bash}` → runs unchanged; afterwards, for a parser command (`unzip`,
  `python`, `pandoc`, `pdftotext`, …) naming an existing document, one note per file per
  session.
- `ui.render AbovePrompt` → VeroDotto's rows - paused, setup, files - each led by a dim
  `VeroDotto` label like VeroDiff's, then **what `next(e)` drew beneath** (VeroDiff's
  row), in one column: the band is one site every plugin's hook passes in turn, and a
  hook that drew alone hid every plugin below it until its row was closed. Keys carry
  `vd-` so they never clash with another plugin's (both had `hide-band`). Files row:
  the band (`bandLine()`), Save markdown next to original (one converted
  file; labelled Update <name>.md when a stale copy was passed over), Yes / No, ×. `⚠` is always
  followed by two spaces (`WARN`): terminals draw it over the next cell;
  `next(e)` with nothing to show; steps aside for a survey.
- `command.run` → status, `on`, `off`, `stats`, `show`, `save`, `setup`, `clean`, `purge`.
  `off` sets `view.isPaused`: every hook passes through as when stopped (`isIdle()`), the
  band shows a paused row with **Resume**; `session.end` (and `/clear`) turns it back on.
- `session.end` (also `/clear`) → band, `toldAbout` and session stats emptied.

**Source check** (`hooks/source-check.ts`, the canonical copy is
`VeroPlugins/shared/hooks/source-check.ts`; never edit it here). `checkSource()` runs first
in `session.start` and again on `turn.start` - every turn while stopped, at most every
10 s (`RECHECK_MS`, `$.clock.now()`) while working: `sourceOf($.plugin.root)` reads the
marketplace off the root's `plugins/cache/<marketplace>/...` segment - `home` for
`vero-plugins`, `foreign` for any other, `dev` for a root outside the cache
(`--plugin-dir`, `claude plugin test`). A `dev` copy also reads `VERO_TEST_ROOT`
(`$.env.get`, the test seam; only a dev copy consults it, so no installed copy can opt
out). A `home` copy then reads `$.settings.read({ source })` for `user`, `project` and
`local` and `legacyCopies()` finds an older copy of `vero-dotto` still enabled from another
marketplace (`view.legacy`). Stopped = `foreign` or a legacy copy: every hook's first line
is `next(e)` (no status call, no setup, no conversion, no note, no prune, nothing written
to the cache); `session.start` registers the command and shows one toast; `/vero-dotto`
answers `stoppedMarkdown()` / `legacyMarkdown()` whatever the subcommand; the band draws
the stopped row every session, with no × - `stoppedBand()` and three buttons
(`vd-move:1..3`, `MOVE_LABELS`) that fill `moveSteps()` into the prompt box with
`$.prompt.fill` (`replace`), or `legacyBand()` and one button (`vd-move:remove`,
`removeStep()`); a draft in the box is asked about first (`view.confirmingFill`,
`REPLACE_QUESTION`, `vd-move:replace` / `vd-move:cancel`); a refused fill toasts
`fillRefusedToast()`. Nothing runs by itself. The next `turn.start` after the move
resumes normal work, preparing as a session start would.

**Pruning**: `session.start`, at most once a day (`prunedAt`), in the background:
`clean --days cacheDays --max-mb cacheMaxMb`. The toolchain is never pruned.

## Gotchas discovered the hard way

**Mod API (this build: Claude Code 2.1.299)**

- **`$` may only be passed to functions declared at the top level of the module.** A
  closure inside `register` taking `$` (`const setup = async ($) => ...`) fails the load:
  "$ is passed to "setup", which is not a function declared at the top of this file".
  Module-level `let` state is fine.
- **`prompt.compose` does not reach a user-installed plugin where an organization manages
  Claude Code** (`validate` says so; the debug log says `prompt.compose bypassed by
  cc-plugin-sec-default`). The system note then rides the session's first prompt as
  context (`isComposing`/`isNoteSent`). Verified headless on an org-managed machine.
- **A string literal in an `update()` callback widens to `string`** and fails the atom's
  union type; `patch($, { ready: 'yes' })` (a `Partial<View>` merge) keeps it narrow.
- **Name the command by a literal** in `$.command.register` and the `command.run`
  matcher, or `validate` lists the hook as a gate without `.catch`.
- **Never declare `hooks` in `plugin.json`**; `hooks.json` names the module and nothing
  else (smoke asserts it). **No top-level `bin/`.** **The catalog is VeroPlugins; never
  `version` in its entry.** Carried over from VeroDiff.
- **A plugin cannot read its own provenance.** `$.plugin` has `name` and `root` only;
  the `<name>@<marketplace>` string exists on the `plugin.register` event, which a plugin
  cannot hook for itself. The path is the source check.
- **`$.settings.read({ source: 'user' | 'project' | 'local' })`** gives that one file's
  object, `enabledPlugins` included, with no prompt; a scope with no file answers `{}`.
- **`$.env.get` takes a literal name** (`validate` lists them); the fake world answers
  `env.get` itself rather than `mock.env`, so a test can move `VERO_TEST_ROOT` mid-session.
- **`prompt.fill` is an event, not an op**: the hook beneath answers `{ isFilled, text }`,
  not `{ value }`; `prompt.read` is an op and answers `{ value }`.
- **The band is short by design**: one line at the terminal's width, so it carries the
  gist (`≈ 41 vs 391 tokens (−90%) · lost: 1 formula`) and the model's note carries the
  detail (`1 formula with no saved result (formula shown)`, via `shortLost()` for the
  band). The owner found the long form wrapping past the button.
- **A toast is one line, cut to the terminal's width**, and `$.ui.status` was not seen
  at all in the owner's live run. So progress and anything long go to the band; every
  toast is one short line (a test holds them to 60 characters) and points to the band or
  `/vero-dotto` for the rest. `$.ui.status` is not used (VeroDiff: it also draws as
  `⚠ <plugin>: …`).
- **`$.process.spawn` beneath the plugin in a test** is an async generator that yields
  `{ stream, text }` and returns `{ value: { code, signal } }` - `{ value }` like any op.
- **Test kit**: an op beneath the plugin answers `{ value }`, an event its result; one
  hook per event per test (a second `on('prompt.submit')` fails the load - record in
  `fakeWorld` instead); background work settles only across further round trips
  (`settle()` runs `/vero-dotto stats` a few times); `mock.clock` holds the guard's
  1-second wait until the test advances it; options go in `test(name, { options }, body)`;
  `$.prompt.compose` needs a full input (`promptModel` and all).

**Phase 0 answers** (checked headless with `claude -p --plugin-dir`, 2026-10-14)

1. `prompt.mention` redirected to `~/.cache/verodotto/...`: read with no permission
   prompt; the model got the markdown and the context.
2. `tool.call {Read}` rewritten to the cache path: no denial, once the `tool.check {Read}`
   hook answers the cache path with the original's verdict. The model's tool call still
   shows the original path; the result is the markdown.
3. Read on a `.docx` without the plugin: `This tool cannot read binary files. The file
   appears to be a binary .docx file. Use a skill for this file type if one is available,
   or a shell command or script that can read the format.` (quoted in the README).
4. `offset`/`limit` pass through; a PDF read with `pages` is never redirected (tests).
7. The note is one `session`-scope section, the same text each render; but see the
   managed-settings gotcha above.

- **A repeat read sends nothing.** The engine answers a Read of a file the model holds
  unchanged with `file_unchanged`, and a repeated mention with `already_read_file`; the
  band then says `<name> already read, nothing sent`, and stats
  count no read and no saving. Band and stats are written after `next`, from what was
  actually sent - not before, from the outcome.
- **The plan's "prompt.submit fires before mentions are read" is wrong** (debug log,
  2.1.300): `prompt.mention` settles first, then `prompt.submit`, then `turn.start`. A
  band cleared at submit was emptied right after the mention filled it - found live,
  missed by the tests, which raised the events in the plan's order. Tests now raise the
  engine's order.
- A redirected mention shows the **cache path** in the transcript
  (`Read ../vd-fresh/docs/<key>/doc.md (16 lines)`), checked live in the terminal.

Still open, for an interactive check: two `AbovePrompt` bands at once with VeroDiff, a
mention of a file over the engine's size limit (6), and how often the model reaches for
Bash without the note (8). The Bash nudge ships in 1.0 by the owner's decision.

**Shell and portability** (VeroDiff's, all apply)

- **Target bash 3.2** in every `.sh`: no `mapfile`/`readarray`, no fractional `read -t`,
  empty arrays as `${a[@]+"${a[@]}"}`, no quote in a comment inside a multi-line `$( )`.
  CI parses each script under `bash:3.2` in docker.
- **Cut text by characters, never `cut -c`** on user text (GNU cut counts bytes). The
  script cuts only hex hashes.
- **`sha256sum` and `shasum` prefix their line with `\\` when the file name holds a backslash**,
  which every Windows path does, so `sha256_file()` drops a leading backslash from the
  hash; the uv download's checksum check failed on the Windows runner with
  `got \\7c38...` before it did.
- **`sha256sum`, else `shasum -a 256`**; **GNU `stat -c`, else BSD `stat -f`**. macOS CI is
  the only place the second branches run.
- **On Windows** Claude Code runs Git Bash; the module calls `CLAUDE_CODE_GIT_BASH_PATH`
  when set, else `bash`. The script hands paths back through `cygpath -m` (`C:/…`, which
  Read opens) and takes them in through `cygpath -u`. uv for Windows is the `.zip`
  (`unzip`, else PowerShell's `Expand-Archive`); Windows on ARM uses the x64 build.
- **`.gitattributes` pinning `eol=lf` is load-bearing**; the fixtures are marked `-text`
  so their bytes never change.
- **Purge must not trust the path.** `is_cache_dir()` takes an absolute path named
  `verodotto`, or one holding `ready` or `docs/`; never `/` or `$HOME`. The module checks
  `isCacheDir()` first too.

**Converters**

- **Why not markitdown**: it hard-requires magika → onnxruntime (~60 MB, and no wheels for
  some platforms, e.g. musl), its xlsx path needs pandas + numpy (~110 MB), and VeroDotto
  picks converters by extension anyway. pandoc (`pypandoc_binary`) alone was ~155 MB for
  odt and rtf. The lean stack measures ~240 MB in all: uv 38, Python 108, converters ~94.
- **A loaded odfpy document's `.text` is a text node**, not `office:text`: walk
  `doc.body.getElementsByType(office.Text)`. And odfpy text nodes have no `qname` - read
  it through `qname()`.
- **An ODF table often ends in a row repeated a million times** (`number-rows-repeated`):
  `ods_rows()` never expands an empty repeat, and caps any at 1,000.
- **An ODS cell without `office:value-type` is no data** to most readers; the fixture
  generator sets it, as every real file does.
- **pandoc writes an RTF fragment without `--standalone`** (no `{\rtf1` header), which no
  RTF reader takes; the fixture generator passes it. Real RTF files have the header.
- **EPUB package files are XML**, read with `html.parser` (no lxml needed); its
  `XMLParsedAsHTMLWarning` is silenced, and `<?xml ?>`/doctype/comment nodes are dropped
  in `html_to_md()` or they leak into the markdown.
- **The context says the markdown came from the cache.** Without it the model noticed the
  `doc.md` path in the cache and wondered whether it read the right file.
- **`.msg` has no fixture**: nothing free writes one. `msg_md()` reads the MAPI streams
  (`__substg1.0_0037001F` subject, `1000` body, `0C1A`/`5D01` sender, `0E04`/`0E03`
  recipients, `__attach_version1.0_*` names); check it on a real file when touching it.
- **openpyxl writes formulas without cached values**, so a generated `.xlsx` shows `NaN`
  for them. Files saved by Excel or LibreOffice carry the values.

## Testing

```bash
tests/smoke.sh                              # verodotto.sh: bash + coreutils, fake uv
claude plugin test ./plugins/vero-dotto     # rules.ts, the source check's table, every hook, both surfaces
tests/convert.sh                            # every converter for real (network once)

claude plugin validate ./plugins/vero-dotto           # manifest, hooks module, state contract
claude plugin validate ./plugins/vero-dotto --strict  # for CI
```

Type-check: loading the plugin once with `--plugin-dir` in an interactive session lays
the engine's declarations into `plugins/vero-dotto/.claude-plugin/types/` (self-ignored)
and a `tsconfig.json` beside `plugin.json` (in `.gitignore`); then
`npx -p typescript tsc -p plugins/vero-dotto`.

Live, in a scratch repository with a fresh cache:

```bash
cd /some/test/repo
VERODOTTO_DIR=/tmp/vd claude --plugin-dir /path/to/VeroDotto/plugins/vero-dotto
```

Check: setup notice, progress, ready toast → `@spec.docx` → band, numbers, Save → a
second mention uses the sibling → a plain `"docs/other.docx"` → band + Read → the model
reading an `.xlsx` by itself → `/vero-dotto stats`, `show`, `clean`, `purge`. Also with
VeroDiff loaded: two bands, and VeroDiff's turn diff shows no cache files.

Add a case to `rules.test.ts` or `hooks.test.ts` for anything you fix in the module, to
`smoke.sh` for anything in `verodotto.sh`, and a fixture with `.expect` lines for a
converter change.

## Cutting a release

**Trigger.** The owner says "update version", "bump the version", "prepare a release" or
anything equivalent. Run the whole procedure; do not start it unprompted, and do not skip
steps because the change looks small.

### 1. Collect every change since the last release

```bash
# tags are plain `v<version>`, e.g. v1.0.0. A pattern that matches nothing fails silently
# and rebuilds a changelog for work already shipped, so keep these two in step.
LAST="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null)"
[ -n "$LAST" ] || LAST="$(git log -1 --format=%H \
    -S'"version"' -- plugins/vero-dotto/.claude-plugin/plugin.json)"

git log --no-merges --format='%h %s' "$LAST..HEAD"
git diff --stat "$LAST..HEAD"
git diff "$LAST..HEAD" -- plugins/vero-dotto
```

Read the diff, not only the subjects. Keep CI, tests and internal refactors out of the
user-facing notes.

### 2. Check the converters for updates

The Python pins live in `convert.py`'s PEP 723 header, which Dependabot does not read:

```bash
VD=~/.cache/verodotto
UV_CACHE_DIR=$VD/uv-cache UV_PYTHON_INSTALL_DIR=$VD/python \
  $VD/bin/uv pip list --outdated --python "$(ls -d $VD/uv-cache/environments-v2/convert-*/bin/python | head -n 1)"
```

Also the newest uv release (`UV_VERSION` and the seven SHA-256 values in
`verodotto.sh`, from the release's `.sha256` files). Propose any bump to the owner; a
changed header makes every user set up again on their next session (only what changed
downloads). Run `tests/convert.sh` from scratch after one.

### 3. Propose a number

| What changed | Bump |
| :-- | :-- |
| a command, option or output format removed or renamed; a cache layout an older release cannot read | major - `2.0.0` |
| a new command, option, format or capability | minor - `1.1.0` |
| fixes, converter pin updates, wording, docs, CI, tests only | patch - `1.0.1` |

### 4. Ask before editing anything

Put it to the owner with `AskUserQuestion`: the computed number first, the neighbouring
ones as alternatives, each labelled with why it fits. Their answer wins. Never bump
without a reply.

### 5. Make the edits

- **`plugins/vero-dotto/.claude-plugin/plugin.json`** - `version`. The only place a
  version has any effect. Never also in VeroPlugins' entry.
- **`plugins/vero-dotto/CHANGELOG.md`** - a new `## <version> - <YYYY-MM-DD>` at the top,
  user-facing, grouped, never raw commit subjects.
- Anything the release makes untrue in `README.md`, `plugins/vero-dotto/README.md` (keep
  them byte-identical) or this file.
- Run `tests/smoke.sh`, `claude plugin test ./plugins/vero-dotto`, `tests/convert.sh`
  and the two `claude plugin validate` commands, and report the result.

### 6. Hand back - never execute

No commit, no push, no tag. Stage the edits and hand the owner:

1. The one-line commit message.
2. **Release notes** for the GitHub Release body: the changelog entry as a standalone
   note, opening with one sentence on why anyone should care.
3. The commands:

```bash
git add -A && git commit -m "VeroDotto <version>" && git push
git tag v<version> && git push origin v<version>
gh release create v<version> --title "VeroDotto <version>" --notes-file notes.md
```

### What a release actually is

Users' marketplace is VeroPlugins, whose `vero-dotto` entry follows this repository's
**`main`** (`git-subdir`, no ref), so pushing a bumped `version` to `main` **is** the
release; the tag and the GitHub Release announce it, and the `v<version>` tag push runs
`release.yml`, which sends `plugin-released` to VeroPlugins so its CI re-checks the entry
(secret `VEROPLUGINS_DISPATCH_TOKEN` in this repository). A fix pushed without a version
bump reaches nobody (the cache is keyed by version, at
`~/.claude/plugins/cache/vero-plugins/vero-dotto/<version>/`), and unfinished work on
`main` ships the moment the version changes - keep it on a branch. Users update with
`/plugin marketplace update vero-plugins`, then `/plugin update vero-dotto@vero-plugins`,
and a restart.

## Open ideas, not implemented

- A preview pane for a conversion (1.1 candidate; the owner chose Save only for 1.0).
- OCR for scanned PDFs.
- `.doc` (Word 97) without LibreOffice.
- Grep coverage: searching inside documents' markdown.
- A weekly scheduled run of the Convert CI job, to learn early when a pinned download
  disappears.
