/**
 * Vela Agent Tool 注册表
 *
 * 统一管理所有 Agent 可调用的工具（内置 Tool / MCP Tool / Skill Tool）。
 * 参考 Claude Code 的 Tool 系统设计，但针对小说创作场景做了精简。
 *
 * 设计要点：
 * 1. 统一的 AgentTool 接口 — 无论来源，Agent Engine 只看到这一个接口
 * 2. requiresConfirmation 字段控制安全性 — 只读工具自动执行，写入工具需用户确认
 * 3. source 字段标识来源 — 方便 UI 渲染不同的视觉标记
 */

import type { FileWriteCommitState, ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'
import type { WorkflowStatus } from '../../stores/workflow-store'

// ===== JSON Schema 简化类型 =====

/** 简化的 JSON Schema 描述（用于 Tool 参数定义） */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, {
    type: string
    description: string
    descriptionEn?: string
    enum?: string[]
    default?: unknown
  }>
  required?: string[]
}

// ===== Tool 执行结果 =====

/** Tool 执行产物（Agent 创建/修改的文件等） */
interface ToolArtifactBase {
  /** 工具执行时冻结的来源项目路径，仅用于显示和一致性检查，不单独授予权限。 */
  readonly projectPath: string
  /** 产物必须绑定产生时的完整项目会话；旧 lease 产物不能在重开后复用。 */
  readonly projectSession: ProjectSessionContext
  /** 显示名称 */
  readonly name: string
}

export type ToolArtifact =
  | (ToolArtifactBase & {
    readonly type: 'file_created' | 'file_modified' | 'tab_opened'
    /** 文件路径或资源标识 */
    readonly path?: string
    readonly runId?: never
    readonly status?: never
  })
  | (ToolArtifactBase & {
    readonly type: 'workflow_started'
    /** A workflow artifact is itself an observable launch receipt. */
    readonly runId: string
    readonly status: WorkflowStatus
    readonly path?: never
  })

export function createToolArtifact<T extends ToolArtifact>(artifact: T): T {
  return Object.freeze({
    ...artifact,
    projectSession: Object.freeze({ ...artifact.projectSession }),
  }) as unknown as T
}

/** Tool 执行结果 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean
  /** 文本结果（注入回 Agent 的对话上下文） */
  content: string
  /** 执行产物列表（可选） */
  artifacts?: ToolArtifact[]
  /** 错误信息（失败时） */
  error?: string
  /** Persistent write outcome; orthogonal to transport/UI success. */
  commitState?: FileWriteCommitState
}

/**
 * Immutable project identity captured before an agent loop or direct tool call.
 * Built-in project tools must use this context instead of looking up a new
 * renderer active lease while they are executing.
 */
export interface AgentExecutionContext {
  readonly projectSession: ProjectSessionContext | null
  /** Visible interface language frozen for this complete Agent turn. */
  readonly uiLocale: import('../../i18n/types').Locale
  /** Model-facing language frozen for this complete Agent turn. */
  readonly writingLanguage: WritingLanguage
  /**
   * Model explicitly selected for this Agent turn. It is captured outside of
   * LLM tool arguments so a model response cannot choose a billable model.
   */
  readonly selectedModelId: string | null
  /** One tool call's cancellation signal; write tools check it before crossing their commit point. */
  readonly abortSignal?: AbortSignal
  /** Marks the point after which a transport failure cannot be reported as a clean rollback. */
  readonly markSideEffectStarted?: () => void
}

// ===== Tool 定义 =====

/** Tool 来源分类 */
export type ToolSource = 'builtin' | 'mcp' | 'skill'

/** Agent Tool 接口 — 所有种类的 Tool 都实现此接口 */
export interface AgentTool {
  /** 唯一标识符（MCP Tool 使用 mcp__serverId__toolName 命名空间） */
  name: string
  /** Tool 用途描述（Agent 凭此决定何时调用） */
  description: string
  descriptionEn?: string
  /** 来源分类 — 影响 UI 渲染风格 */
  source: ToolSource
  /** 参数 JSON Schema */
  inputSchema: ToolInputSchema
  /** 是否需要用户确认后才执行（写入型操作 = true） */
  requiresConfirmation: boolean
  /** 是否为只读操作 */
  isReadOnly: boolean
  /** 执行函数 */
  execute: (
    args: Record<string, unknown>,
    context?: AgentExecutionContext,
  ) => Promise<ToolResult>
  /** 可选的用户友好名称（UI 显示用，比 name 更可读） */
  userFacingName?: string
}

// ===== Tool 注册表 =====

/**
 * Tool 注册表 — 管理所有可用 Tool 的中央注册中心
 *
 * 支持：
 * - 注册/注销 Tool（支持动态注册 MCP Tool）
 * - 按名称查找 Tool
 * - 列出所有可用 Tool
 * - 生成 Tool 描述（注入系统提示词）
 */
class ToolRegistryImpl {
  private tools: Map<string, AgentTool> = new Map()

  /** 注册一个 Tool */
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" 已注册，将被覆盖`)
    }
    this.tools.set(tool.name, tool)
  }

  /** 批量注册 Tool */
  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /** 注销一个 Tool */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** 注销某个来源的所有 Tool（例如 MCP 断开连接时） */
  unregisterBySource(source: ToolSource): number {
    let count = 0
    for (const [name, tool] of this.tools) {
      if (tool.source === source) {
        this.tools.delete(name)
        count++
      }
    }
    return count
  }

  /** 按名称查找 Tool */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  /** 列出所有已注册的 Tool */
  listAll(): AgentTool[] {
    return Array.from(this.tools.values())
  }

  /** 按来源列出 Tool */
  listBySource(source: ToolSource): AgentTool[] {
    return this.listAll().filter(t => t.source === source)
  }

  /** 获取已注册 Tool 数量 */
  get size(): number {
    return this.tools.size
  }

  /** 清空所有 Tool（用于重置状态） */
  clear(): void {
    this.tools.clear()
  }
}

/** 全局单例 Tool 注册表 */
export const toolRegistry = new ToolRegistryImpl()

/**
 * 渲染层工具注册表只用于界面记账（MCP 连接状态、Skill 列表）与类型共享。
 *
 * 模型可见的工具表由主进程构建：electron/pi/tool-builder.ts:buildAgentTools()。
 * 不要在这里注册"给模型用"的工具——它不会被发送给任何模型。
 */
