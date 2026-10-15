import { useMemo, useState, type ReactElement } from 'react'
import { BookOpen, Bot, Compass, PenTool, RotateCcw, ShieldCheck, Sliders } from 'lucide-react'
import type { CreationTaskKey, ModelProfile } from '../../shared/ipc-channels'
import { groupModelsByChannel, type ModelChannelGroup } from '../../shared/agent-runtime'
import type { ReasoningEffort } from '../../shared/reasoning-types'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { toast } from '../ui/Toast'

interface TaskMeta {
  key: CreationTaskKey
  title: string
  titleEn: string
  badge: string
  badgeEn: string
  desc: string
  descEn: string
  icon: typeof BookOpen
}

const CREATION_TASKS: TaskMeta[] = [
  {
    key: 'outline',
    title: '核心大纲与设定推演',
    titleEn: 'Core Outline & Novel Settings',
    badge: '小说设定',
    badgeEn: 'Novel Settings',
    desc: '在《小说设定》面板中通过 AI 生成核心大纲、世界观背景、主角档案、金手指与创作指导风格。需要深度逻辑与因果自洽。',
    descEn: 'Generates core outlines, worldbuilding, protagonist profiles, and golden fingers in the Novel Settings panel. Demands deep logical coherence.',
    icon: BookOpen,
  },
  {
    key: 'planning',
    title: '故事规划与分卷蓝图',
    titleEn: 'Story Planning & Beat Sheets',
    badge: '剧情规划',
    badgeEn: 'Story Planning',
    desc: '故事全书剧情架构推演、分卷剧情规划、主支线情节编排与章节细纲批量拆解。负责全书节奏与长篇框架构建。',
    descEn: 'Architects multi-volume story arcs, plotline progressions, and chapter beat sheets. Responsible for long-form pacing and plot structure.',
    icon: Compass,
  },
  {
    key: 'drafting',
    title: '章节起草与正文扩写',
    titleEn: 'Chapter Drafting & Prose Expansion',
    badge: '章节正文',
    badgeEn: 'Chapter Prose',
    desc: '负责草稿编辑器中的章节正文起草、段落场景扩写、剧情自然续写与生动对话。需要大上下文吞吐与流畅文笔。',
    descEn: 'Generates chapter prose, scene expansions, continuation, and dialogue. Requires high output throughput and expressive writing style.',
    icon: PenTool,
  },
  {
    key: 'review',
    title: '审稿质检与润色改写',
    titleEn: 'Review, Quality Check & Polish',
    badge: '审稿修订',
    badgeEn: 'Review & Revision',
    desc: '审稿面板中的错漏排查、剧情前后矛盾排查、伏笔与暗线核验以及正文字句推敲精修。需要严谨审查与敏锐语感。',
    descEn: 'Inspects plot inconsistencies, checks foreshadowing threads, catches contradictions, and polishes prose nuances.',
    icon: ShieldCheck,
  },
  {
    key: 'assistant',
    title: '侧边栏 AI 创作助手',
    titleEn: 'Sidebar Creative Assistant',
    badge: '创作助手',
    badgeEn: 'Creative Assistant',
    desc: '右侧边栏 AI 创作助手的日常自由对话、头脑风暴讨论、小说背景资料问答与灵感探讨。侧重敏捷低延迟响应。',
    descEn: 'Powers the right sidebar AI assistant for brainstorming, novel lore Q&A, and quick conversational advice.',
    icon: Bot,
  },
]

function isGenerationModel(model: ModelProfile): boolean {
  const purposes = model.purposes
  if (!purposes || purposes.length === 0) return true
  return purposes.includes('generation')
}

function modelOptionLabel(profile: ModelProfile): string {
  if (profile.name && profile.name !== profile.modelName) {
    return `${profile.name} (${profile.modelName})`
  }
  return profile.modelName
}

