import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PresetsSettings from '../PresetsSettings'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import type { ModelProfile } from '../../../shared/ipc-channels'

const testModel: ModelProfile = {
  id: 'test-model',
  name: 'Gemini 3.8 Flash',
  provider: 'gemini',
  protocol: 'gemini',
  modelName: 'gemini-3.8-flash',
  apiKey: 'key',
  baseUrl: 'https://gemini.api',
  temperature: 0.7,
  maxTokens: 8192,
  purposes: ['generation'],
  capabilities: {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 8192,
    reasoning: true,
    structuredOutput: true,
    usage: true,
  },
}

const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalLLMState = useLLMStore.getState()

afterEach(() => {
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  useLLMStore.setState(originalLLMState)
})

describe('PresetsSettings component', () => {
  it('renders task model and thinking matrix in Chinese', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    useLLMStore.setState({
      models: [testModel],
      defaultModelId: 'test-model',
      taskModelRouting: {},
    })

    const markup = renderToStaticMarkup(<PresetsSettings />)

    expect(markup).toContain('AI 创作环节预设')
    expect(markup).toContain('全局默认')
    expect(markup).toContain('重置')
    expect(markup).toContain('核心大纲与设定推演')
    expect(markup).toContain('故事规划与分卷蓝图')
    expect(markup).toContain('章节起草与正文扩写')
    expect(markup).toContain('审稿质检与润色改写')
    expect(markup).toContain('侧边栏 AI 创作助手')
    expect(markup).toContain('思考')
  })

  it('renders task model and thinking matrix in English', () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useLLMStore.setState({
      models: [testModel],
      defaultModelId: 'test-model',
      taskModelRouting: {},
    })

    const markup = renderToStaticMarkup(<PresetsSettings />)

    expect(markup).toContain('AI Creation Presets')
    expect(markup).toContain('Global Default')
    expect(markup).toContain('Reset')
    expect(markup).toContain('Core Outline &amp; Novel Settings')
    expect(markup).toContain('Story Planning &amp; Beat Sheets')
    expect(markup).toContain('Chapter Drafting &amp; Prose Expansion')
    expect(markup).toContain('Review, Quality Check &amp; Polish')
    expect(markup).toContain('Sidebar Creative Assistant')
  })
})
