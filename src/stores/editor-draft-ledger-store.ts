import { create } from 'zustand'

/**
 * 后台草稿账本：角色卡、小说配置、章节卡的未保存稿。
 * 这是会话技术状态，不是用户打开的文件，不能放进 editor-store 的 tabs。
 */
export interface EditorDraftLedgerState {
  draftLedgers: Record<string, string>
  setDraftLedger: (key: string, content: string) => void
  replaceDraftLedgers: (draftLedgers: Record<string, string>) => void
  clearProjectLedgers: (projectKey: string) => void
}

export function stripProjectFromDraftLedgers(
  draftLedgers: Record<string, string>,
  projectKey: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(draftLedgers).map(([key, content]) => {
      try {
        const parsed = JSON.parse(content) as {
          version?: unknown
          projects?: Array<{ projectKey?: unknown }>
        }
        if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return [key, content]
        return [key, JSON.stringify({
          ...parsed,
          projects: parsed.projects.filter(project => project.projectKey !== projectKey),
        })]
      } catch {
        return [key, content]
      }
    }),
  )
}

export const useEditorDraftLedgerStore = create<EditorDraftLedgerState>()((set) => ({
  draftLedgers: {},
  setDraftLedger: (key, content) => {
    set((state) => ({
      draftLedgers: {
        ...state.draftLedgers,
        [key]: content,
      },
    }))
  },
  replaceDraftLedgers: (draftLedgers) => set({ draftLedgers }),
  clearProjectLedgers: (projectKey) => {
    set((state) => ({
      draftLedgers: stripProjectFromDraftLedgers(state.draftLedgers, projectKey),
    }))
  },
}))
