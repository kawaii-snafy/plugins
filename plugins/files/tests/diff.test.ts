import { expect, test } from 'claude-code/testing'

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

const pane = (bodyColumns: number) =>
  ({
    component: 'Pane',
    requestId: 'files',
    props: {
      title: 'Файлы',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const run = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// «Изменения» → клик по файлу: слева diff, справа список остаётся, пока хватает ширины.
test('diff изменённого файла рядом со списком', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('git rev-parse')) return run('/repo\n')
    if (cmd.startsWith('git status')) return run(' M src/a.ts\0')
    return run(DIFF)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const wide = await $.ui.mount({ plugin: 'files', surface, ...pane(140) })
    await wide.press({ key: 'mode:changes' })
    await wide.press({ key: 'change:/repo/src/a.ts' })
    expect(await wide.find({ type: 'Code' })).toBeDefined()
    expect(await wide.find({ key: 'change:/repo/src/a.ts' })).toBeDefined()
    await wide.unmount()

    // Узкая панель: просмотрщик занимает всё место, списка не видно.
    const narrow = await $.ui.mount({ plugin: 'files', surface, ...pane(60) })
    expect(await narrow.find({ key: 'change:/repo/src/a.ts' })).toBeUndefined()
    await narrow.press({ key: 'back' })
    await narrow.press({ key: 'mode:tree' })
    await narrow.unmount()
  }
})
