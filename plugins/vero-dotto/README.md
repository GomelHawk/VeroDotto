<p align="center">
  <img src="https://raw.githubusercontent.com/GomelHawk/VeroDotto/main/assets/horizontal-logo.png"
       alt="VeroDotto - Read true. Spend less."
       width="600">
</p>

<p align="center">
  <a href="https://github.com/GomelHawk/VeroDotto/actions/workflows/ci.yml"><img src="https://github.com/GomelHawk/VeroDotto/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/GomelHawk/VeroDotto/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-8a63d2.svg" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/requires-bash%20%2B%20curl-555.svg" alt="Requires bash and curl">
</p>

Claude Code cannot read Word, Excel, PowerPoint or PDF files well on its own. It tries to
open them with ad-hoc scripts, which costs time and tokens and often loses the tables.
VeroDotto turns such a file into clean, plain text once, hands that text to Claude, and
shows you how much it saved. There is nothing to learn: mention the file as you always
do, and VeroDotto does the rest.

## What you get

- **Documents Claude can actually read**: Word, Excel, PowerPoint, PDF, OpenDocument,
  HTML, EPUB and e-mail files, all turned into text with their headings, lists and tables.
- **Fewer tokens**: the text is much smaller than the original, so Claude reads it faster
  and the conversation stays cheaper. A row above the prompt shows the saving:

  ```
  VeroDotto spec.docx → markdown · ≈ 4.2k vs 31k tokens (−86%) · lost: 2 images   [Save markdown next to original]  ×
  ```

- **Nothing changes on your computer** outside one folder, and nothing is written into
  your projects unless you ask for it.
- **Safe by design**: when anything goes wrong, Claude simply reads the original file, as
  if VeroDotto were not installed.

## Install

Two commands, typed inside Claude Code. Type the first, press Enter and wait for
`✔ Successfully added marketplace: vero-plugins`, then type the second:

```
/plugin marketplace add GomelHawk/VeroPlugins
```

```
/plugin install vero-dotto@vero-plugins
```