function renderChannelModelOptGroups(groups: ModelChannelGroup[]): ReactElement[] {
  return groups.map(group => (
    <optgroup key={group.key} label={group.channelName || group.label}>
      {group.models.map(item => (
        <option key={item.profile.id} value={item.profile.id}>
          {modelOptionLabel(item.profile)}
        </option>
      ))}
    </optgroup>
  ))
}

function renderThinkingEffortOptions(
  text: (zhCNText: string, enUSText: string) => string,
  includeGlobalDefault: boolean,
): ReactElement[] {
  const effortOptions = [
    <option key="off" value="off">{text('关闭', 'Off')}</option>,
    <option key="low" value="low">{text('低', 'Low')}</option>,
    <option key="medium" value="medium">{text('中', 'Medium')}</option>,
    <option key="high" value="high">{text('高', 'High')}</option>,
    <option key="max" value="max">{text('最高', 'Max')}</option>,
  ]
  if (!includeGlobalDefault) return effortOptions
  return [
    <option key="auto" value="auto">{text('全局默认', 'Global Default')}</option>,
    ...effortOptions,
  ]
}

function notifyPersist(ok: boolean, success: string, failure: string): void {
  if (ok) {
    toast.success(success)
    return
  }
  toast.error(failure)
}

export default function PresetsSettings(): ReactElement {
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const defaultThinkingLevel = useLLMStore(s => s.defaultThinkingLevel)
  const setDefaultThinkingLevel = useLLMStore(s => s.setDefaultThinkingLevel)
  const taskModelRouting = useLLMStore(s => s.taskModelRouting)
  const setTaskConfig = useLLMStore(s => s.setTaskConfig)
  const resetTaskModelRouting = useLLMStore(s => s.resetTaskModelRouting)

  const [resetting, setResetting] = useState(false)

  const channelGroups = useMemo(
    () => groupModelsByChannel(models.filter(isGenerationModel)),
    [models],
  )

  const defaultModel = models.find(m => m.id === defaultModelId)
    || models.find(m => m.purposes?.includes('generation'))

  async function handleDefaultModelChange(newModelId: string): Promise<void> {
    if (!newModelId) return
    const ok = await setDefaultModel(newModelId)
    notifyPersist(
      ok,
      text('全局默认生成模型已更新', 'Global default generation model updated'),
      text('更新默认模型失败', 'Failed to update default model'),
    )
  }

  async function handleDefaultThinkingChange(level: ReasoningEffort): Promise<void> {
    const ok = await setDefaultThinkingLevel(level)
    notifyPersist(
      ok,
      text('全局默认思考已更新', 'Global default thinking updated'),
      text('更新默认思考失败', 'Failed to update default thinking'),
    )
  }

  async function handleModelChange(taskKey: CreationTaskKey, value: string): Promise<void> {
    const current = taskModelRouting[taskKey] ?? {}
    const ok = await setTaskConfig(taskKey, {
      ...current,
      modelId: value || null,
    })
    notifyPersist(
      ok,
      text('环节模型配置已更新', 'Task model setting updated'),
      text('保存配置失败', 'Failed to save configuration'),
    )
  }

  async function handleThinkingChange(taskKey: CreationTaskKey, value: string): Promise<void> {
    const current = taskModelRouting[taskKey] ?? {}
    const ok = await setTaskConfig(taskKey, {
      ...current,
      thinkingLevel: value as 'auto' | ReasoningEffort,
    })
    notifyPersist(
      ok,
      text('环节思考强度已更新', 'Task thinking setting updated'),
      text('保存配置失败', 'Failed to save configuration'),
    )
  }

  async function handleResetDefaults(): Promise<void> {
    setResetting(true)
    try {
      const ok = await resetTaskModelRouting()
      notifyPersist(
        ok,
        text('已恢复所有创作环节的推荐搭配', 'Restored recommended presets for all tasks'),
        text('重置配置失败', 'Failed to reset presets'),
      )
    } finally {
      setResetting(false)
    }
  }

  function getEffectiveModel(taskKey: CreationTaskKey): ModelProfile | undefined {
    const configuredId = taskModelRouting[taskKey]?.modelId?.trim()
    if (configuredId) {
      const found = models.find(m => m.id === configuredId)
      if (found) return found
    }
    return defaultModel
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]">
        <div>
          <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2">
            <Sliders size={18} style={{ color: 'var(--color-accent)' }} />
            {text('AI 创作环节预设', 'AI Creation Presets')}
          </h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {text(
              '为各创作环节分配模型与思考强度，未指定模型时自动使用全局默认。',
              'Assign models and thinking effort to tasks. Unassigned tasks use the global default.',
            )}
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto shrink-0 flex-wrap">
          <div className="flex items-center gap-2 text-xs bg-[var(--color-hover)]/50 px-2.5 py-1 rounded-lg border border-[var(--color-border)]">
            <span className="font-semibold text-[var(--color-text)] whitespace-nowrap">{text('全局默认:', 'Global Default:')}</span>
            <div className="flex items-center gap-1">
              <span className="text-[var(--color-text-muted)]">{text('模型', 'Model')}</span>
              <select
                value={defaultModelId ?? ''}
                onChange={e => void handleDefaultModelChange(e.target.value)}
                className="px-2 py-0.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                {renderChannelModelOptGroups(channelGroups)}
              </select>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-[var(--color-text-muted)]">{text('思考', 'Thinking')}</span>
              <select
                value={defaultThinkingLevel}
                onChange={e => void handleDefaultThinkingChange(e.target.value as ReasoningEffort)}
                className="px-2 py-0.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                {renderThinkingEffortOptions(text, false)}
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleResetDefaults()}
            disabled={resetting}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors bg-[var(--color-bg)] cursor-pointer"
            title={text('重置所有环节', 'Reset all tasks')}
          >
            <RotateCcw size={12} className={resetting ? 'animate-spin' : ''} />
            <span>{text('重置', 'Reset')}</span>
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {CREATION_TASKS.map(task => {
          const Icon = task.icon
          const currentConfig = taskModelRouting[task.key] ?? {}
          const configuredModelId = currentConfig.modelId ?? ''
          const currentThinking = currentConfig.thinkingLevel ?? 'auto'
          const effectiveModel = getEffectiveModel(task.key)
          const supportsReasoning = effectiveModel?.capabilities?.reasoning ?? true

          return (
            <div
              key={task.key}
              className="rounded-xl border border-[var(--color-border)] p-3.5 bg-[var(--color-bg)] hover:border-[var(--color-border-hover,#666)] transition-all space-y-2.5 shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-[var(--color-hover)] flex items-center justify-center text-[var(--color-accent)] shrink-0">
                  <Icon size={15} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-[var(--color-text)]">
                    {text(task.title, task.titleEn)}
                  </span>
                  <span className="text-[0.68rem] px-2 py-0.5 rounded-full font-medium bg-[var(--color-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                    {text(task.badge, task.badgeEn)}
                  </span>
                </div>
              </div>

              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed pl-9.5">
                {text(task.desc, task.descEn)}
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[var(--color-border)]">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-[var(--color-text-secondary)] shrink-0 whitespace-nowrap">
                    {text('模型', 'Model')}
                  </label>
                  <select
                    value={configuredModelId}
                    onChange={e => void handleModelChange(task.key, e.target.value)}
                    className="flex-1 min-w-0 px-2.5 py-1 text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-bg))] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] cursor-pointer truncate"
                  >
                    <option value="">{text('全局默认', 'Global Default')}</option>
                    {renderChannelModelOptGroups(channelGroups)}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-[var(--color-text-secondary)] shrink-0 whitespace-nowrap">
                    {text('思考', 'Thinking')}
                  </label>
                  <select
                    value={currentThinking}
                    onChange={e => void handleThinkingChange(task.key, e.target.value)}
                    title={!supportsReasoning ? text('当前模型不支持思考参数', 'Thinking not supported') : undefined}
                    className="flex-1 min-w-0 px-2.5 py-1 text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-bg))] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] cursor-pointer"
                  >
                    {renderThinkingEffortOptions(text, true)}
                  </select>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
