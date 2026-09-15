import fs from 'node:fs'
import path from 'node:path'

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'

import { ConfinedExecutionEnv } from './confined-execution-env'
import type { AnyHarnessTool } from './tool-types'
import { VELA_HOME } from '../utils/config-utils'
import { logFailure } from '../../src/shared/fail-log'

/** 界面助手的工作目录：没有项目时它有自己的一块地，不碰别处。 */
export const AGENT_WORKSPACE_DIR = 'workspace'

/** 没写 timeout 的命令按这个上限跑，避免一条命令把会话挂死。 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120

/**
 * Pi harness 自带的执行工具：读、写、改文件与执行命令。
 *
 * 它们只认 `ExecutionEnv`，所以真正决定"助手能碰哪里"的是调用方传进来的
 * env（见 `projectExecutionEnv` / `globalExecutionEnv`）。写与执行类工具都
 * 进了确认白名单，每一次改动都要用户在确认卡上点头。
 *
 * `bash` 的 timeout 在 Pi 里是可选的（不写就不设上限），这里补一个默认值：
 * 模型仍可以显式给更长的超时，但不会出现"忘了写就一直挂着"。
 */
export function buildExecutionTools(): AnyHarnessTool[] {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    withDefaultTimeout(createBashTool() as AnyHarnessTool),
  ]
}

/** 给缺省 timeout 的命令补上默认上限；schema 不动，模型仍可自行指定。 */
function withDefaultTimeout(tool: AnyHarnessTool): AnyHarnessTool {
  return {
    ...tool,
    execute: (toolCallId, params, onUpdate, toolContext, invocation, context) => {
      const args = params as { timeout?: number }
      return tool.execute(
        toolCallId,
        (args.timeout === undefined
          ? { ...args, timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS }
          : args) as never,
        onUpdate,
        toolContext,
        invocation,
        context,
      )
    },
  }
}

/** 项目助手：cwd 与可访问范围都钉在项目根。 */
export function projectExecutionEnv(projectPath: string): ConfinedExecutionEnv {
  return new ConfinedExecutionEnv(new NodeExecutionEnv({ cwd: projectPath }), [projectPath])
}

/**
 * 界面助手：工作目录是 `~/.vela/workspace`，另外放行用户级技能目录，
 * 好让它读得到技能文件正文。
 */
export function globalExecutionEnv(appDataRoot: string = VELA_HOME): ConfinedExecutionEnv {
  const workspace = path.join(appDataRoot, AGENT_WORKSPACE_DIR)
  try {
    fs.mkdirSync(workspace, { recursive: true })
  } catch (error) {
    logFailure('Agent', 'failed to create agent workspace', error, { workspace })
  }
  return new ConfinedExecutionEnv(new NodeExecutionEnv({ cwd: workspace }), [
    workspace,
    path.join(appDataRoot, 'skills'),
  ])
}