Then restart Claude Code. If you already added VeroPlugins for another Vero plugin, only
the second command is needed. The first session then sets up the converters by itself; see
[First run](#first-run).

> Type each line on its own. If a panel appears asking for a `marketplace source`, it
> wants only `GomelHawk/VeroPlugins` and nothing else on the line.

Prefer a terminal? The same two commands work there, back to back:

```bash
claude plugin marketplace add GomelHawk/VeroPlugins
claude plugin install vero-dotto@vero-plugins
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `GomelHawk/VeroPlugins`, then **Add plugin**.

To check it took, type `/vero-dotto`: it says whether the converters are ready.

**Only from VeroPlugins.** VeroDotto works only when installed from VeroPlugins. A copy
installed from anywhere else pauses and shows, above the prompt, three buttons that move
it here: press them one after another, pressing Enter after each, then restart Claude
Code. Your converters and converted documents stay where they are.

<details>
<summary>Installing from a copy of this repository</summary>

```bash
git clone https://github.com/GomelHawk/VeroDotto
cd VeroDotto
./install.sh                                    # for you, in every project
./install.sh --scope project ~/work/our-app     # for everyone who works in our-app
```

`install.sh` checks the plugin and installs it from VeroPlugins. `--scope project DIR`
writes VeroDotto into `DIR/.claude/settings.json` - VeroPlugins and the plugin, never the
path of your copy - so once that file is committed, everyone who trusts the folder gets
VeroDotto without installing anything themselves. `--scope local DIR` does the same in
`DIR/.claude/settings.local.json`, for you alone. Without a copy of the repository, the
same team install is two commands run inside that project:

```bash
claude plugin marketplace add GomelHawk/VeroPlugins --scope project
claude plugin install vero-dotto@vero-plugins --scope project
```
</details>

## First run

The first session after installing sets VeroDotto up by itself, in the background. You
are told before anything is downloaded, and the session works normally meanwhile:
documents are read as they are until the converters are ready.

1. A short message: *VeroDotto: one-time setup started, see above the prompt.*
2. A row above the prompt follows the setup step by step, with the time so far:

   ```
   VeroDotto ⏳ one-time setup (~240 MB into ~/.cache/verodotto) · 2/3 installing Python 3.12 and the converters (~200 MB) · 0:41
   ```

   One to two minutes on a normal connection.
3. A short message: *VeroDotto is ready: documents now read as markdown.* The row goes
   away.

If setup fails, the row says why, with **Retry** and **×**. Closing Claude Code in the
middle is safe: the next session starts again and keeps what was already downloaded.

**What is downloaded, and where.** Everything goes into one folder, `~/.cache/verodotto`,
and nowhere else:

| What | Why | Size |
| --- | --- | --- |
| [uv](https://github.com/astral-sh/uv), a small tool that installs Python programs (checked against its published checksum) | installs and runs the converters | ~40 MB |
| A private copy of Python | runs the converters, never your own Python | ~110 MB |
| The converters (mammoth, markdownify, python-pptx, openpyxl, xlrd, odfpy, pdfplumber, striprtf, olefile) | one per file format | ~90 MB |

Nothing else on your computer changes: nothing is added to your `PATH` or shell profile,
nothing is installed system-wide, your own Python and its settings are never used or
touched. The network is used only during setup; converting documents works offline.
Removing VeroDotto means removing that one folder.

**Opting out.** Turn off **autoSetup** in `/config` and nothing is downloaded; documents
are read as they are, and `/vero-dotto setup` sets VeroDotto up whenever you choose.
Behind a proxy, setup follows `HTTPS_PROXY`; if it fails, it tries again in a later
session, and `/vero-dotto setup` retries at once.

## Using it

**Mention a file.** `@docs/spec.docx summarise this` - the file is converted before
Claude starts. The row above the prompt shows the saving, what could not be kept (images,
charts), **Save markdown next to original** and **×**.

**Or just name it.** `please summarise docs/spec.docx` works the same: VeroDotto spots
file paths written in your message, starts converting them in the background, and tells
Claude the file is available as text. The content reaches Claude only if Claude actually
opens the file, so "don't touch spec.docx" is safe.

**Or let Claude find it.** When Claude opens a document by itself, it gets the text too.
No row is shown for those by default (Claude reads many files); they count in
`/vero-dotto stats`, and the **bandForReads** option shows them.

**Claude is told once.** Each session starts with one short note asking Claude to open
documents the normal way rather than unzipping or scripting them. If Claude does script
one anyway, the command still runs; Claude is simply reminded once. Nothing is ever
blocked, and the original file is always available to Claude.

**Save markdown next to original.** The button in the row saves the text as
`spec.docx.md`, beside the original. That is the only file VeroDotto ever writes in your
project, and only when you ask. If one exists already, you are asked first.

**Your own copy wins.** A `<file>.md` beside a document, saved by VeroDotto or written by
hand, is used instead of converting. Edit it to give Claude a better version than any
converter could. If the original changes later, VeroDotto notices: Claude gets a fresh
conversion, your copy is left as it is, and the row offers **Update spec.docx.md**, which
replaces the copy after you confirm.

## Formats

| File type | What happens |
| --- | --- |
| `.docx` `.odt` | converted: headings, lists, tables |
| `.rtf` | converted, text only |
| `.pptx` `.odp` | converted: slides, tables and speaker notes |
| `.xlsx` `.xls` `.ods`, small | converted, one table per sheet |
| `.xlsx` `.xls` `.ods`, large | **summarised**: each sheet's size, header and first 20 rows, and how Claude can look into the original |
| `.pdf` with text | converted, tables kept as tables, in reading order |
| `.pdf` that is mostly images (a scan, drawings) | **kept**: Claude reads its pages as images |
| `.html` `.htm` | converted; scripts, styles and navigation stripped |
| `.epub` | converted, chapters in reading order |
| `.msg` `.eml` | converted: sender, recipients, subject, body, attachment names |
| `.doc` (Word 97) | **kept**; the row suggests saving it as `.docx` |
| `.md` `.txt` `.csv` `.json`, code, images | **kept**: Claude reads them well already |

A conversion that would save less than 10% keeps the original, and the row says so.
"Large" means a sheet over 5,000 cells, or text estimated over 50,000 tokens. Files over
100 MB are skipped and read as they are, with a notice the first time.

## Commands

| Command | What it does |
| --- | --- |
| `/vero-dotto` | status: ready, preparing or why not; converter versions; cache size; formats; options you changed |
| `/vero-dotto off` | pause for this session: every document is read as it is; the row says so, with **Resume** |
| `/vero-dotto on` | resume |
| `/vero-dotto stats` | this session and all time: documents read as text, conversions, ≈ tokens saved, per format |
| `/vero-dotto show <file>` | one file: sizes, estimate, what was lost, the first 40 lines of its text |
| `/vero-dotto save <file>` | save the text next to the original (`--force` to overwrite) |
| `/vero-dotto setup` | set up the converters now |
| `/vero-dotto clean` | remove every converted document from the cache; the converters stay |
| `/vero-dotto purge` | remove the whole cache, converters included |

## Options

In `/config`, under VeroDotto:

| Option | Default | What it changes |
| --- | --- | --- |
| `autoSetup` | on | off: never downloads anything by itself; `/vero-dotto setup` does |
| `minSavingPercent` | 10 | below this estimated saving the original is read as it is |
| `maxFileMb` | 100 | a larger document is skipped and read as it is |
| `maxSheetCells` | 5000 | a spreadsheet with a sheet over this many cells is summarised |
| `maxSheetRows` | 20 | rows per sheet a summary shows |
| `maxTokens` | 50000 | a spreadsheet whose text is estimated above this is summarised |
| `bandForReads` | off | on: the row also appears for documents Claude opened itself |
| `cacheDays` | 10 | conversions unused this long are removed by the daily clean-up |
| `cacheMaxMb` | 100 | past this size the least recently used conversions are removed |
| `convertTimeoutSec` | 100 | a conversion that takes longer is stopped and the original is read |

## Updating

Nothing updates by itself, and Claude Code will not tell you a new version exists. New
versions are announced at
[github.com/GomelHawk/VeroDotto/releases](https://github.com/GomelHawk/VeroDotto/releases);
watch the repository if you want an email.

Inside Claude Code, one command at a time, same as installing:

```
/plugin marketplace update vero-plugins
```

```
/plugin update vero-dotto@vero-plugins
```

Then restart Claude Code. From a terminal, where you can run them back to back:

```bash
claude plugin marketplace update vero-plugins
claude plugin update vero-dotto@vero-plugins
```

`claude plugin list` shows which version you have.

## Turning it off and uninstalling

- **For this session**: `/vero-dotto off`, and `/vero-dotto on` (or **Resume** in the
  row) to come back.
- **Until you turn it back on**: `claude plugin disable vero-dotto@vero-plugins`
  (`claude plugin enable ...` to undo), or the switch in the `/plugin` menu. Takes effect
  after a restart.
- **Uninstall**: `/plugin uninstall vero-dotto@vero-plugins`, or from a clone:

  ```bash
  ./uninstall.sh            # the plugin; the cache stays
  ./uninstall.sh --purge    # the plugin and ~/.cache/verodotto
  ```

  Uninstalling the plugin alone leaves `~/.cache/verodotto` behind; `/vero-dotto purge`
  before uninstalling, or `--purge`, removes it too.

## Good to know

**Where the converted text lives.** In `~/.cache/verodotto` (or wherever `VERODOTTO_DIR`
points), never inside your project. The same file under two names is converted once; a
changed file is converted again. Conversions unused for 10 days are removed once a day,
and the oldest go first past 100 MB. Nothing is sent anywhere: there is no telemetry.

**The numbers are estimates.** A plugin cannot count tokens the way the model does, so
every number is marked `≈`. The text is estimated at four characters a token (three for
mostly non-Latin text); a PDF page counts as 1,600 tokens plus its text; an Office file
counts the raw text inside it, so its number is a floor.

**Limits.**

- No text recognition: a scanned PDF is kept, and Claude reads its pages as images.
- Files over 100 MB are skipped (`maxFileMb`).
- Tables in `.rtf` files become plain text; `.doc` (Word 97) is not converted - save it as
  `.docx`.
- What plain text cannot hold is lost: images, charts, diagrams, exact layout, formulas
  (their values are kept). Claude is told what was lost and where the original is.
- Only files Claude opens the normal way are converted; a search or a shell command sees
  the original file.
- Where an organization manages Claude Code, the one-line note rides your first message
  of the session instead of the system prompt.

## Requirements

- Claude Code, in the terminal or the desktop app.
- `bash`, and `curl` or `wget`. On Windows, the Git Bash that Claude Code itself uses; no
  WSL needed.
- About 240 MB of disk for the converters, plus the conversions (capped at 100 MB).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
