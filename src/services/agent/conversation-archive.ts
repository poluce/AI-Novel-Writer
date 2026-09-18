import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { AgentConversationArchive } from '../../shared/agent-conversation-archive'
import { logFailure } from '../../shared/fail-log'
import type { AgentScope } from '../../shared/agent-scope'
import { ipc } from '../ipc-client'
import { useAgentStore } from '../../stores/agent-store'

/**
 * 唯一的真实数据源由主进程底层的 Pi Agent（JsonlSessionRepo）掌管。
 * 前端不再维护双轨写盘逻辑、防抖定时器或本地 agent-conversations.json 镜像。
 */

export async function loadProjectAgentConversations(
  _projectSession?: ProjectSessionContext | null,
): Promise<AgentConversationArchive> {
  try {
    const result = await ipc.invoke('agent:list-conversations', 'project')
    return {
      version: 1,
      activeConversationId: result.activeConversationId ?? null,
      conversations: result.conversations || [],
    }
  } catch (error) {
    logFailure('Agent', 'failed to load project conversations from native store', error)
    return { version: 1, activeConversationId: null, conversations: [] }
  }
}

export async function loadGlobalAgentConversations(): Promise<AgentConversationArchive> {
  try {
    const result = await ipc.invoke('agent:list-conversations', 'global')
    return {
      version: 1,
      activeConversationId: result.activeConversationId ?? null,
      conversations: result.conversations || [],
    }
  } catch (error) {
    logFailure('Agent', 'failed to load global conversations from native store', error)
    return { version: 1, activeConversationId: null, conversations: [] }
  }
}

export async function hydrateGlobalAgentConversations(): Promise<void> {
  try {
    const archive = await loadGlobalAgentConversations()
    useAgentStore.getState().replaceConversations('global', archive)
  } catch (error) {
    logFailure('Agent', 'failed to hydrate global conversations', error)
  }
}

/**
 * 原生会话单数据源下，所有条目在每一次模型生成时由底层即时写入 .jsonl。
 * 此函数保留为 No-op 以兼容已有调用点，零延迟、不阻塞退出。
 */
export async function flushAgentConversations(
  _projectSession?: ProjectSessionContext | null | undefined,
): Promise<void> {
  return Promise.resolve()
}

export function rememberHydratedArchive(_scope: AgentScope, _archive: AgentConversationArchive): void {
  // No-op
}

export function subscribeAgentConversationPersistence(): void {
  // No-op: 彻底废除前端写盘监听器与防抖定时器
}
