import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { AgentConversationArchive } from '../../shared/agent-conversation-archive'
import { logFailure } from '../../shared/fail-log'
import { ipc } from '../ipc-client'

/**
 * 唯一的真实数据源由主进程底层的 Pi Agent（JsonlSessionRepo）掌管。
 * 前端不再维护双轨写盘逻辑、防抖定时器或本地 agent-conversations.json 镜像。
 */

export async function loadProjectAgentConversations(
  _projectSession?: ProjectSessionContext | null,
): Promise<AgentConversationArchive> {
  try {
    const result = await ipc.invoke('agent:list-conversations')
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

/**
 * 原生会话单数据源下，所有条目在每一次模型生成时由底层即时写入 .jsonl。
 * 此函数保留为 No-op 以兼容已有调用点，零延迟、不阻塞退出。
 */
export async function flushAgentConversations(
  _projectSession?: ProjectSessionContext | null | undefined,
): Promise<void> {
  return Promise.resolve()
}

export function subscribeAgentConversationPersistence(): void {
  // No-op: 彻底废除前端写盘监听器与防抖定时器
}
