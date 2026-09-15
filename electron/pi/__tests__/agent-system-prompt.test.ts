import { describe, expect, it } from 'vitest'

import { getBuiltinPromptTemplate } from '../../../src/services/prompt-templates'
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
  it('uses the settings writing-identity template when no project is open', () => {
    const prompt = buildMainProcessAgentSystemPrompt(null)
    expect(prompt).toContain('你是一位经验丰富的长篇小说写作助手')
    expect(prompt).toContain('【不可变系统合同】')
    expect(prompt).toContain('【不可变助手边界】')
    expect(prompt).toContain('每轮用户消息前会附带当前应用状态')
    expect(prompt).not.toContain('应用级助手')
    expect(prompt).not.toContain('<tool_call>')
    expect(prompt).not.toContain('当前项目上下文')
  })

  it('injects L0 project facts without XML tool instructions', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core())
    expect(prompt).toContain('你是一位经验丰富的长篇小说写作助手')
    expect(prompt).toContain('项目名称: 潮门')
    expect(prompt).toContain('计划章节数: 80')
    expect(prompt).toContain('核心大纲: 顾舟必须在终章前揭开潮门真相。')
    expect(prompt).not.toContain('<tool_call>')
    expect(prompt).not.toContain('每次最多一个')
  })

  it('localizes identity and L0 labels to the project writing language', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core({ writingLanguage: 'en-US' }))
    expect(prompt).toContain('You are an experienced long-form fiction-writing assistant')
    expect(prompt).toContain('[Immutable system contract]')
    expect(prompt).toContain('Current project context')
    expect(prompt).toContain('Project name: 潮门')
    expect(prompt).toContain('Genre: Mystery')
    expect(prompt).not.toContain('当前项目上下文')
    expect(prompt).not.toContain('你是一位经验丰富的长篇小说写作助手')
  })

  it('uses a caller-supplied identity overlay instead of the built-in role', () => {
    const builtin = getBuiltinPromptTemplate('assistant_writing_identity', 'zh-CN')!
    const prompt = buildMainProcessAgentSystemPrompt(core(), {
      ...builtin,
      systemRole: '你是潮门的连续性编辑。',
    })
    expect(prompt).toContain('你是潮门的连续性编辑。')
    expect(prompt).not.toContain('你是一位经验丰富的长篇小说写作助手')
    expect(prompt).toContain('项目名称: 潮门')
  })

  it('lists available skills through Pi formatSkillsForSystemPrompt', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core(), undefined, [
      {
        name: 'review-chapter',
        description: 'Reviews a chapter for plot logic and pacing.',
        location: 'builtin://review-chapter',
        source: 'builtin',
      },
      {
        name: 'scene-craft',
        description: '场景塑造',
        location: 'C:\\Users\\me\\.vela\\skills\\scene-craft\\SKILL.md',
        source: 'user',
      },
    ])
    expect(prompt).toContain('The following skills provide specialized instructions for specific tasks.')
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('<name>review-chapter</name>')
    expect(prompt).toContain('<description>Reviews a chapter for plot logic and pacing.</description>')
    expect(prompt).toContain('<location>builtin://review-chapter</location>')
    expect(prompt).toContain('C:\\Users\\me\\.vela\\skills\\scene-craft\\SKILL.md')
    // 技能正文永远不进 system prompt：助手用 /技能名 让用户显式启用。
    expect(prompt).toContain('/技能名')
    expect(prompt).toContain('不要用 read_file 去读技能文件')
  })

  it('localizes the skill invocation note and omits the block without skills', () => {
    const skill = {
      name: 'scene-craft',
      description: 'Scene craft',
      location: '/home/me/.vela/skills/scene-craft/SKILL.md',
      source: 'user' as const,
    }
    const english = buildMainProcessAgentSystemPrompt(core({ writingLanguage: 'en-US' }), undefined, [skill])
    expect(english).toContain('In this application skills are invoked by the user')
    expect(english).toContain('suggest that the user run `/skill-name`')
    expect(english).not.toContain('/技能名')

    const noSkills = buildMainProcessAgentSystemPrompt(core())
    expect(noSkills).not.toContain('<available_skills>')
    const emptySkills = buildMainProcessAgentSystemPrompt(core(), undefined, [])
    expect(emptySkills).not.toContain('<available_skills>')
  })

  it('drops the project workflow sentence from the skill note for the app assistant', () => {
    const skill = {
      name: 'scene-craft',
      description: 'Scene craft',
      location: '/home/me/.vela/skills/scene-craft/SKILL.md',
      source: 'user' as const,
    }
    const projectPrompt = buildMainProcessAgentSystemPrompt(core(), undefined, [skill], 'project')
    expect(projectPrompt).toContain('写作工作流也可以在某个阶段绑定技能')

    const globalPrompt = buildMainProcessAgentSystemPrompt(null, undefined, [skill], 'global')
    expect(globalPrompt).toContain('<available_skills>')
    expect(globalPrompt).toContain('用户在输入框输入 `/技能名` 时')
    expect(globalPrompt).not.toContain('工作流也可以在某个阶段绑定技能')
    // 界面助手没有项目事实。
    expect(globalPrompt).not.toContain('当前项目上下文')
  })

  it('hides skills marked as not user-invocable from the model list', () => {
    const prompt = buildMainProcessAgentSystemPrompt(core(), undefined, [
      {
        name: 'internal-only',
        description: 'Hidden helper.',
        location: 'builtin://internal-only',
        source: 'builtin',
        disableModelInvocation: true,
      },
    ])
    expect(prompt).not.toContain('<available_skills>')
    expect(prompt).not.toContain('internal-only')
  })
})
