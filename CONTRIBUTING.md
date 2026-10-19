# Contributing to VeroDotto

For maintainers and anyone changing the plugin. How to use it is in the
[README](README.md).

## Develop and test locally

Four checks, and CI runs all of them. The first needs nothing but bash and coreutils - no
Claude Code, no network, no credentials:

```bash
tests/smoke.sh
```

It asserts the promises `verodotto.sh` makes, with a fake `uv` on `PATH` that writes canned
markdown: where the cache is (`VERODOTTO_DIR`, `XDG_CACHE_HOME`, `~/.cache`); when setup
counts as done (no marker, a matching one, a stale one) and that its lock is exclusive and
goes stale; that uv never sees an inherited `VIRTUAL_ENV` or `PYTHONPATH`; that
conversions are cached by content (two names, one entry; changed bytes, a new one) and an
unchanged file is not hashed twice; that `shasum` stands in for `sha256sum`; that Save
writes only a `.md` beside the original; that cleaning drops stale conversions and never
the converters; that purge refuses a folder VeroDotto did not make. It also checks the
repository's hygiene: LF endings, executable scripts, no bash 4 syntax, `hooks.json`'s
exact content, no `bin/`, and the plugin's copies of `README.md` and `LICENSE`.

The second runs the module's TypeScript against Claude Code's own engine - still no
account and no network:

```bash
claude plugin test ./plugins/vero-dotto
```

`tests/rules.test.ts` covers the pure rules: every extension's class, the keep/serve
decision at its edges, the token estimate for Latin and Cyrillic, the band's text, the
options, and `findPaths` over a table of 40-odd forms and rejections.
`tests/source-check.test.ts` is the source check's table (a byte-identical copy of
VeroPlugins' canonical one). `tests/hooks.test.ts` drives the hooks on the terminal and
the desktop surface, with hooks beneath the plugin standing in for verodotto.sh, the disk
and the engine's own reads (`fakeWorld()`): mention, Read, plain paths, the band and Save,
the system note, the Bash nudge, setup, the command, `/clear`, and a copy installed from
somewhere other than VeroPlugins (it pauses and its band moves it).

The third converts for real - uv, Python and every converter - so it needs the network
once and takes a minute or two:

```bash
tests/convert.sh                                 # set up from scratch in a temp folder
VERODOTTO_DIR=~/.cache/verodotto tests/convert.sh   # reuse a set-up cache
```

Each fixture in `tests/fixtures/` must convert to markdown that contains every line of its
`.expect` file and none of its `.reject` file - loose matching, robust to whitespace
changes between pinned versions. It also checks that a scan is kept, a big sheet is
summarised, and a second conversion is served from the cache.

The fourth validates the structure:

```bash
claude plugin validate ./plugins/vero-dotto           # plugin.json, hooks module, state contract
claude plugin validate ./plugins/vero-dotto --strict  # warnings as errors, for CI
```

### Fixtures

`tests/make-fixtures.py` generates every fixture - one tiny file per format, and its
expectations - so there is no licensing question about any of them. Run it by hand and
commit what it writes:

```bash
uv run --script tests/make-fixtures.py
```

### Live

```bash
cd /some/test/repo
claude --plugin-dir /path/to/VeroDotto/plugins/vero-dotto
```

A `--plugin-dir` folder is watched: saving a plugin file reloads the module with no
restart, and a failing hook leaves a dim `vero-dotto: ...` line in the transcript
(`claude --debug` for every occurrence). The desktop app takes the same folder through
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`'s `env`. Set `VERODOTTO_DIR` to a
scratch folder to watch the first-run setup again.

## What CI checks

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | Checks |
| :-- | :-- |
| **Plugin manifests** | both `claude plugin validate` runs and `claude plugin test`, on the newest Claude Code |
| **Shell lint** | `bash -n`, `bash -n` under bash 3.2 (docker), ShellCheck `-S warning` |
| **Python lint** | ruff and `py_compile` over `convert.py` and `make-fixtures.py` |
| **Smoke** | `tests/smoke.sh` on Linux and macOS - macOS takes the `shasum` and BSD `stat` branches |
| **Convert** | `tests/convert.sh` on Linux, macOS and Windows: the uv download, its checksum and every converter, for real |
| **Line endings** | a checkout with `core.autocrlf=true`, the Windows default: scripts stay LF and executable, and run |

## Share it

Every Vero plugin is installed from the [VeroPlugins](https://github.com/GomelHawk/VeroPlugins)
marketplace, whose `vero-dotto` entry points at this repository's `main`. So publishing
is pushing `main`; users then need two lines:

```
/plugin marketplace add GomelHawk/VeroPlugins
/plugin install vero-dotto@vero-plugins
```

### Releasing updates

`version` in `plugin.json` pins the plugin: users keep their cached copy until it
changes, so bump it on every release. Never set `version` in VeroPlugins' entry too -
`plugin.json` silently wins. Never rename the plugin without a `renames` entry in
VeroPlugins' catalog. A pushed `v<version>` tag runs `.github/workflows/release.yml`,
which tells VeroPlugins' CI to re-check the entry; it needs the repository secret
`VEROPLUGINS_DISPATCH_TOKEN` (see VeroPlugins' CLAUDE.md).

The full procedure - collecting changes, choosing the number, the changelog, checking the
converters for updates, the GitHub Release - is in `CLAUDE.md` under "Cutting a release".

VeroDotto has no top-level `bin/` directory, which claude.ai organization distribution
would reject.
