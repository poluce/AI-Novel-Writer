import type { ModelProfile } from './ipc-channels'

/**
 * 助手会话可选的思考等级。
 *
 * 是 Pi `ModelThinkingLevel` 的一个子集：`off` 表示按 Pi 的默认（关思考），
 * 其余三档直接交给 harness 当 `thinkingLevel` 用。`minimal`/`xhigh`/`max`
 * 不进这个列表——它们要么在 Gemini 侧会被上游拒绝，要么对助手对话没有意义。
 */
export const ASSISTANT_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const

export type AssistantThinkingLevel = typeof ASSISTANT_THINKING_LEVELS[number]

export function isAssistantThinkingLevel(value: unknown): value is AssistantThinkingLevel {
  return typeof value === 'string'
    && (ASSISTANT_THINKING_LEVELS as readonly string[]).includes(value)
}

/**
 * 清洗渲染层送来的思考等级；非法值被丢掉而不是让整轮失败。
 *
 * 丢掉之后这一轮就按 `off`（Pi 默认）走，与这个字段不存在时完全一致。
 */
export function acceptedAssistantThinkingLevel(value: unknown): AssistantThinkingLevel | undefined {
  return isAssistantThinkingLevel(value) ? value : undefined
}

/**
 * 渠道分组键：同一个 `provider + protocol + baseUrl` 视为一个渠道。
 * 若 Profile 指定了明确的 `channelName`，则将其作为独立渠道的命名归组标识。
 *
 * 应用把"模型"存成扁平的档案（一个模型一条，各自带凭据），设置页与助手
 * 输入框都按这个键把它们归成"渠道 → 模型"两层；这里刻意不改底层存储格式。
 */
export function modelChannelKey(
  profile: Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl'> & { channelName?: string },
): string {
  const baseUrl = (profile.baseUrl ?? '').replace(/\/+$/, '').toLowerCase()
  const channel = profile.channelName?.trim()
  return channel
    ? `${profile.provider}\u0000${profile.protocol}\u0000${baseUrl}\u0000${channel}`
    : `${profile.provider}\u0000${profile.protocol}\u0000${baseUrl}`
}

/** 渠道显示名：若配置了 channelName 则优先使用，其次退回 host / protocol / provider。 */
export function modelChannelLabel(
  profile: Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl'> & { channelName?: string; name?: string },
): string {
  if (profile.channelName?.trim()) {
    return profile.channelName.trim()
  }
  const raw = (profile.baseUrl ?? '').trim()
  if (raw) {
    try {
      return new URL(raw).host
    } catch {
      return raw
    }
  }
  return profile.protocol || profile.provider
}

/** 一个渠道下的模型条目（档案 + 它代表的模型名）。 */
export interface ModelChannelGroup {
  key: string
  label: string
  /** 渠道名称（如 hajimi，若未配置则回退为 label）。 */
  channelName: string
  /** 渠道下第一条档案，用作"这个渠道怎么连"的代表。 */
  representative: ModelProfile
  models: Array<{ profile: ModelProfile; modelName: string }>
}

/** 把扁平档案按渠道归组；渠道内按模型名排序，渠道按首次出现顺序。 */
export function groupModelsByChannel(profiles: readonly ModelProfile[]): ModelChannelGroup[] {
  const groups = new Map<string, ModelChannelGroup>()
  for (const profile of profiles) {
    const key = modelChannelKey(profile)
    let group = groups.get(key)
    if (!group) {
      const explicitChannel = profiles.find(p => modelChannelKey(p) === key && p.channelName?.trim())?.channelName?.trim()
      const fallbackName = profile.channelName?.trim()
        || (profile.name && profile.name.trim() !== profile.modelName.trim() ? profile.name.trim() : '')
        || modelChannelLabel(profile)
      const channelName = explicitChannel || fallbackName

      group = {
        key,
        label: modelChannelLabel(profile),
        channelName,
        representative: profile,
        models: [],
      }
      groups.set(key, group)
    }
    const modelName = profile.modelName.trim()
    if (!modelName) continue
    if (group.models.some(candidate => candidate.modelName === modelName)) continue
    group.models.push({ profile, modelName })
  }
  for (const group of groups.values()) {
    group.models.sort((left, right) => left.modelName.localeCompare(right.modelName))
  }
  return [...groups.values()]
}

/**
 * 该渠道下是否已经有同名模型；用于"添加模型"时跳过重复。
 * 同一个模型名在同一渠道里只保留一条档案。
 */
export function channelHasModel(
  profiles: readonly ModelProfile[],
  channel: Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl'> & { channelName?: string },
  modelName: string,
): boolean {
  const normalized = modelName.trim()
  const channelBase = (channel.baseUrl ?? '').replace(/\/+$/, '').toLowerCase()
  const channelName = channel.channelName?.trim()

  return profiles.some(profile => {
    if (profile.modelName.trim() !== normalized) return false
    if (profile.provider !== channel.provider) return false
    if (profile.protocol !== channel.protocol) return false
    const profileBase = (profile.baseUrl ?? '').replace(/\/+$/, '').toLowerCase()
    if (profileBase !== channelBase) return false
    if (channelName && profile.channelName?.trim() && profile.channelName.trim() !== channelName) {
      return false
    }
    return true
  })
}
