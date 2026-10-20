import { describe, expect, test } from 'claude-code/testing'

import type { BandItem, Meta } from '../types'
import {
  CONVERTED,
  addRead,
  bandLine,
  classify,
  configOf,
  convertedContext,
  decide,
  EMPTY_STATS,
  estimateTokens,
  fenceFor,
  findPaths,
  formatTokens,
  isCacheDir,
  isPageRead,
  isParserCommand,
  mentionsOf,
  parseConverted,
  resolvePath,
  retryAfterMs,
  saveable,
  shortLost,
  savingPercent,
  systemNote,
} from '../hooks/rules'

const META: Meta = {
  source: 'spec.docx',
  ext: '.docx',
  size: 31000,
  mdChars: 16800,
  mdTokens: 4200,
  origTokens: 31000,
  isLowerBound: true,
  lost: ['2 images'],
  converter: 'mammoth 1.13.0',
  kind: 'full',
  convertedAt: '2026-10-14T00:00:00Z',
}

describe('classify', () => {
  for (const ext of CONVERTED) {
    test(`${ext} is converted`, () => {
      expect(classify(`/x/file${ext}`)).toBe('convert')
      expect(classify(`/x/FILE${ext.toUpperCase()}`)).toBe('convert')
    })
  }
  for (const name of ['a.md', 'a.txt', 'a.csv', 'a.json', 'a.xml', 'a.yaml', 'a.ts', 'a.png', 'a.jpg', 'a.zip', 'a.mp3', 'a.mp4', 'Makefile', '.docx']) {
    test(`${name} is kept`, () => expect(classify(name)).toBe('keep'))
  }
  test('.doc is kept, with its own reason', () => expect(classify('old.DOC')).toBe('doc'))
  test('a PDF read by pages is a page read; other reads are not', () => {
    expect(isPageRead('a.pdf', '1-5')).toBe(true)
    expect(isPageRead('a.pdf', undefined)).toBe(false)
    expect(isPageRead('a.docx', '1-5')).toBe(false)
  })
})

describe('decide', () => {
  test('a good saving is served', () => expect(decide(META, 10)).toEqual({ serve: true }))
  test('at the threshold it is served, just below it is kept', () => {
    expect(decide({ ...META, mdTokens: 90, origTokens: 100 }, 10)).toEqual({ serve: true })
    expect(decide({ ...META, mdTokens: 91, origTokens: 100 }, 10)).toEqual({ serve: false, reason: 'small-saving' })
  })
  test('a scan is kept whatever the numbers', () => {
    expect(decide({ ...META, keep: 'little-text' }, 0)).toEqual({ serve: false, reason: 'little-text' })
  })
  test('an empty conversion is kept', () => expect(decide({ ...META, keep: 'empty' }, 0)).toEqual({ serve: false, reason: 'empty' }))
  test('a summary is served even with a small saving', () => {
    expect(decide({ ...META, kind: 'summary', mdTokens: 99, origTokens: 100 }, 10)).toEqual({ serve: true })
  })
})

