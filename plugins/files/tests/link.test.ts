import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'files',
  props: {
    title: 'Файлы',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Путь из ответа агента становится ссылкой, клик по ней открывает файл в панели.
test('клик по пути в ответе открывает файл в панели', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'export {}' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const reply = await $.ui.mount({
      plugin: 'files',
      surface,
      component: 'AssistantMessage',
      props: { text: 'Смотри `src/a.ts:12`', isFirstOfReply: true },
    })
    await reply.press({ key: 'text', link: { href: 'file:///repo/src/a.ts' } })
    await reply.unmount()

    const pane = await $.ui.mount({ plugin: 'files', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    await pane.press({ key: 'back' })
    await pane.unmount()
  }
})
