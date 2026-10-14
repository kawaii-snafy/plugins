import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Browse, GitSummary, ListMode, Mark, ViewMode } from '../types'

const PANE = 'files'
const TITLE = 'Файлы'
const HIDDEN = new Set(['.git', 'node_modules'])
const MAX_ENTRIES = 500
// С какой ширины панели список встаёт справа от просмотрщика, и его ширина.
const SPLIT_FROM = 80
const LIST_WIDTH = 35
const MARK_COLOR: Record<Mark, string> = { M: 'warning', A: 'success', '?': 'success', R: 'warning', D: 'error' }

const browse = atom({ plugin: 'files', key: 'browse' } as const, { root: '', dir: '' } as Browse)
const opened = atom({ plugin: 'files', key: 'opened' } as const, null as string | null)
const listMode = atom({ plugin: 'files', key: 'list' } as const, 'tree' as ListMode)
const viewMode = atom({ plugin: 'files', key: 'view' } as const, 'file' as ViewMode)
// Растёт после каждого вызова инструмента и смены cwd: панель перечитывает диск.
const tick = atom({ plugin: 'files', key: 'tick' } as const, 0)
// Ветка и сводка изменений для нижней строки (справа, где метки режимов).
const summary = atom({ plugin: 'files', key: 'summary' } as const, null as GitSummary | null)

/** Склеивает абсолютную папку и относительный путь (в среде мода нет node:path). */
function join(base: string, rel: string): string {
  if (rel === '' || rel === '.') return base
  if (rel.startsWith('/')) return rel
  return `${base.replace(/\/$/, '')}/${rel}`
}

