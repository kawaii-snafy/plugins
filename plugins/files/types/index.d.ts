/** Папка, открытая в дереве: путь относительно `root`, который был cwd в момент выбора. */
export type Browse = { root: string; dir: string }

/** Что показывает список: дерево папки или только изменённые файлы. */
export type ListMode = 'tree' | 'changes'

/** Что показывает просмотрщик: содержимое файла или его git diff. */
export type ViewMode = 'file' | 'diff'

/** Пометка git: изменён, добавлен, удалён, переименован, не отслеживается. */
export type Mark = 'M' | 'A' | 'D' | 'R' | '?'

/** Сводка git для нижней строки: ветка, worktree, сколько файлов и строк изменено. */
export type GitSummary = {
  branch: string
  isWorktree: boolean
  changed: number
  added: number
  removed: number
}

declare module 'claude-code' {
  interface PluginState {
    files: {
      browse: Browse
      opened: string | null
      list: ListMode
      view: ViewMode
      tick: number
      summary: GitSummary | null
    }
  }
}
