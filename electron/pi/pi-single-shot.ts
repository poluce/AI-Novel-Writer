import type { AgentTool } from '@earendil-works/pi-agent-core'

import { createPiModels } from './pi-models'

import type { ModelProfile } from '../../src/shared/ipc-channels'

export interface SingleShotResult {
  /** The submit_* tool arguments (the artifact), or undefined if the model returned text only. */
  artifact: Record<string, unknown> | undefined
  /** Visible text accumulated from the stream (may be empty when the model only called the tool). */
  text: string
}

/**
 * One-shot pi-ai streaming call with a forced submit_* tool. The model must
 * emit its artifact as the tool's arguments; no read tools, no Agent loop.
 */
export async function streamSingleShot(
  profile: ModelProfile,
  systemPrompt: string,
  userPrompt: string,
  submitTool: AgentTool<any>,
): Promise<SingleShotResult> {
  const { models, model } = createPiModels(profile)
  const stream = models.stream(model, {
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
    tools: [submitTool],
  }, { toolChoice: 'any' })

  let text = ''
  let artifact: Record<string, unknown> | undefined
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
    if (event.type === 'toolcall_end') artifact = event.toolCall.arguments
  }
  return { artifact, text }
}
