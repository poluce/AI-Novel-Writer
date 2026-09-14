/**
 * 章节蓝图的事实形状。
 *
 * 主进程仓库与渲染层（确认卡片、影响预览、共享提案校验）都依赖这个类型，
 * 因此它必须留在 shared，而不是挂在 electron/repositories 下。
 */

import type { BlueprintNewCharacterCandidate } from './blueprint-semantic-contract'

/** 前端使用的驼峰接口 */
export interface BlueprintData {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  /** Important recurring characters first introduced by this blueprint. */
  newCharacterCandidates?: BlueprintNewCharacterCandidate[]
  /**
   * Relationship payload from the just-generated blueprint. It is not part
   * of the editable blueprints table; an atomic range commit retains it in
   * the immutable operation receipt so character sync can be replayed.
   */
  relationshipHints?: unknown
  suspenseHook: string
  userGuidance: string
  notes: string
  notesUpdatedAt: string
}
