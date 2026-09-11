export const TOOL_CALLING_REQUIRED_CODE = 'TOOL_CALLING_REQUIRED' as const

export function generationModelLacksToolCalling(
  model: {
    purposes?: readonly string[]
    capabilities?: { toolCalling?: boolean }
  },
): boolean {
  const purposes = model.purposes ?? []
  const embeddingOnly = purposes.includes('embedding') && !purposes.includes('generation')
  if (embeddingOnly) return false
  return model.capabilities?.toolCalling === false
}

export function toolCallingRequiredMessage(locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  return locale === 'en-US'
    ? 'This model does not support native tool calling, so it cannot be used for writing generation. Choose a model with function calling.'
    : '该模型不支持原生工具调用，无法用于写作生成。请更换支持 function calling 的模型。'
}

export function assertGenerationModelSupportsTools(
  model: {
    purposes?: readonly string[]
    capabilities?: { toolCalling?: boolean }
  },
): void {
  if (!generationModelLacksToolCalling(model)) return
  throw Object.assign(new Error(toolCallingRequiredMessage()), {
    code: TOOL_CALLING_REQUIRED_CODE,
  })
}
