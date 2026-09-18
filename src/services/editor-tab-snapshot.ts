import type { EditorTabSaveSnapshot } from '../stores/editor-store'
import { useEditorStore } from '../stores/editor-store'

export interface FrozenOpenDraftTab {
  tabId: string
  snapshot: EditorTabSaveSnapshot
}

/** 合并/保存前冻结已打开草稿 Tab，避免 await 期间的新输入被当成提交基准。 */
export function freezeOpenDraftTab(
  projectKey: string | undefined,
  filePath: string,
  fallbackContent: string,
): FrozenOpenDraftTab | undefined {
  const tab = useEditorStore.getState().tabs.find(candidate => (
    candidate.projectKey === projectKey && candidate.filePath === filePath
  ))
  if (!tab) return undefined
  return {
    tabId: tab.id,
    snapshot: {
      content: tab.content ?? fallbackContent,
      contentRevision: tab.contentRevision ?? 0,
    },
  }
}

export function settleFrozenDraftMerge(frozen: FrozenOpenDraftTab, mergedText: string): void {
  useEditorStore.getState().settleMergedRevision(frozen.tabId, frozen.snapshot, mergedText)
}
