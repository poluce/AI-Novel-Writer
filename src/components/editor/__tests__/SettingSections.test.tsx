import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingSection } from '../SettingSections'
import { useLocaleStore } from '../../../stores/locale-store'

const originalLocaleState = useLocaleStore.getState()

afterEach(() => {
  useLocaleStore.setState(originalLocaleState)
})

describe('SettingSection component', () => {
  it('does not render clear button when onClear is not provided', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const markup = renderToStaticMarkup(
      <SettingSection
        title="核心大纲"
        collapsed={false}
        onToggle={vi.fn()}
        onGenerate={vi.fn()}
      >
        <div>Content</div>
      </SettingSection>,
    )

    expect(markup).toContain('核心大纲')
    expect(markup).toContain('AI 生成')
    expect(markup).not.toContain('清除')
  })

  it('renders clear button to the left of AI generate when onClear is provided', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const markup = renderToStaticMarkup(
      <SettingSection
        title="核心大纲"
        collapsed={false}
        onToggle={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
      >
        <div>Content</div>
      </SettingSection>,
    )

    expect(markup).toContain('核心大纲')
    expect(markup).toContain('清除')
    expect(markup).toContain('AI 生成')
    // Clear button appears before AI generate button in DOM order
    const clearIndex = markup.indexOf('清除')
    const generateIndex = markup.indexOf('AI 生成')
    expect(clearIndex).toBeGreaterThan(0)
    expect(generateIndex).toBeGreaterThan(clearIndex)
  })

  it('disables clear button when clearDisabled is true', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const markup = renderToStaticMarkup(
      <SettingSection
        title="核心大纲"
        collapsed={false}
        onToggle={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
        clearDisabled={true}
      >
        <div>Content</div>
      </SettingSection>,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('清除')
  })

  it('renders localized text in English', () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const markup = renderToStaticMarkup(
      <SettingSection
        title="Core Outline"
        collapsed={false}
        onToggle={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
      >
        <div>Content</div>
      </SettingSection>,
    )

    expect(markup).toContain('Core Outline')
    expect(markup).toContain('Clear')
    expect(markup).toContain('Generate with AI')
  })
})
