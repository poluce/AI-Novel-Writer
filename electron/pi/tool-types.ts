/**
 * Pi 工具容器类型。
 *
 * 每个工具的参数 schema 都不同（`AgentTool<typeof Schema>`），而会话、工具
 * 构建器与单发层需要把它们放进同一个数组。`AgentTool<never>` 会因
 * `parameters` 属性不协变而失败，`AgentTool<TSchema>` 又会因 `execute`
 * 参数 `Static<TSchema>` 而逆变失败——所以容器只能取库的默认参数位：
 * `AgentTool<TSchema, unknown>`。这是唯一一处「任意工具」定义，其余代码
 * 不再出现 `any`。
 */

import type { AgentHarnessTool, AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core'
import type { TSchema } from '@earendil-works/pi-ai'

/**
 * harness 自带执行工具要求的上下文。
 *
 * 与 Pi 的 `ExecutionToolContext` 同构；那条子路径没有从包里导出，
 * 所以按结构重新声明一次。
 */
export interface HarnessToolContext {
  env: ExecutionEnv
}

export type AnyAgentTool = AgentTool<TSchema, unknown>

/**
 * harness 侧的同一种「任意工具」容器。
 *
 * 取 harness 自带执行工具使用的 `ExecutionToolContext`：领域工具通过
 * `toHarnessTool()` 挂上去之后并不读 toolContext，所以它们在那里做一次
 * 显式断言，换来执行工具与领域工具能放进同一个数组。
 */
export type AnyHarnessTool = AgentHarnessTool<HarnessToolContext, TSchema, unknown>

/**
 * 把领域工具挂到 AgentHarness 上。
 *
 * harness 的 `execute` 多出 onUpdate / toolContext / invocation / context 四个
 * 参数（给需要进度上报与持久化重放的 harness 原生工具用），我们的领域工具
 * 用不上这些：进度可以经 harness 的 `tool_update` 事件透传。适配层只保留
 * `toolCallId` 与 `params`，15 个领域工具因此一行都不用改。
 */
export function toHarnessTool(tool: AnyAgentTool): AnyHarnessTool {
  return {
    ...tool,
    execute: async (toolCallId: string, params: unknown) => {
      try {
        return await tool.execute(toolCallId, params as never)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `工具 ${tool.name} 执行未通过：${message}` }],
          details: { error: message, status: 'failed' },
        }
      }
    },
  } as unknown as AnyHarnessTool
}
