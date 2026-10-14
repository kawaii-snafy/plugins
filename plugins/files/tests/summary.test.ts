import { expect, test } from 'claude-code/testing'

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Сводка в углу: цветные цифры без нулей, клик открывает панель на «Изменениях».
test('сводка git в нижней строке ведёт к изменениям', async ($, on) => {
  let openedPane: string | undefined
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', (_$, e) => {
    openedPane = e.id
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git branch --show-current') return run('main\n')
    if (cmd.startsWith('git rev-parse --git-dir')) return run('.git\n.git\n')
    if (cmd.startsWith('git rev-parse --show-toplevel')) return run('/repo\n')
    if (cmd.startsWith('git diff HEAD --shortstat')) return run(' 1 file changed, 5 insertions(+)\n')
    if (cmd.startsWith('git status')) return run(' M a.ts\0')
    return run('')
  })

  // Любой вызов инструмента обновляет сводку.
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const footer = await $.ui.mount({ plugin: 'files', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: '+5' })).toBeDefined()
    expect(await footer.find({ type: 'Text', text: /−/ })).toBeUndefined()
    await footer.press({ key: 'git' })
    expect(openedPane).toBe('files')
    await footer.unmount()

    const pane = await $.ui.mount({
      plugin: 'files', surface, component: 'Pane', requestId: 'files',
      props: { title: 'Файлы', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await pane.find({ key: 'change:/repo/a.ts' })).toBeDefined()
    await pane.press({ key: 'mode:tree' })
    await pane.unmount()
  }
})

// Кнопка «дерево» есть и вне git: открывает панель на дереве, даже если был выбран список изменений.
test('кнопка дерева в нижней строке открывает дерево', async ($, on) => {
  let openedPane: string | undefined
  on('session.cwd', () => ({ value: '/plain' }))
  on('ui.open', (_$, e) => {
    openedPane = e.id
    return { value: { isPlaced: true } }
  })
  on('fs.list', () => ({ value: [{ name: 'readme.md', kind: 'file' }] }))
  on('process.run', () => run('', 128))

  const footer = await $.ui.mount({ plugin: 'files', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ key: 'git' })).toBeUndefined()
  await footer.press({ key: 'tree' })
  expect(openedPane).toBe('files')
  await footer.unmount()

  const pane = await $.ui.mount({
    plugin: 'files', surface: 'terminal', component: 'Pane', requestId: 'files',
    props: { title: 'Файлы', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await pane.find({ key: 'file:readme.md' })).toBeDefined()
  await pane.unmount()
})
