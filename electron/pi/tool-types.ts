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

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from '@earendil-works/pi-ai'

export type AnyAgentTool = AgentTool<TSchema, unknown>
