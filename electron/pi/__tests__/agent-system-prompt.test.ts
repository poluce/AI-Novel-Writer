import { describe, expect, it } from 'vitest'

import type { ProjectCoreData } from '../../repositories/project-core-repository'
import { buildMainProcessAgentSystemPrompt } from '../agent-system-prompt'

function core(overrides: Partial<ProjectCoreData> = {}): ProjectCoreData {
  return {
    projectName: '潮门',
    genre: '悬疑',
    subGenre: '',
    targetAudience: '男频',
    totalChapters: 80,
    wordsPerChapter: 3000,
    writingLanguage: 'zh-CN',
    creativeStrategy: 'auto',
    narrativeThreadDormantChapterThreshold: 3,
    plotStructure: 'three_act',
    narrativePov: 'third_limited',
    writingStyle: '短句，克制。',
    referenceWorks: '',
    globalGuidance: '',
    goldenFinger: '',
    coreOutline: '顾舟必须在终章前揭开潮门真相。',
    worldSetting: '',
    protagonistProfile: '',
    premise: '',
    worldbuilding: '',
    charactersArch: '',
    synopsis: '',
    characterStates: '',
    ...overrides,
  }
}

describe('buildMainProcessAgentSystemPrompt', () => {
  it('keeps a tool-free identity when no project is open', () => {
    const prompt = buildMainProcessAgentSystemPrompt(null)
    expect(prompt).toContain('应用级助手')
    expect(prompt).not.toContain('<tool_call>')
    expect(prompt).not.toContain('当前项目上下文')
  })

  it('injects L0 project facts without XML tool instructions', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core())
    expect(prompt).toContain('应用级助手')
    expect(prompt).toContain('项目名称: 潮门')
    expect(prompt).toContain('计划章节数: 80')
    expect(prompt).toContain('核心大纲: 顾舟必须在终章前揭开潮门真相。')
    expect(prompt).not.toContain('<tool_call>')
    expect(prompt).not.toContain('每次最多一个')
  })

  it('localizes L0 labels to the project writing language', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core({ writingLanguage: 'en-US' }))
    expect(prompt).toContain('Current project context')
    expect(prompt).toContain('Project name: 潮门')
    expect(prompt).toContain('Genre: Mystery')
    expect(prompt).not.toContain('当前项目上下文')
  })
})
