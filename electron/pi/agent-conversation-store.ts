import path from 'node:path'

import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { DIR_VELA_INTERNAL } from '../../src/shared/project-paths'
import { logFailure, logInfo } from '../../src/shared/fail-log'
import { VELA_HOME } from '../utils/config-utils'

/** 会话文件所在的一级目录名（项目内与 `~/.vela` 下同名）。 */
export const SESSIONS_DIR = 'agent-sessions'

export interface AgentConversationStoreRoot {
  /** 会话文件根目录。 */
  sessionsRoot: string
  /** 这个 store 服务的项目根；决定 Pi 会话元数据里的 cwd。 */
  cwd: string
}

/**
 * 一个作用域的 Pi 会话存档：项目助手落在项目内，界面助手落在应用数据目录。
 *
 * 这一层只负责「按 conversationId 打开/创建/删除一个 Pi 会话」——条目写入、
 * 上下文投影、压缩全部由 `AgentHarness` 在会话内部完成（见 agent-session.ts）。
 */
export class AgentConversationStore {
  private readonly fileSystem: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  private readonly opened = new Map<string, Session<JsonlSessionMetadata>>()
  private readonly known = new Map<string, JsonlSessionMetadata>()
  private scanned = false
  private closed = false

  /** 项目助手：会话存档落在项目内，跟随书一起备份/删除。 */
  static forProject(projectPath: string): AgentConversationStore {
    return new AgentConversationStore({
      sessionsRoot: path.join(projectPath, DIR_VELA_INTERNAL, SESSIONS_DIR),
      cwd: projectPath,
    })
  }

  /** 界面助手：会话存档落在应用数据目录，与项目无关。 */
  static forGlobal(appDataRoot: string = VELA_HOME): AgentConversationStore {
    return new AgentConversationStore({
      sessionsRoot: path.join(appDataRoot, SESSIONS_DIR),
      cwd: appDataRoot,
    })
  }

  private readonly cwd: string

  constructor(root: AgentConversationStoreRoot) {
    this.cwd = root.cwd
    this.fileSystem = new NodeExecutionEnv({ cwd: root.cwd })
    this.repo = new JsonlSessionRepo({
      fileSystem: this.fileSystem,
      sessionsRoot: root.sessionsRoot,
    })
  }

  /**
   * 取这个对话的 Pi 会话；`create` 为真时没有就建一个。
   * 返回的会话直接交给 `AgentHarness.create()`。
   */
  async open(
    conversationId: string,
    options: { create?: boolean } = {},
  ): Promise<Session<JsonlSessionMetadata> | null> {
    return this.sessionFor(conversationId, options.create ?? false)
  }

  /**
   * 忘掉一个已关闭的会话。
   *
   * harness 关闭时会连会话一起关掉，而仓库拒绝重复打开仍登记在册的会话，
   * 所以关掉 harness 的一方必须同时让这里松手，下一次打开才会重新读盘。
   */
  forget(conversationId: string): void {
    this.opened.delete(conversationId)
  }

  async delete(conversationId: string): Promise<void> {
    const metadata = await this.metadataFor(conversationId)
    if (!metadata) return
    // 仓库拒绝删除仍打开的会话，先关掉再删。
    const open = this.opened.get(conversationId)
    if (open) {
      this.opened.delete(conversationId)
      await open.close(BACKGROUND_CONTEXT)
    }
    await this.repo.delete(metadata, BACKGROUND_CONTEXT)
    this.known.delete(conversationId)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const session of this.opened.values()) {
      try {
        await session.close(BACKGROUND_CONTEXT)
      } catch (error) {
        logFailure('Agent', 'failed to close conversation session', error)
      }
    }
    this.opened.clear()
    try {
      await this.repo.close(BACKGROUND_CONTEXT)
    } catch (error) {
      logFailure('Agent', 'failed to close conversation session repo', error)
    }
  }

  private async sessionFor(
    conversationId: string,
    create: boolean,
  ): Promise<Session<JsonlSessionMetadata> | null> {
    if (this.closed) return null
    const cached = this.opened.get(conversationId)
    if (cached) return cached
    try {
      const metadata = await this.metadataFor(conversationId)
      if (metadata) {
        const session = await this.repo.open(metadata, BACKGROUND_CONTEXT)
        this.opened.set(conversationId, session)
        return session
      }
      if (!create) return null
      const session = await this.repo.create(
        { id: conversationId, cwd: this.cwd },
        BACKGROUND_CONTEXT,
      )
      this.opened.set(conversationId, session)
      this.known.set(conversationId, session.metadata)
      logInfo('Agent', 'conversation session created', {
        conversationId,
        path: session.metadata.path,
      })
      return session
    } catch (error) {
      logFailure('Agent', 'failed to open conversation session', error, { conversationId })
      return null
    }
  }

  private async metadataFor(conversationId: string): Promise<JsonlSessionMetadata | undefined> {
    if (!this.scanned) {
      const list = await this.repo.list({ cwd: this.cwd }, BACKGROUND_CONTEXT)
      for (const metadata of list) this.known.set(metadata.id, metadata)
      this.scanned = true
    }
    return this.known.get(conversationId)
  }
}
