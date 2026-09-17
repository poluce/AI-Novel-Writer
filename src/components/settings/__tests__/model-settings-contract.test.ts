import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('model settings contract', () => {
  it('keeps the user-facing model field vocabulary and provider options in the settings surface', () => {
    const settingsModal = source('src/components/settings/SettingsModal.tsx')

    for (const field of [
      ['模型列表', 'Models'],
      ['base_url', 'base_url'],
      ['API Key', 'API Key'],
      ["上下文窗口", 'Context Window'],
    ]) {
      expect(settingsModal).toContain(`text('${field[0]}', '${field[1]}')`)
    }

    expect(settingsModal).toContain("text('高级设置', 'Advanced settings')")
    expect(settingsModal).toContain("text('温度', 'Temperature')")
    expect(settingsModal).toContain("text('最大输出 Token', 'Max output tokens')")

    for (const provider of ['xai', 'siliconflow']) {
      expect(settingsModal).toContain(`value="${provider}"`)
    }
  })

  it('creates new embedding profiles from the SiliconFlow preset and opens only fixed provider resources through IPC', () => {
    const settingsModal = source('src/components/settings/SettingsModal.tsx')
    const resourceController = source('electron/controllers/model-provider-resource-controller.ts')

    expect(settingsModal).toContain('createModelProfileDraft')
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-invite'")
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-console'")
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-docs'")
    expect(settingsModal).toContain('邀请注册链接')
    expect(settingsModal).toContain('BAAI/bge-m3')
    expect(settingsModal).toContain('免费')
    expect(settingsModal).not.toContain('window.open(')
    expect(settingsModal).not.toContain('shell.openExternal')
    expect(resourceController).toContain('MODEL_PROVIDER_RESOURCE_URLS[resource]')
  })

  it('exposes test connection button and per-model connectivity status indicators in the model list', () => {
    const settingsModal = source('src/components/settings/SettingsModal.tsx')

    expect(settingsModal).toContain("text('测试连接', 'Test connection')")
    expect(settingsModal).toContain("data-test-status={testInfo.status}")
    expect(settingsModal).toContain("handleTestSingleModel")
    expect(settingsModal).toContain("handleTestAllModels")
  })
})
