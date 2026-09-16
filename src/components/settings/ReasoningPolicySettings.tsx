import { useState } from 'react'

import type { ModelProfile } from '../../shared/ipc-channels'
import type { ModelCapabilities } from '../../shared/provider-presets'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { resolveReasoningPolicy } from '../../shared/reasoning-policy'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  ReasoningEffort,
  ReasoningOverride,
  ReasoningResolutionStatus,
} from '../../shared/reasoning-types'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'

export function ProjectCreativeStrategySettings() {
  const text = useLocaleStore(state => state.text)
  const currentProject = useProjectStore(state => state.currentProject)
  const updateNovelConfig = useProjectStore(state => state.updateNovelConfig)
  const saveProject = useProjectStore(state => state.saveProject)
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const creativeStrategy = currentProject?.novelConfig.creativeStrategy ?? 'auto'
  const updateCreativeStrategy = async (value: CreativeStrategy) => {
    const session = projectSessionContextFromProject(currentProject)
    if (!session) return
    setProjectSaveState('saving')
    updateNovelConfig({ creativeStrategy: value }, session)
    const saved = await saveProject(session)
    setProjectSaveState(saved ? 'saved' : 'error')
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <Label>{text('创作策略（当前项目）', 'Creative strategy (current project)')}</Label>
      <NativeSelect
        value={creativeStrategy}
        disabled={!currentProject || projectSaveState === 'saving'}
        onChange={event => { void updateCreativeStrategy(event.target.value as CreativeStrategy) }}
        aria-label={text('创作策略（当前项目）', 'Creative strategy (current project)')}
      >
        <option value="auto">{text('自动', 'Auto')}</option>
        <option value="fluent-drafting">{text('流畅起草', 'Fluent drafting')}</option>
        <option value="consistency-first">{text('一致性优先', 'Consistency first')}</option>
        <option value="deep-planning">{text('深度规划', 'Deep planning')}</option>
      </NativeSelect>
      <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
        {!currentProject
          ? text('打开项目后可配置；该设置跟随项目，不随模型切换。', 'Open a project to configure this. It follows the project, not the selected model.')
          : projectSaveState === 'saving'
            ? text('正在保存项目策略…', 'Saving project strategy…')
            : projectSaveState === 'error'
              ? text('项目策略保存失败。', 'Could not save the project strategy.')
              : text('该设置跟随项目，不随模型切换。', 'This setting follows the project and does not change with the model.')}
      </p>
    </div>
  )
}

export function ModelReasoningOverrideSettings({
  model,
  onModelChange,
}: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  const text = useLocaleStore(state => state.text)
  const creativeStrategy = useProjectStore(state => state.currentProject?.novelConfig.creativeStrategy ?? 'auto')
  const effortLabel = (value: ReasoningEffort | EffectiveReasoningEffort | null): string => {
    if (value === null) return '—'
    return {
      off: text('关闭', 'Off'),
      low: text('低', 'Low'),
      medium: text('中', 'Medium'),
      high: text('高', 'High'),
      max: text('最高', 'Max'),
    }[value]
  }
  const drafting = resolveReasoningPolicy({ model, creativeStrategy, stage: 'drafting' })
  const planning = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'planning',
  })
  const review = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'review',
  })

  const statusLabel = (status: ReasoningResolutionStatus) => ({
    mapped: text('已映射', 'Mapped'),
    capped: text('已限制', 'Capped'),
    forced: text('模型强制', 'Model-forced'),
    unsupported: text('不支持 / 不发送参数', 'Unsupported / no parameter sent'),
  }[status])

  const outcome = (
    label: string,
    resolution: typeof drafting,
  ) => (
    <div className="flex items-center justify-between gap-3 text-xs" data-reasoning-status={resolution.status}>
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="text-right text-[var(--color-text)]">
        {effortLabel(resolution.requested)} → {effortLabel(resolution.effective)}
        <span className="ml-1 text-[var(--color-text-muted)]">({statusLabel(resolution.status)})</span>
      </span>
    </div>
  )

  return (
    <div className="space-y-3" data-model-reasoning-override-settings>
      <div>
        <Label>{text('模型推理覆盖', 'Model reasoning override')}</Label>
        <NativeSelect
          value={model.reasoningOverride ?? 'auto'}
          onChange={event => onModelChange({
            ...model,
            reasoningOverride: event.target.value as ReasoningOverride,
          })}
          aria-label={text('模型推理覆盖', 'Model reasoning override')}
        >
          <option value="auto">{text('自动（遵循项目与阶段）', 'Auto (project and stage)')}</option>
          <option value="off">{text('关闭', 'Off')}</option>
          <option value="low">{text('低', 'Low')}</option>
          <option value="medium">{text('中', 'Medium')}</option>
          <option value="high">{text('高', 'High')}</option>
          <option value="max">{text('最高', 'Max')}</option>
        </NativeSelect>
        <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
          {text(
            '设置该模型的思考强度偏好，各创作阶段将按此策略下发给底层推理模型。',
            'Configure the reasoning effort preference for this model. Creative stages dispatch this setting to the underlying model.',
          )}
        </p>
      </div>

      {model.capabilities?.reasoning && (
        <div>
          <Label>{text('推理协议适配器', 'Reasoning protocol adapter')}</Label>
          <NativeSelect
            value={model.capabilities.reasoningAdapter ?? 'auto'}
            onChange={event => onModelChange({
              ...model,
              capabilities: {
                ...model.capabilities!,
                reasoningAdapter: event.target.value === 'auto'
                  ? undefined
                  : event.target.value as ModelCapabilities['reasoningAdapter'],
              },
            })}
            aria-label={text('推理协议适配器', 'Reasoning protocol adapter')}
          >
            <option value="auto">{text('自动（预设匹配/原生直通）', 'Auto (Preset / Native passthrough)')}</option>
            <option value="openai-reasoning-effort">{text('OpenAI Reasoning Effort (reasoning_effort)', 'OpenAI Reasoning Effort (reasoning_effort)')}</option>
            <option value="deepseek-v4-thinking">{text('DeepSeek Thinking (thinking.type)', 'DeepSeek Thinking (thinking.type)')}</option>
            <option value="gemini-thinking-budget">{text('Gemini Thinking Budget (thinkingConfig)', 'Gemini Thinking Budget (thinkingConfig)')}</option>
            <option value="none">{text('原生直通（不发送私有协议字段）', 'Native passthrough (Omit vendor fields)')}</option>
          </NativeSelect>
          <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
            {text(
              '指定推理参数在 HTTP 请求中的序列化格式，防止中转代理网关因未知私有字段返回 400。',
              'Specify how reasoning parameters are serialized to avoid 400 errors from proxy gateways.',
            )}
          </p>
        </div>
      )}

      <div className="space-y-1.5 rounded-md bg-[var(--color-bg)] p-2" aria-label={text('实际生效推理强度', 'Effective reasoning effort')}>
        {outcome(text('章节起草', 'Chapter drafting'), drafting)}
        {outcome(text('故事规划', 'Story planning'), planning)}
        {outcome(text('审稿与修订', 'Review and revision'), review)}
      </div>
    </div>
  )
}

export default function ReasoningPolicySettings(props: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3" data-reasoning-policy-settings>
      <ProjectCreativeStrategySettings />
      <ModelReasoningOverrideSettings {...props} />
    </div>
  )
}
