# Changelog

## 1.0.1 - 2026-10-20

### Changed

- **A Windows path works in a WSL session.** `C:\Users\…\spec.docx` written in a prompt
  on WSL is read under `/mnt/c/…`, so the row and the early conversion follow it as they
  do for any other path.
- **The row shows for documents Claude opens itself.** `bandForReads` is on by default;
  off keeps the row for documents named in your prompt only.
- **The row stays a while.** It survives your next two prompts, or two minutes, whichever
  is longer (`bandSeconds`), instead of going at the next prompt; × still closes it at once.
- **The move row has four buttons.** After the old copy is removed, a fourth button
  removes the marketplace it came from, so nothing of it stays behind. A copy from
  VeroPlugins that finds an older copy of itself offers the same two removals.

## 1.0.0 - 2026-10-14

Claude reads your documents as clean markdown - Word, Excel, PowerPoint, PDF,
OpenDocument, HTML, EPUB and e-mail - converted automatically, cached, with the token
saving shown.

### New

- **Documents become markdown wherever they reach Claude.** An `@spec.docx` mention, a
  path simply written in your prompt (`please summarise docs/spec.docx`, quoted, `~/…`,
  `C:\…`, `file://…` or a Markdown link), or a file Claude opens with Read on its own -
  each is read as markdown, with a note naming what markdown could not hold and where the
  original is.
- **The saving, above the prompt.** One row after a prompt that named documents:
  `VeroDotto spec.docx → markdown · ≈ 4.2k vs 31k tokens (−86%) · lost: 2 images`,
  with **Save markdown next to original** and **×**.
- **Save markdown next to original, and the sibling rule.** Save writes `spec.docx.md` beside the
  original, asking first if one exists; a `<file>.md` beside a document - saved or written
  by hand - is read instead of converting. When the original's content changed since,
  Claude reads a fresh conversion in that same request instead, your copy stays as it is,
  and **Update spec.docx.md** in the band replaces it after asking. A touch or a save
  without edits is no change: a saved copy remembers its original's checksum.
- **Formats.** `.docx`, `.pptx` (with speaker notes), `.xlsx`/`.xls`/`.ods` (a summary for
  large sheets), `.pdf`, `.odt`, `.odp`, `.rtf`, `.html`, `.epub`, `.msg`, `.eml`. A scanned
  PDF, a `.doc`, or a conversion that would save under 10% keeps the original, and the
  band says why. PDF tables come through as markdown tables, in reading order.
- **Big files are skipped, and you are told.** A document over 100 MB (`maxFileMb`) is
  read as it is, with a notice the first time and the reason in the band.
- **Set-up by itself.** The first session downloads a pinned, checksum-verified uv,
  Python 3.12 and lean converters (~240 MB, once) into `~/.cache/verodotto`, in the
  background. A row above the prompt follows it step by step with the time so far, and
  a short toast says when it starts and ends. A failure says why in that row, with
  **Retry**; it also retries in a later session. Closing a session mid-setup is safe:
  the next one starts again at once and resumes what was downloaded. `autoSetup` in
  `/config` turns it off.
- **Isolated.** Nothing changes outside that folder: no `PATH` or profile edits, no
  Python linked into `~/.local/bin` or registered with Windows, your own Python and
  `uv.toml` untouched. Conversions run offline.
- **Claude is told once.** A short note per session says to open documents with Read
  rather than unzipping or scripting them; a shell command that parses one anyway runs
  unchanged and is followed by a one-time reminder.
- **`/vero-dotto off` / `on`** - pause VeroDotto for the session and resume it, no
  restart; while paused the band says so, with **Resume**.
- **`/vero-dotto`** - status, `stats` (tokens saved this session and all time, per
  format), `show <file>`, `save <file>`, `setup`, `clean`, `purge`.
- **Options** in `/config`: `autoSetup`, `minSavingPercent`, `maxFileMb`, `maxSheetCells`,
  `maxSheetRows`, `maxTokens`, `bandForReads`, `cacheDays`, `cacheMaxMb`,
  `convertTimeoutSec`.
- **Cache by content.** The same bytes under two names convert once; conversions unused
  for 10 days, and the oldest past 100 MB, are removed daily. Nothing is ever written in
  your project except a copy you save.
- **One place to install from.** VeroDotto is installed from the VeroPlugins marketplace.
  A copy installed from anywhere else pauses and shows, above the prompt, the buttons
  that move it to VeroPlugins; a copy that finds an older copy of itself still enabled
  pauses too and names the command that removes it. Your converters and converted
  documents stay where they are.
- **Safe by construction.** Whatever fails - no network, no converters, a conversion that
  errs or times out - the original file is read as if VeroDotto were not there.