describe('estimates', () => {
  test('Latin text is 4 characters a token', () => expect(estimateTokens('a'.repeat(400))).toBe(100))
  test('Cyrillic text is 3 characters a token', () => expect(estimateTokens('я'.repeat(300))).toBe(100))
  test('mostly Latin with a little Cyrillic stays at 4', () => expect(estimateTokens('a'.repeat(80) + 'я'.repeat(20))).toBe(25))
  test('empty is nothing', () => expect(estimateTokens('')).toBe(0))
  test('the saving is a whole percent, never negative', () => {
    expect(savingPercent(4200, 31000)).toBe(86)
    expect(savingPercent(1, 3)).toBe(67)
    expect(savingPercent(120, 100)).toBe(0)
    expect(savingPercent(5, 0)).toBe(0)
  })
  test('token counts read short', () => {
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(4200)).toBe('4.2k')
    expect(formatTokens(4000)).toBe('4k')
    expect(formatTokens(31000)).toBe('31k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('the band', () => {
  const converted: BandItem = {
    name: 'spec.docx',
    path: '/p/spec.docx',
    state: 'converted',
    mdTokens: 4200,
    origTokens: 31000,
    saving: 86,
    lost: ['2 images'],
    docDir: '/c/docs/k',
  }
  test('one file', () => {
    expect(bandLine([converted])).toBe('spec.docx \u2192 markdown \u00b7 \u2248 4.2k vs 31k tokens (\u221286%) \u00b7 lost: 2 images')
  })
  test('a fresh conversion read in place of an older copy says so', () => {
    expect(bandLine([{ ...converted, hasStaleCopy: true }])).toBe(
      'spec.docx \u2192 markdown \u00b7 \u2248 4.2k vs 31k tokens (\u221286%) \u00b7 lost: 2 images \u00b7 \u26a0  spec.docx.md older, not used',
    )
  })
  test('one file with nothing lost says nothing of losses', () => {
    expect(bandLine([{ ...converted, lost: [] }]).includes('lost:')).toBe(false)
  })
  test('several files total up, and a kept one is named', () => {
    const other = { ...converted, name: 'b.xlsx', path: '/p/b.xlsx', mdTokens: 6800, origTokens: 37000 }
    const kept: BandItem = { name: 'report.pdf', path: '/p/report.pdf', state: 'kept', reason: 'little-text' }
    expect(bandLine([converted, other, kept])).toBe(
      '2 files \u2192 markdown \u00b7 \u2248 11k vs 68k tokens (\u221284%) \u00b7 report.pdf kept as is: scan or drawings',
    )
  })
  test('kept for a small saving says how small', () => {
    expect(bandLine([{ name: 'notes.odt', path: '/p/notes.odt', state: 'kept', reason: 'small-saving', saving: 8 }])).toBe(
      'notes.odt kept as is (saving only \u2248 8%)',
    )
  })
  test('a stale sibling is flagged', () => {
    expect(bandLine([{ name: 'spec.docx', path: '/p/spec.docx', state: 'sibling', isStale: true }])).toBe(
      'spec.docx \u2192 your spec.docx.md \u00b7 \u26a0  original changed since',
    )
  })
  test('a .doc says to save as .docx', () => {
    expect(bandLine([{ name: 'old.doc', path: '/p/old.doc', state: 'kept', reason: 'doc' }]).includes('save as .docx')).toBe(true)
  })
  test('a file over the size limit says so, with both sizes', () => {
    expect(bandLine([{ name: 'big.pdf', path: '/p/big.pdf', state: 'kept', reason: 'too-large', sizeMb: 152.4, limitMb: 100 }])).toBe(
      'big.pdf skipped: 152 MB > 100 MB limit',
    )
    expect(bandLine([{ name: 'a.docx', path: '/p/a.docx', state: 'kept', reason: 'too-large', sizeMb: 12.34, limitMb: 10 }])).toBe(
      'a.docx skipped: 12.3 MB > 10 MB limit',
    )
  })
  test('losses read short in the band; the note keeps the detail', () => {
    expect(shortLost('1 formula with no saved result (formula shown)')).toBe('1 formula')
    expect(shortLost('2 formulas (values kept)')).toBe('2 formulas')
    expect(shortLost('1 attachment (name kept)')).toBe('1 attachment')
    expect(shortLost('rows past the first 20 of each sheet (9981 rows; summary only)')).toBe('rows (summary)')
    expect(shortLost('3 images')).toBe('3 images')
  })
  test('a file Claude already holds', () => {
    expect(bandLine([{ name: 'a.xlsx', path: '/p/a.xlsx', state: 'unchanged' }])).toBe('a.xlsx already read, nothing sent')
  })
  test('converters still preparing', () => {
    expect(bandLine([{ name: 'a.docx', path: '/p/a.docx', state: 'kept', reason: 'preparing' }])).toBe(
      'a.docx read as is: converters preparing',
    )
  })
  test('Save is offered for one converted file only', () => {
    expect(saveable([converted])?.path).toBe('/p/spec.docx')
    expect(saveable([converted, { ...converted, path: '/p/b.docx' }])).toBeUndefined()
    expect(saveable([{ ...converted, isSaved: true }])).toBeUndefined()
    expect(saveable([{ ...converted, state: 'kept' }])).toBeUndefined()
    expect(saveable([{ ...converted, state: 'unchanged' }])?.path).toBe('/p/spec.docx')
    // a hand-kept copy that was read is no conversion to save, stale or not
    const sibling: BandItem = { name: 'spec.docx', path: '/p/spec.docx', state: 'sibling' }
    expect(saveable([{ ...sibling, isStale: true }])).toBeUndefined()
    expect(saveable([sibling])).toBeUndefined()
  })
})

describe('what the model reads', () => {
  test('the system note lists exactly the converted formats', () => {
    const note = systemNote()
    for (const ext of CONVERTED.filter(e => e !== '.htm')) expect(note.includes(ext)).toBe(true)
    expect(note.includes('.doc ')).toBe(false)
    expect(note.split(/\s+/).length < 80).toBe(true)
  })
  test('the context names the original, the converter and the losses', () => {
    expect(convertedContext('/p/spec.docx', META)).toBe(
      '/p/spec.docx was converted to markdown by VeroDotto (mammoth 1.13.0); what you read is that markdown, from the VeroDotto cache. Lost: 2 images. The original is at /p/spec.docx if you need what was lost.',
    )
  })
  test('it never claims nothing was lost', () => {
    expect(convertedContext('/p/a.docx', { ...META, lost: [] }).includes('none detected beyond formatting and layout')).toBe(true)
  })
  test('a parser command is told apart from a listing', () => {
    expect(isParserCommand('unzip -p docs/spec.docx word/document.xml')).toBe(true)
    expect(isParserCommand('python3 -c "import docx" && echo')).toBe(true)
    expect(isParserCommand('/usr/bin/pdftotext a.pdf -')).toBe(true)
    expect(isParserCommand('ls -la spec.docx')).toBe(false)
    expect(isParserCommand('cp spec.docx /tmp')).toBe(false)
  })
})

describe('parseConverted', () => {
  test('reads the folder, cached or new, and the meta', () => {
    const out = `/c/docs/abc\tcached\n${JSON.stringify(META)}\n`
    expect(parseConverted(out)).toEqual({ docDir: '/c/docs/abc', isCached: true, meta: META })
  })
  test('anything else is no conversion', () => {
    expect(parseConverted('')).toBeUndefined()
    expect(parseConverted('/c/docs/abc\tnew\nnot json')).toBeUndefined()
    expect(parseConverted('/c/docs/abc\tmaybe\n{}')).toBeUndefined()
  })
})

describe('options', () => {
  test('defaults as the owner settled them', () => {
    expect(configOf({})).toEqual({
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
    })
  })
  test('a value out of range falls back to its default', () => {
    expect(configOf({ minSavingPercent: 140, convertTimeoutSec: 0, autoSetup: 'yes' }).minSavingPercent).toBe(10)
    expect(configOf({ convertTimeoutSec: 0 }).convertTimeoutSec).toBe(100)
    expect(configOf({ autoSetup: 'no' }).autoSetup).toBe(true)
    expect(configOf({ autoSetup: false }).autoSetup).toBe(false)
  })
})

describe('stats', () => {
  test('a read adds up per format', () => {
    const one = addRead(EMPTY_STATS, '.docx', 100, true)
    const two = addRead(one, '.docx', 50, false)
    expect(two).toEqual({ conversions: 1, reads: 2, saved: 150, kept: 0, byFormat: { '.docx': { reads: 2, saved: 150 } } })
  })
})

describe('safety', () => {
  test('purge takes only a verodotto folder', () => {
    expect(isCacheDir('/home/me/.cache/verodotto', '/home/me')).toBe(true)
    expect(isCacheDir('C:\\Users\\me\\.cache\\verodotto', 'C:\\Users\\me')).toBe(true)
    expect(isCacheDir('/', '/home/me')).toBe(false)
    expect(isCacheDir('/home/me', '/home/me')).toBe(false)
    expect(isCacheDir('', '/home/me')).toBe(false)
    expect(isCacheDir('verodotto', '/home/me')).toBe(false)
    expect(isCacheDir('/home/me/.cache', '/home/me')).toBe(false)
  })
  test('a fence is longer than any run inside', () => {
    expect(fenceFor('plain')).toBe('```')
    expect(fenceFor('has ``` inside')).toBe('````')
    expect(fenceFor('has ````` inside')).toBe('``````')
  })
})

describe('setup', () => {
  test('setup retries after 1 h, 6 h, then a day', () => {
    expect(retryAfterMs(0)).toBe(0)
    expect(retryAfterMs(1)).toBe(3_600_000)
    expect(retryAfterMs(2)).toBe(21_600_000)
    expect(retryAfterMs(5)).toBe(86_400_000)
  })
})

describe('paths', () => {
  test('resolved against the session folder, the home folder, or as written', () => {
    expect(resolvePath('/repo', '/home/me', 'docs/spec.docx')).toBe('/repo/docs/spec.docx')
    expect(resolvePath('/repo', '/home/me', './a.docx')).toBe('/repo/a.docx')
    expect(resolvePath('/repo/sub', '/home/me', '../a.docx')).toBe('/repo/a.docx')
    expect(resolvePath('/repo', '/home/me', '~/x.pdf')).toBe('/home/me/x.pdf')
    expect(resolvePath('/repo', '/home/me', '/abs/a.pdf')).toBe('/abs/a.pdf')
    expect(resolvePath('C:\\repo', 'C:\\Users\\me', 'docs\\a.docx')).toBe('C:\\repo\\docs\\a.docx')
    expect(resolvePath('C:\\repo', 'C:\\Users\\me', 'D:/x/a.docx')).toBe('D:\\x\\a.docx')
  })
  test('a Windows path in a POSIX session is read under the drive mount, as WSL has it', () => {
    expect(resolvePath('/repo', '/home/me', 'C:/x/a.docx')).toBe('/mnt/c/x/a.docx')
    expect(resolvePath('/repo', '/home/me', 'C:\\Users\\dmitr\\OneDrive\\Документы\\Cirrus\\NIS-935.docx')).toBe(
      '/mnt/c/Users/dmitr/OneDrive/Документы/Cirrus/NIS-935.docx',
    )
    expect(resolvePath('/home/me/work', '/home/me', 'd:\\a\\..\\b\\spec.pdf')).toBe('/mnt/d/b/spec.pdf')
    expect(resolvePath('/repo', '/home/me', '\\\\server\\share\\a.docx')).toBe('\\\\server\\share\\a.docx')
  })
  test('mentions are read as typed after the @', () => {
    expect(mentionsOf('read @docs/spec.docx and @"my file.pdf" and @a.docx#L10-20')).toEqual(['docs/spec.docx', 'my file.pdf', 'a.docx'])
    expect(mentionsOf('mail me at a@b.docx')).toEqual([])
  })
})

// findPaths: every form the plan names, each rejection, and the awkward names.
const FOUND: [string, string, string[]][] = [
  ['a bare relative path', 'please use docs/spec.docx now', ['docs/spec.docx']],
  ['a bare name', 'summarise spec.docx', ['spec.docx']],
  ['a dot-relative path', 'open ./a.docx', ['./a.docx']],
  ['a parent-relative path', 'open ../a.docx', ['../a.docx']],
  ['an absolute path', 'see /x/a.pdf', ['/x/a.pdf']],
  ['a home path', 'see ~/a.xlsx', ['~/a.xlsx']],
  ['a Windows path', 'see C:\\x\\a.docx', ['C:\\x\\a.docx']],
  ['a Windows path with forward slashes', 'see C:/x/a.docx', ['C:/x/a.docx']],
  ['a UNC path', 'see \\\\server\\share\\a.docx', ['\\\\server\\share\\a.docx']],
  ['a file URI', 'see file:///home/me/a%20b.pdf', ['/home/me/a b.pdf']],
  ['a Windows file URI', 'see file:///C:/x/a.docx', ['C:/x/a.docx']],
  ['double quotes with a space', 'open "my docs/spec v2.docx" please', ['my docs/spec v2.docx']],
  ['single quotes with a space', "open 'my spec.docx' please", ['my spec.docx']],
  ['backticks', 'open `docs/a b.pptx`', ['docs/a b.pptx']],
  ['guillemets', 'открой «отчёт за год.docx»', ['отчёт за год.docx']],
  ['a trailing comma', 'read spec.docx, then stop', ['spec.docx']],
  ['a trailing full stop', 'read spec.docx.', ['spec.docx']],
  ['parentheses', 'the spec (spec.docx) says', ['spec.docx']],
  ['a question mark', 'what is in book.xlsx?', ['book.xlsx']],
  ['a Markdown link', 'see [the spec](docs/a.pdf) here', ['docs/a.pdf']],
  ['a Markdown link with a title', 'see [x](docs/a.pdf "title")', ['docs/a.pdf']],
  ['a Cyrillic name', 'прочитай документы/отчёт.docx', ['документы/отчёт.docx']],
  ['upper-case extension', 'read REPORT.PDF', ['REPORT.PDF']],
  ['a version-like name, kept for the existence check', 'see v1.2.pdf', ['v1.2.pdf']],
  ['several, in order, once each', 'a.docx b.xlsx a.docx c.pptx', ['a.docx', 'b.xlsx', 'c.pptx']],
  ['every converted format', 'a.odt b.ods c.odp d.rtf e.epub f.html g.htm h.msg i.eml j.xls', ['a.odt', 'b.ods', 'c.odp', 'd.rtf', 'e.epub', 'f.html', 'g.htm', 'h.msg', 'i.eml', 'j.xls']],
  ['an apostrophe does not open a quote', "don't touch spec.docx", ['spec.docx']],
  ['a path after a colon', 'source:docs/a.docx', ['source:docs/a.docx']],
  ['a quoted path after text', 'compare "a.docx" with "b.docx"', ['a.docx', 'b.docx']],
  ['inline code mid-sentence', 'the file `report final.xlsx` has totals', ['report final.xlsx']],
  ['an angle-bracketed path', 'see <docs/a.pdf>', ['docs/a.pdf']],
]
const REJECTED: [string, string][] = [
  ['an http URL', 'see https://example.com/a.pdf'],
  ['an http URL in a link', 'see [x](http://example.com/a.docx)'],
  ['an ftp URL', 'ftp://host/a.docx'],
  ['a fenced code block', 'look:\n```\ncat spec.docx\n```\n'],
  ['a tilde fence', '~~~\nreport.pdf\n~~~'],
  ['a mention', 'read @spec.docx'],
  ['a text file', 'read notes.md and data.csv'],
  ['an image', 'see shot.png'],
  ['a bare extension', 'the .docx format'],
  ['a word with docx inside', 'docx files are zips'],
  ['a legacy .doc', 'old.doc'],
]

describe('findPaths', () => {
  for (const [what, text, want] of FOUND) test(`finds ${what}`, () => expect(findPaths(text)).toEqual(want))
  for (const [what, text] of REJECTED) test(`rejects ${what}`, () => expect(findPaths(text)).toEqual([]))
  test('text after a fence still counts', () => {
    expect(findPaths('```\nold.pdf\n```\nnow read new.pdf')).toEqual(['new.pdf'])
  })
})