/** Путь для показа: относительно cwd, если файл внутри него. */
function shown(path: string, cwd: string): string {
  const prefix = `${cwd.replace(/\/$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Пометка файла по двум буквам `git status --porcelain`. */
function toMark(xy: string): Mark {
  if (xy === '??') return '?'
  if (xy.includes('D')) return 'D'
  if (xy.includes('A')) return 'A'
  if (xy[0] === 'R') return 'R'
  return 'M'
}

/**
 * Изменённые файлы репозитория, в котором лежит cwd: абсолютный путь → пометка.
 * Вне git-репозитория (или если git не запустился) — пустая карта.
 */
export async function gitStatus($: EngineInterface, cwd: string): Promise<Map<string, Mark>> {
  const marks = new Map<string, Mark>()
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    if (top.exitCode !== 0) return marks
    const root = top.stdout.trim()
    const ran = await $.process.run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
    const items = ran.stdout.split('\0')
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? ''
      if (item.length < 4) continue
      const xy = item.slice(0, 2)
      // У переименования следом идёт старое имя — пропускаем его.
      if (xy[0] === 'R' || xy[0] === 'C') i++
      marks.set(`${root}/${item.slice(3)}`, toMark(xy))
    }
  } catch {
    // git не установлен или упал: просто без пометок.
  }

  return marks
}

/**
 * Ханки unified diff файла против HEAD. Новый файл (или репозиторий без коммитов)
 * показывается целиком как добавленный. null — показывать нечего.
 */
export async function gitDiff(
  $: EngineInterface,
  file: string,
  cwd: string,
  mark: Mark | undefined,
): Promise<string | null> {
  try {
    const vsHead = mark === '?' ? undefined : await $.process.run(['git', 'diff', 'HEAD', '--', file], { cwd })
    const out =
      vsHead?.exitCode === 0
        ? vsHead.stdout
        : (await $.process.run(['git', 'diff', '--no-index', '--', '/dev/null', file], { cwd })).stdout
    // Заголовки `diff --git`/`index`/`---`/`+++` отрезаем: отрисовщику нужны ханки.
    const at = out.search(/^@@/m)

    return at === -1 ? null : out.slice(at)
  } catch {
    return null
  }
}

/** Склоняет «файл» по числу: 1 файл, 2 файла, 5 файлов. */
function files(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return `${n} файлов`
  if (ones === 1) return `${n} файл`
  if (ones >= 2 && ones <= 4) return `${n} файла`
  return `${n} файлов`
}

/**
 * Сводка git: ветка, пометка worktree, число изменённых файлов и +/− строк
 * против HEAD (в репозитории без коммитов — проиндексированное). Вне git — null.
 */
async function gitSummary($: EngineInterface, cwd: string): Promise<GitSummary | null> {
  try {
    const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd })
    if (branch.exitCode !== 0) return null
    const name = branch.stdout.trim() || 'detached'
    const dirs = await $.process.run(['git', 'rev-parse', '--git-dir', '--git-common-dir'], { cwd })
    const [gitDir, commonDir] = dirs.stdout.trim().split('\n')
    const isWorktree = gitDir !== commonDir

    const vsHead = await $.process.run(['git', 'diff', 'HEAD', '--shortstat'], { cwd })
    const stat =
      vsHead.exitCode === 0 ? vsHead.stdout : (await $.process.run(['git', 'diff', '--cached', '--shortstat'], { cwd })).stdout
    const added = Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0)
    const removed = Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0)
    const changed = (await gitStatus($, cwd)).size

    return { branch: name, isWorktree, changed, added, removed }
  } catch {
    return null
  }
}

// Путь в `code`-спане или голый абсолютный путь, с необязательным `:строка`.
const PATH_RE = /`([^`\s]+?)(?::\d+)?`|(?<=^|[\s(])(\/[\w.\-/]+\w)(?::\d+)?/g

/**
 * Превращает пути к существующим файлам в ссылки `file://` вне блоков кода.
 * Возвращает null, если ссылок не появилось: тогда сообщение рисует движок.
 */
async function linkPaths(
  text: string,
  cwd: string,
  isFile: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const parts = text.split(/(```[\s\S]*?```)/)
  let found = false
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i] ?? ''
    const matches = [...part.matchAll(PATH_RE)]
    const files = await Promise.all(matches.map(m => isFile(join(cwd, m[1] ?? m[2] ?? ''))))
    let out = ''
    let last = 0
    matches.forEach((m, j) => {
      if (!files[j]) return
      found = true
      const abs = join(cwd, m[1] ?? m[2] ?? '')
      out += `${part.slice(last, m.index)}[${m[0]}](file://${encodeURI(abs)})`
      last = m.index + m[0].length
    })
    parts[i] = out + part.slice(last)
  }

  return found ? parts.join('') : null
}

/** Перечитать диск в панели и обновить ветку/дифф под полем ввода. */
async function refresh($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
  const next = await gitSummary($, await $.session.cwd())
  await update($, summary, () => next)
}

export const register: Register = on => {
  // Кэш «путь → это файл»: ответ перерисовывается часто, диск дёргаем один раз.
  const known = new Map<string, boolean>()

  // Пути в ответах агента кликабельны: обычный клик открывает файл в панели,
  // ctrl+клик терминал по-прежнему отдаёт системе.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const isFile = async (path: string) => {
      if (!known.has(path)) {
        const stat = await $.fs.stat(path).catch(() => undefined)
        known.set(path, stat?.kind === 'file')
      }
      return known.get(path) === true
    }
    const text = await linkPaths(e.props.text, await $.session.cwd(), isFile)
    if (text === null) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const openFile = async (link: { href: string }) => {
      await update($, opened, () => decodeURI(link.href.replace(/^file:\/\//, '')))
      await update($, viewMode, () => 'file' as ViewMode)
      await $.ui.open({ id: PANE, title: TITLE })
    }

    return (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexDirection="column" flexShrink={1}>
          <Markdown key="text" text={text} onLinkPress={openFile} />
        </Box>
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Открыть панель с файлами рабочей папки',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    // Сводка раньше жила в $.ui.status (с префиксом «⚠ files:»): снимаем её, если осталась.
    $.ui.status(undefined)
    await refresh($)

    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Панель файлов открыта.' }
  })

  // После каждого инструмента всё перечитывается: агент мог что-то записать или уйти в worktree.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)

    return ran
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // Нижняя строка справа: кнопка «дерево» и сводка git `⎇ main · 3 файла +42 −7`
  // (цифры цветные, нули не показываются). Кнопка открывает панель на дереве,
  // клик по сводке — на «Изменениях». Метки режимов движка остаются перед ними.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const git = await read($, summary)
    const { Box, Button, Text } = $.ui.resolve(e)
    const showList = (mode: ListMode) => async () => {
      await update($, listMode, () => mode)
      await $.ui.open({ id: PANE, title: TITLE })
    }
    const head = [...e.props.modes]
    if (git !== null) {
      head.push(`⎇ ${git.branch}`)
      if (git.isWorktree) head.push('worktree')
      head.push(git.changed === 0 ? 'чисто' : files(git.changed))
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Button key="tree" plain onPress={showList('tree')}>
          <Text dimColor>▤ дерево</Text>
        </Button>
        {head.length > 0 && (
          // Вся сводка — одна кнопка: клик открывает панель на списке изменений.
          <Button key="git" plain onPress={showList('changes')}>
            <Text dimColor>{head.join(' · ')}</Text>
            {git !== null && git.added > 0 && <Text color="success"> +{git.added}</Text>}
            {git !== null && git.removed > 0 && <Text color="error"> −{git.removed}</Text>}
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    await read($, tick)
    const cwd = await $.session.cwd()
    const file = await read($, opened)
    const mode = await read($, listMode)
    const marks = await gitStatus($, cwd)
    const isSplit = e.props.bodyColumns >= SPLIT_FROM

    const open = async (path: string, view: ViewMode) => {
      await update($, opened, () => path)
      await update($, viewMode, () => view)
    }
    const markOf = (mark: Mark | undefined) =>
      mark === undefined ? '  ' : <Text color={MARK_COLOR[mark]}>{mark} </Text>

    /** Список справа (или на всю панель): дерево папки или изменённые файлы. */
    const drawList = async () => {
      const header = (
        <Box gap={1}>
          <Button key="mode:tree" hotkey="t" variant={mode === 'tree' ? 'primary' : undefined}
            onPress={() => update($, listMode, () => 'tree' as ListMode)}>
            Дерево
          </Button>
          <Button key="mode:changes" hotkey="c" variant={mode === 'changes' ? 'primary' : undefined}
            onPress={() => update($, listMode, () => 'changes' as ListMode)}>
            Изменения ({marks.size})
          </Button>
        </Box>
      )

      if (mode === 'changes') {
        const changed = [...marks].sort(([a], [b]) => a.localeCompare(b))
        return (
          <Box flexDirection="column">
            {header}
            {changed.length === 0 && <Text dimColor>Изменений нет.</Text>}
            {changed.map(([path, mark]) => (
              <Button key={`change:${path}`} plain onPress={() => open(path, 'diff')}>
                {markOf(mark)}
                <Text bold={path === file}>{shown(path, cwd)}</Text>
              </Button>
            ))}
          </Box>
        )
      }

      // Дерево папки. Если cwd сменился (вход в worktree), начинаем с его корня.
      const at = await read($, browse)
      const dir = at.root === cwd ? at.dir : ''
      const entries = await $.fs.list(join(cwd, dir)).catch(() => [])
      const visible = entries
        .filter(x => !HIDDEN.has(x.name))
        .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
        .slice(0, MAX_ENTRIES)
      const goTo = (next: string) => update($, browse, () => ({ root: cwd, dir: next }))
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
      const changedPaths = [...marks.keys()]

      return (
        <Box flexDirection="column">
          {header}
          {dir !== '' && (
            <Button key="up" plain onPress={() => goTo(parent)}>
              ..
            </Button>
          )}
          {visible.map(x => {
            const rel = dir === '' ? x.name : `${dir}/${x.name}`
            const abs = join(cwd, rel)
            if (x.kind === 'dir') {
              const isTouched = changedPaths.some(p => p.startsWith(`${abs}/`))
              return (
                <Button key={`dir:${rel}`} plain onPress={() => goTo(rel)}>
                  {isTouched ? <Text color="warning">• </Text> : '  '}
                  {x.name}/
                </Button>
              )
            }
            return (
              <Button key={`file:${rel}`} plain onPress={() => open(abs, 'file')}>
                {markOf(marks.get(abs))}
                <Text bold={abs === file}>{x.name}</Text>
              </Button>
            )
          })}
          {entries.length > MAX_ENTRIES && <Text dimColor>…и ещё {entries.length - MAX_ENTRIES}</Text>}
        </Box>
      )
    }

    /** Просмотрщик: содержимое файла или его diff против HEAD. */
    const drawViewer = async (file: string) => {
      const view = await read($, viewMode)
      const mark = marks.get(file)
      const openInEditor = async () => {
        const ran = await $.process.run(['code', file]).catch(() => undefined)
        if (ran?.exitCode !== 0) $.ui.toast('Не удалось запустить `code`')
      }
      let body
      if (view === 'diff') {
        const diff = await gitDiff($, file, cwd, mark)
        body = diff === null ? <Text dimColor>Изменений нет.</Text> : <Code source={diff} path={file} format="diff" />
      } else {
        const text = await $.fs.read(file).catch((err: unknown) => ({ error: String(err) }))
        body =
          typeof text !== 'string' ? (
            <Text color="error">{text.error}</Text>
          ) : text.includes('\u0000') ? (
            <Text dimColor>Бинарный файл.</Text>
          ) : /\.mdx?$/i.test(file) ? (
            <Markdown text={text} />
          ) : (
            <Code source={text} path={file} startLine={1} />
          )
      }

      return (
        <Box flexDirection="column">
          {/* Хедер: имя файла слева, кнопки справа, закрытие — крайнее справа. */}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-start">
                {markOf(mark)}
                <Text bold>{shown(file, cwd)}</Text>
              </Text>
            </Box>
            <Box gap={1} flexShrink={0}>
              <Button key="diff" hotkey="d" variant={view === 'diff' ? 'primary' : undefined}
                onPress={() => update($, viewMode, () => (view === 'diff' ? 'file' : 'diff') as ViewMode)}>
                Diff
              </Button>
              <Button key="editor" hotkey="e" onPress={openInEditor}>
                В редакторе
              </Button>
              <Button key="back" role="dismiss" autoFocus label="Закрыть"
                onPress={() => update($, opened, () => null)} />
            </Box>
          </Box>
          {body}
        </Box>
      )
    }

    if (!isSplit) return file === null ? drawList() : drawViewer(file)

    // Широкая панель: просмотрщик слева, список всегда справа за вертикальной чертой.
    // minHeight на всю высоту тела панели: черта списка доходит до низа окна.
    return (
      <Box flexDirection="row" alignItems="stretch" minHeight={e.props.scroll.bodyRows}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {file === null ? <Text dimColor>Выбери файл в списке справа.</Text> : await drawViewer(file)}
        </Box>
        <Box flexDirection="column" width={LIST_WIDTH} flexShrink={0} marginLeft={1} paddingLeft={1}
          // Рамка quote добавляет пустые строки сверху и снизу: тянем список вровень
          // с хедером файла и до низа окна.
          marginTop={-1} marginBottom={-2} borderStyle="quote" borderDimColor>
          {await drawList()}
        </Box>
      </Box>
    )
  })
}
