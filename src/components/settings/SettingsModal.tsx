import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import {
  X, Plus, Trash2, Check, Save, Globe, Cpu, Database,
  Type, Settings2, Zap, Eye, EyeOff, ChevronDown, MessageSquare,
  Info, Palette, ExternalLink, RefreshCw, BookOpen, Search, Sliders, ArrowLeft,
} from 'lucide-react'
import PromptSettings from './PromptSettings'
import SkillSettings from './SkillSettings'
import AppearanceSettings from './AppearanceSettings'
import PresetsSettings from './PresetsSettings'
import { useLLMStore } from '../../stores/llm-store'
import { useThemeStore, FONT_OPTIONS, type FontId } from '../../stores/theme-store'
import type {
  DiscoveredModel,
  ModelDiscoveryErrorCode,
  ModelProfile,
} from '../../shared/ipc-channels'
import { LOW_VRAM_EMBEDDING_OPTIONS, normalizeEmbeddingOptions } from '../../shared/embedding-options'
import type { ModelCapabilities, ProviderPreset } from '../../shared/provider-presets'
import { BUILTIN_PRESETS } from '../../shared/provider-presets'
import { createModelProfileDraft } from '../../shared/model-profile-draft'
import { channelHasModel, groupModelsByChannel, type ModelChannelGroup } from '../../shared/agent-runtime'
import type { ModelProviderResourceId } from '../../shared/model-provider-resources'
import { randomUUID } from '../../utils/id'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { cn } from '../../lib/utils'
import { ipc } from '../../services/ipc-client'
import { Switch } from '../ui/Switch'
import { APP_BRAND } from '../../shared/brand'
import { useLayoutStore, type SettingsSection } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { generationModelLacksToolCalling, toolCallingRequiredMessage } from '../../shared/tool-calling-gate'
import { logFailure } from '../../shared/fail-log'
import type { Locale } from '../../i18n/types'
import { alertError } from '../ui/AlertDialog'
import { toast } from '../ui/Toast'

// ==================== 分类定义 ====================

type SettingsModalSection = SettingsSection | 'appearance'

interface SectionItem {
  id: SettingsModalSection
  label: string
  labelEn: string
  icon: React.ReactNode
  description: string
  descriptionEn: string
}

// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_SECTIONS: SectionItem[] = [
  { id: 'appearance', label: '外观', labelEn: 'Appearance', icon: <Palette size={16} />, description: '主题与界面皮肤彼此独立，可随时切换', descriptionEn: 'Themes and interface skins can be changed independently' },
  { id: 'llm', label: 'AI 生成模型', labelEn: 'Generation models', icon: <Cpu size={16} />, description: '配置用于文章生成、改写、摘要的语言模型', descriptionEn: 'Models used for writing, rewriting, and summarization' },
  { id: 'embedding', label: '向量模型', labelEn: 'Embedding model', icon: <Database size={16} />, description: '配置用于知识库检索的 Embedding 模型', descriptionEn: 'Embedding model used for knowledge retrieval' },
  { id: 'presets', label: '预设', labelEn: 'Presets', icon: <Sliders size={16} />, description: '配置小说创作各阶段（起草、规划、审稿）的思考预设与策略', descriptionEn: 'Configure reasoning presets across writing stages' },
  { id: 'proxy', label: '网络代理', labelEn: 'Network proxy', icon: <Globe size={16} />, description: '配置 HTTP / SOCKS5 代理，用于访问受限 API', descriptionEn: 'HTTP / SOCKS5 proxy for restricted APIs' },
  { id: 'editor', label: '编辑器', labelEn: 'Editor', icon: <Type size={16} />, description: '字体大小、自动保存等编辑器偏好设置', descriptionEn: 'Fonts and other editor preferences' },
  { id: 'prompts', label: '提示词模板', labelEn: 'Prompt templates', icon: <MessageSquare size={16} />, description: '自定义 AI 创作各环节使用的提示词模板', descriptionEn: 'Customize guidance for each AI writing stage' },
  { id: 'skills', label: '写作 Skills', labelEn: 'Writing skills', icon: <BookOpen size={16} />, description: '检查、安装并绑定提示词型写作 Skill', descriptionEn: 'Inspect, install, and bind prompt-only writing skills' },
  { id: 'about', label: '关于', labelEn: 'About', icon: <Info size={16} />, description: '版本、定位与本地部署说明', descriptionEn: 'Version, positioning, and local deployment' },
]

// ==================== 主组件 ====================

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

/** 全屏设置弹窗 */
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const text = useLocaleStore(s => s.text)
  const rawSection = useLayoutStore(s => s.settingsSection)
  const requestedSection: SettingsModalSection = SETTINGS_SECTIONS.some(s => s.id === rawSection)
    ? (rawSection as SettingsModalSection)
    : (SETTINGS_SECTIONS[0]?.id ?? 'appearance')
  const [section, setSection] = useState<SettingsModalSection>(requestedSection)

  useEffect(() => {
    if (!open) return
    // 在提交后同步外部请求，避免 effect 阶段同步 setState 的级联渲染。
    const syncTimer = window.setTimeout(() => setSection(requestedSection), 0)
    return () => window.clearTimeout(syncTimer)
  }, [open, requestedSection])

  if (!open) return null

  return (
    <div
      className="skin-solid-surface fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="relative flex w-[880px] h-[600px] rounded-2xl overflow-hidden shadow-2xl"
        style={{
          backgroundColor: 'var(--color-editor-bg)',
          border: '1px solid var(--color-border)',
        }}
      >
        {/* 左侧导航 */}
        <aside
          className="flex flex-col w-52 flex-shrink-0 py-5 gap-1"
          style={{
            backgroundColor: 'var(--color-sidebar)',
            borderRight: '1px solid var(--color-border)',
          }}
        >
          {/* 标题 */}
          <div className="flex items-center gap-2 px-4 mb-4">
            <Settings2 size={16} style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              {text('设置', 'Settings')}
            </span>
          </div>

          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                'flex items-center gap-2.5 mx-2 px-3 py-2.5 rounded-lg text-left text-sm transition-colors',
                section === s.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]',
              )}
            >
              {s.icon}
              {text(s.label, s.labelEn)}
            </button>
          ))}
        </aside>

        {/* 右侧内容区 */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* 区域标题栏 */}
          <div
            className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
                {(() => { const item = SETTINGS_SECTIONS.find(s => s.id === section); return item ? text(item.label, item.labelEn) : '' })()}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {(() => { const item = SETTINGS_SECTIONS.find(s => s.id === section); return item ? text(item.description, item.descriptionEn) : '' })()}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label={text('关闭设置', 'Close settings')}
              className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--color-hover)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X size={16} />
            </button>
          </div>

          {/* 区域内容 */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {section === 'appearance' && <AppearanceSettings />}
            {section === 'llm' && <LLMSection purposes={['generation', 'refinement', 'summary']} purposeLabel={text('生成模型', 'generation models')} />}
            {section === 'embedding' && <LLMSection purposes={['embedding']} purposeLabel={text('向量模型', 'embedding models')} />}
            {section === 'presets' && <PresetsSettings />}
            {section === 'proxy' && <ProxySection />}
            {section === 'editor' && <EditorSection />}
            {section === 'prompts' && <PromptSettings />}
            {section === 'skills' && <SkillSettings />}
            {section === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}

// ==================== LLM & Embedding 通用区 ====================

type LocalizedText = (zhCNText: string, enUSText: string) => string

/** Open only an allowlisted provider resource through the trusted main-process IPC boundary. */
async function openModelProviderResource(resource: ModelProviderResourceId, text: LocalizedText) {
  try {
    const result = await ipc.invoke('model-provider-resource:open', resource)
    if (!result.success) throw new Error(result.error || text('无法打开服务商页面', 'Unable to open provider page'))
  } catch (error) {
    alertError(String(error), { title: text('打开链接失败', 'Unable to open link') })
  }
}

function LLMSection({
  purposes,
  purposeLabel,
}: {
  purposes: ModelProfile['purposes']
  purposeLabel: string
}) {
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const loaded = useLLMStore(s => s.loaded)
  const loadModels = useLLMStore(s => s.loadModels)
  const saveModel = useLLMStore(s => s.saveModel)
  const deleteModel = useLLMStore(s => s.deleteModel)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const setDefaultEmbeddingModel = useLLMStore(s => s.setDefaultEmbeddingModel)
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!loaded) loadModels()
  }, [loaded, loadModels])

  // 预设直接使用内置常量，无需 IPC 加载
  const presets = BUILTIN_PRESETS

  // 按用途过滤
  const filtered = models.filter((m) =>
    m.purposes?.some((p) => purposes.includes(p as ModelProfile['purposes'][number]))
  )
  const channelGroups = useMemo(() => groupModelsByChannel(filtered), [filtered])

  /** 创建新模型草稿；向量模型由工厂选择完整的 SiliconFlow 默认值。 */
  const handleAdd = () => {
    setEditingModel(createModelProfileDraft({
      id: randomUUID(),
      purposes: [...purposes],
    }))
  }

  /**
   * 把一个渠道下的多个模型一次加进来。
   *
   * 存档结构保持扁平（一个模型 = 一条档案），这里只把当前表单的渠道字段
   * （provider / protocol / baseUrl / apiKey 与高级设置）复制过去、换掉模型名；
   * 同一渠道里已经存在的模型名直接跳过。
   */
  const handleAddModels = async (template: ModelProfile, modelNames: readonly string[]) => {
    for (const modelName of modelNames) {
      const known = useLLMStore.getState().models
      if (channelHasModel(known, template, modelName)) continue
      const saved = await saveModel({
        ...template,
        id: randomUUID(),
        name: modelName,
        modelName,
        purposes: [...purposes],
      })
      if (!saved) return
    }
  }

  const isEmbeddingSection = purposes.includes('embedding')
  const openSiliconFlowInvite = () => void openModelProviderResource('siliconflow-invite', text)

  /** 保存模型（支持单模型或本渠道批量保存）；若是该分类第一个则自动设为默认 */
  const handleSave = async (modelsToSave?: ModelProfile[], deletedIds?: string[]) => {
    if (!editingModel) return
    setSaving(true)
    try {
      const targets = (modelsToSave && modelsToSave.length > 0) ? modelsToSave : [editingModel]
      let firstSavedId = editingModel.id
      for (const target of targets) {
        const ok = await saveModel(target)
        if (!ok) return
        firstSavedId = target.id
      }
      if (deletedIds && deletedIds.length > 0) {
        for (const id of deletedIds) {
          await deleteModel(id)
        }
      }

      // 新增模型后，如果该分类还没有默认且保存的模型中有非空模型，则自动设为默认
      const countBefore = filtered.length
      if (countBefore === 0 && targets.some(t => t.modelName.trim())) {
        const defaultCandidate = targets.find(t => t.modelName.trim())?.id || firstSavedId
        if (isEmbeddingSection) {
          await setDefaultEmbeddingModel(defaultCandidate)
        } else {
          await setDefaultModel(defaultCandidate)
        }
      }
      setEditingModel(null)
    } finally {
      setSaving(false)
    }
  }


  return (
    <div className="space-y-4">
      {/* 模型编辑表单 */}
      {editingModel && (
        <ModelForm
          key={editingModel.id}
          model={editingModel}
          onChange={setEditingModel}
          onSave={handleSave}
          onCancel={() => setEditingModel(null)}
          saving={saving}
          purposeOptions={purposes}
          presets={presets}
          existingModels={models}
          onAddModels={handleAddModels}
        />
      )}

      {/* 模型列表 */}
      {!editingModel && (
        <>
          {isEmbeddingSection && !editingModel && (
            <div
              className="flex items-center justify-between gap-4 rounded-xl px-4 py-3"
              style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
            >
              <div className="min-w-0">
                <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
                  {text('免费向量模型推荐', 'Free embedding model recommendation')}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                  {text('SiliconFlow 提供免费的 BAAI/bge-m3；注册后仅需填写 API Key 即可使用。', 'SiliconFlow provides the free BAAI/bge-m3 model. Register, then add your API Key to use it.')}
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={openSiliconFlowInvite} className="flex-shrink-0">
                {text('免费模型注册链接', 'Free model registration')}
                <ExternalLink size={13} />
              </Button>
            </div>
          )}

          {channelGroups.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-16 gap-3 rounded-xl"
              style={{ border: '1.5px dashed var(--color-border)' }}
            >
              <Zap size={28} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
              <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                {text(`暂无${purposeLabel}配置`, `No ${purposeLabel} configured`)}
              </span>
              <Button size="sm" variant="outline" onClick={handleAdd}>
                <Plus size={13} />
                {text(`添加第一个${purposeLabel}`, `Add first ${purposeLabel}`)}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {channelGroups.map((group) => (
                <ChannelCard
                  key={group.key}
                  group={group}
                  defaultModelId={isEmbeddingSection ? defaultEmbeddingModelId : defaultModelId}
                  onEdit={() => {
                    setEditingModel({ ...group.representative })
                  }}
                  onDelete={async () => {
                    const channelTitle = group.channelName || group.representative.name || group.label
                    const modelCount = group.models.length
                    const confirmed = window.confirm(
                      text(
                        `确定要删除渠道「${channelTitle}」吗？${modelCount > 0 ? `该渠道下的 ${modelCount} 个模型配置都将被删除。` : ''}`,
                        `Are you sure you want to delete channel "${channelTitle}"?${modelCount > 0 ? ` All ${modelCount} models will be deleted.` : ''}`,
                      ),
                    )
                    if (!confirmed) return
                    const idsToDelete = new Set(group.models.map(m => m.profile.id))
                    idsToDelete.add(group.representative.id)
                    for (const id of idsToDelete) {
                      await deleteModel(id)
                    }
                  }}
                />
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full py-2 border-dashed hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
                onClick={handleAdd}
                aria-label={text('添加', 'Add')}
              >
                <Plus size={13} />
                {text('添加', 'Add')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 渠道卡片 (按渠道聚合，对齐 DSH，简洁卡片不展开内部模型列表) */
function ChannelCard({
  group,
  defaultModelId,
  onEdit,
  onDelete,
}: {
  group: ModelChannelGroup
  defaultModelId: string | null
  onEdit: () => void
  onDelete: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const rep = group.representative
  const channelTitle = group.channelName || rep.channelName || rep.name || group.label
  const hasDefault = group.models.some(m => m.profile.id === defaultModelId)

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-xl group transition-colors border',
        hasDefault
          ? 'border-[var(--color-accent)]/50 bg-[color-mix(in_srgb,var(--color-accent)_4%,var(--color-panel))]'
          : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60 bg-[var(--color-panel)]',
      )}
    >
      {/* 头部：渠道图标 */}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-lg"
        style={{ backgroundColor: 'var(--color-hover)' }}
      >
        {providerIcon(rep.provider)}
      </div>

      {/* 渠道信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
            {channelTitle}
          </span>
          <span className="text-[0.68rem] px-1.5 py-0.5 rounded bg-[var(--color-hover)] text-[var(--color-text-muted)] flex-shrink-0 font-mono">
            {rep.protocol}
          </span>
        </div>
        <p className="text-xs truncate mt-0.5 font-mono" style={{ color: 'var(--color-text-muted)' }}>
          {rep.baseUrl}
        </p>
      </div>

      {/* 渠道操作按钮 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          title={text('编辑', 'Edit')}
          aria-label={text('编辑', 'Edit')}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--color-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
        >
          <Settings2 size={13} />
          <span>{text('编辑', 'Edit')}</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          title={text('删除', 'Delete')}
          aria-label={text('删除', 'Delete')}
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-red-500/10 text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] cursor-pointer"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ==================== 模型编辑表单与弹窗 ====================

/** 获取可用模型弹窗 (DSH 风格，模态对话框) */
function FetchModelsModal({
  open,
  onClose,
  discoveredModels,
  alreadyAddedModelNames,
  onAddModels,
}: {
  open: boolean
  onClose: () => void
  discoveredModels: DiscoveredModel[]
  alreadyAddedModelNames: string[]
  onAddModels: (modelNames: string[]) => void
}) {
  const text = useLocaleStore(s => s.text)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  if (!open) return null

  const normalized = query.trim().toLowerCase()
  const visible = normalized
    ? discoveredModels.filter(m =>
        m.id.toLowerCase().includes(normalized) ||
        m.name.toLowerCase().includes(normalized) ||
        m.value.toLowerCase().includes(normalized),
      )
    : discoveredModels

  const visibleUnadded = visible.filter(m => !alreadyAddedModelNames.includes(m.value))
  const allVisibleSelected = visibleUnadded.length > 0 && visibleUnadded.every(m => selected.includes(m.value))

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected(prev => prev.filter(val => !visibleUnadded.some(m => m.value === val)))
    } else {
      setSelected(prev => Array.from(new Set([...prev, ...visibleUnadded.map(m => m.value)])))
    }
  }

  const handleAdopt = () => {
    onAddModels(selected)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      data-channel-model-adder
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={text('获取可用模型', 'Fetch available models')}
        className="w-full max-w-lg rounded-xl shadow-2xl flex flex-col max-h-[85vh] border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              {text('获取可用模型', 'Fetch available models')}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {text('添加到本渠道：从端点发现的可用模型。勾选后点击「添加所选」即可加入本渠道。', 'Add to this channel: select discovered models to include in this channel.')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={text('关闭', 'Close')}
            className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover)] cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* 搜索与全选工具栏 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--color-border)]/60 bg-[var(--color-bg)]/30">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={text('搜索模型 ID 或名称...', 'Search model ID or name...')}
              className="pl-8 text-xs h-8"
              type="search"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={visibleUnadded.length === 0}
            onClick={toggleSelectAll}
            className="text-xs h-8 flex-shrink-0"
          >
            {allVisibleSelected ? text('取消全选', 'Deselect all') : text('全选', 'Select all')}
          </Button>
        </div>

        {/* 候选列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-2 space-y-1 min-h-[160px] max-h-[360px]">
          {visible.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
              {text('未找到匹配的模型', 'No matching models found')}
            </div>
          ) : (
            visible.map((candidate) => {
              const alreadyAdded = alreadyAddedModelNames.includes(candidate.value)
              const checked = alreadyAdded || selected.includes(candidate.value)
              const optionLabel = candidate.name === candidate.id
                ? candidate.id
                : `${candidate.name} (${candidate.id})`

              return (
                <label
                  key={candidate.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer border',
                    alreadyAdded
                      ? 'opacity-50 cursor-default bg-transparent border-transparent'
                      : checked
                        ? 'bg-[var(--color-hover)] border-[var(--color-border)]'
                        : 'hover:bg-[var(--color-hover)]/50 border-transparent',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={alreadyAdded}
                    aria-label={optionLabel}
                    onChange={() => {
                      if (alreadyAdded) return
                      setSelected(prev =>
                        prev.includes(candidate.value)
                          ? prev.filter(v => v !== candidate.value)
                          : [...prev, candidate.value]
                      )
                    }}
                    className="rounded text-[var(--color-accent)]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--color-text)] truncate">
                      {candidate.id}
                    </div>
                    {candidate.name && candidate.name !== candidate.id && (
                      <div className="text-[0.7rem] text-[var(--color-text-muted)] truncate">
                        {candidate.name}
                      </div>
                    )}
                  </div>
                  {alreadyAdded && (
                    <span className="text-[0.7rem] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded bg-[var(--color-bg)]">
                      {text('已添加', 'Added')}
                    </span>
                  )}
                </label>
              )
            })
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]/50">
          <span className="text-xs text-[var(--color-text-muted)]">
            {text(`已选择 ${selected.length} 个模型`, `${selected.length} model(s) selected`)}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {text('取消', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={selected.length === 0}
              onClick={handleAdopt}
            >
              <Plus size={13} />
              {text(`添加 ${selected.length} 个模型`, `Add ${selected.length} model(s)`)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 模型编辑表单 */
function ModelForm({
  model, onChange, onSave, onCancel, saving, presets, existingModels, onAddModels,
}: {
  model: ModelProfile
  onChange: (m: ModelProfile) => void
  onSave: (modelsToSave?: ModelProfile[], deletedIds?: string[]) => void
  onCancel: () => void
  saving: boolean
  purposeOptions: ModelProfile['purposes']
  /** 服务商预设（来自 BUILTIN_PRESETS 常量） */
  presets: ProviderPreset[]
  /** 已保存的全部档案：用来判断该渠道下哪些模型已经加过。 */
  existingModels: readonly ModelProfile[]
  /** 把发现到的模型批量加成同一渠道下的新档案。 */
  onAddModels: (template: ModelProfile, modelNames: readonly string[]) => Promise<void>
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [showKey, setShowKey] = useState(false)
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false)

  // 查找属于此渠道的所有已保存模型
  const initialChannelProfiles = useMemo(() => {
    const list: ModelProfile[] = []
    if (model.modelName && model.modelName.trim()) {
      list.push(model)
    }
    const others = existingModels.filter(m => (
      m.id !== model.id &&
      m.provider === model.provider &&
      m.protocol === model.protocol &&
      m.baseUrl.replace(/\/+$/, '').toLowerCase() === model.baseUrl.replace(/\/+$/, '').toLowerCase() &&
      m.apiKey === model.apiKey
    ))
    for (const o of others) {
      if (o.modelName && o.modelName.trim()) {
        list.push(o)
      }
    }
    return list
  }, [existingModels, model])

  const initialModelIds = useMemo(() => new Set(initialChannelProfiles.map(p => p.id)), [initialChannelProfiles])

  const isEmbedding = model.purposes?.includes('embedding')
  const embeddingOptions = normalizeEmbeddingOptions(model.embeddingOptions)
  // 将预设数组转换为以 provider 为键的 Map 方便查找
  const presetMap = new Map(presets.map((p) => [p.provider, p]))
  const preset = presetMap.get(model.provider)
  const capabilitiesForPresetModel = (modelName: string) => isEmbedding
    ? preset?.embeddingModelCapabilities?.[modelName]
    : preset?.models.find((candidate) => candidate.name === modelName)?.capabilities

  const initialChannelName = useMemo(() => {
    return model.channelName?.trim()
      || initialChannelProfiles.find(p => p.channelName?.trim())?.channelName?.trim()
      || (model.name && model.name.trim() !== model.modelName.trim() ? model.name.trim() : '')
  }, [initialChannelProfiles, model])

  const [channelName, setChannelName] = useState(initialChannelName)

  const [channelModels, setChannelModels] = useState<Array<{
    id: string
    modelName: string
    name: string
    temperature?: number
    contextWindowTokens?: number | null
    maxOutputTokens?: number
  }>>(() => {
    if (initialChannelProfiles.length > 0) {
      return initialChannelProfiles.map(p => {
        const presetCaps = capabilitiesForPresetModel(p.modelName)
        const isChannelTitle = p.name && (
          p.name.trim() === (p.channelName?.trim() || '') ||
          p.name.trim() === initialChannelName ||
          p.name.trim() === (model.channelName?.trim() || '')
        )
        const customAlias = p.name && p.name.trim() !== p.modelName.trim() && !isChannelTitle ? p.name.trim() : ''

        return {
          id: p.id,
          modelName: p.modelName || '',
          name: customAlias,
          temperature: typeof p.temperature === 'number' ? p.temperature : 0.7,
          contextWindowTokens: p.capabilities?.contextWindowTokens ?? presetCaps?.contextWindowTokens ?? null,
          maxOutputTokens: p.capabilities?.maxOutputTokens ?? p.maxTokens ?? presetCaps?.maxOutputTokens ?? 4096,
        }
      })
    }
    if (model.modelName && model.modelName.trim()) {
      const presetCaps = capabilitiesForPresetModel(model.modelName)
      const isChannelTitle = model.name && (
        model.name.trim() === (model.channelName?.trim() || '') ||
        model.name.trim() === initialChannelName
      )
      const customAlias = model.name && model.name.trim() !== model.modelName.trim() && !isChannelTitle ? model.name.trim() : ''

      return [{
        id: model.id,
        modelName: model.modelName.trim(),
        name: customAlias,
        temperature: typeof model.temperature === 'number' ? model.temperature : 0.7,
        contextWindowTokens: model.capabilities?.contextWindowTokens ?? presetCaps?.contextWindowTokens ?? null,
        maxOutputTokens: model.capabilities?.maxOutputTokens ?? model.maxTokens ?? presetCaps?.maxOutputTokens ?? 4096,
      }]
    }
    return []
  })

  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean, error?: string } | null>(null)
  const [modelTestStatuses, setModelTestStatuses] = useState<Record<string, { status: 'idle' | 'testing' | 'success' | 'error'; error?: string }>>({})
  const testConnection = useLLMStore(s => s.testConnection)
  const discoverModels = useLLMStore(s => s.discoverModels)
  const [discovering, setDiscovering] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const [discoveryNotice, setDiscoveryNotice] = useState<ModelDiscoveryErrorCode | null>(null)
  const discoveryRevision = useRef(0)
  const currentDiscoveryConfig = useRef({
    id: model.id,
    provider: model.provider,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
  })

  useLayoutEffect(() => {
    currentDiscoveryConfig.current = {
      id: model.id,
      provider: model.provider,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
    }
  }, [model.apiKey, model.baseUrl, model.id, model.protocol, model.provider])

  useEffect(() => () => {
    discoveryRevision.current += 1
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showDiscoveryModal) {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, showDiscoveryModal])

  const invalidateDiscovery = () => {
    discoveryRevision.current += 1
    setDiscovering(false)
    setDiscoveredModels([])
    setDiscoveryNotice(null)
    setShowDiscoveryModal(false)
  }

  /** 更新单个字段 */
  const up = <K extends keyof ModelProfile>(key: K, val: ModelProfile[K]) => {
    if (key === 'provider' || key === 'protocol' || key === 'baseUrl' || key === 'apiKey') {
      invalidateDiscovery()
    }
    onChange({ ...model, [key]: val })
  }

  /**
   * 切换服务商：从持久化预设中自动填充 baseUrl / protocol
   * 并将模型名重置为该服务商的第一个预设模型
   */
  const handleProviderChange = (provider: ModelProfile['provider']) => {
    const p = presetMap.get(provider)
    const firstModel = isEmbedding ? null : (p?.models[0] ?? null)
    const defaultModelName = isEmbedding
      ? (p?.embeddingModels[0] ?? '')
      : (firstModel?.name ?? '')
    const capabilities = isEmbedding
      ? p?.embeddingModelCapabilities?.[defaultModelName]
      : firstModel?.capabilities
    invalidateDiscovery()
    onChange({
      ...model,
      provider,
      protocol: (p?.protocol ?? 'openai') as 'openai' | 'gemini',
      baseUrl: p?.baseUrl ?? '',
      modelName: defaultModelName,
      maxTokens: capabilities?.maxOutputTokens ?? firstModel?.maxTokens ?? 4096,
      capabilities: capabilities ? { ...capabilities } : undefined,
    })
  }

  const handleTestSingleModel = async (targetId: string) => {
    const target = channelModels.find(m => m.id === targetId)
    if (!target || !target.modelName.trim()) {
      setModelTestStatuses(prev => ({
        ...prev,
        [targetId]: { status: 'error', error: text('模型 ID 不能为空', 'Model ID cannot be empty') },
      }))
      return false
    }

    setModelTestStatuses(prev => ({
      ...prev,
      [targetId]: { status: 'testing' },
    }))

    try {
      const result = await testConnection({
        ...model,
        modelName: target.modelName.trim(),
        name: target.name.trim() || target.modelName.trim(),
        temperature: target.temperature ?? 0.7,
        maxTokens: target.maxOutputTokens ?? 4096,
        capabilities: {
          reasoning: model.capabilities?.reasoning ?? false,
          structuredOutput: model.capabilities?.structuredOutput ?? false,
          usage: model.capabilities?.usage ?? false,
          ...(model.capabilities?.toolCalling !== undefined ? { toolCalling: model.capabilities.toolCalling } : {}),
          ...(model.capabilities?.reasoningAdapter ? { reasoningAdapter: model.capabilities.reasoningAdapter } : {}),
          contextWindowTokens: target.contextWindowTokens ?? null,
          maxOutputTokens: target.maxOutputTokens ?? 4096,
        },
      })
      setModelTestStatuses(prev => ({
        ...prev,
        [targetId]: {
          status: result.success ? 'success' : 'error',
          error: result.error,
        },
      }))
      return result.success
    } catch (err) {
      setModelTestStatuses(prev => ({
        ...prev,
        [targetId]: {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      }))
      return false
    }
  }

  const handleTestAllModels = async () => {
    const validModels = channelModels.filter(m => m.modelName.trim() !== '')
    if (validModels.length === 0) {
      toast.warning(text('请先输入至少一个模型 ID', 'Please enter at least one model ID'))
      return
    }

    setTesting(true)
    setTestResult(null)

    const results = await Promise.all(
      channelModels.map(m => handleTestSingleModel(m.id))
    )

    const passedCount = results.filter(Boolean).length
    const totalCount = channelModels.length
    setTesting(false)

    if (passedCount === totalCount) {
      setTestResult({ success: true })
      toast.success(text(`全部 ${passedCount} 个模型测试通过！`, `All ${passedCount} models connected successfully!`))
    } else if (passedCount > 0) {
      setTestResult({ success: false, error: `${passedCount}/${totalCount} 可用` })
      toast.warning(text(`部分通过：${passedCount}/${totalCount} 个模型连通可用，${totalCount - passedCount} 个失败`, `Partial: ${passedCount}/${totalCount} models available, ${totalCount - passedCount} failed`))
    } else {
      setTestResult({ success: false, error: text('所有模型均测试失败', 'All models failed') })
      toast.error(text('所有模型均连接失败，请检查 API Key、Base URL 或网络代理', 'All models failed. Check your API Key, Base URL, or network'))
    }
    setTimeout(() => setTestResult(null), 4000)
  }

  const handleDiscoverModels = async () => {
    const requestRevision = discoveryRevision.current + 1
    discoveryRevision.current = requestRevision
    const requestConfig = { ...currentDiscoveryConfig.current }
    const isCurrentRequest = () => {
      const current = currentDiscoveryConfig.current
      return discoveryRevision.current === requestRevision
        && current.id === requestConfig.id
        && current.provider === requestConfig.provider
        && current.protocol === requestConfig.protocol
        && current.baseUrl === requestConfig.baseUrl
        && current.apiKey === requestConfig.apiKey
    }
    setDiscovering(true)
    setDiscoveredModels([])
    setDiscoveryNotice(null)
    try {
      const result = await discoverModels({
        provider: model.provider,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
      })
      if (!isCurrentRequest()) return
      if (result.success) {
        setDiscoveredModels(result.models)
        setShowDiscoveryModal(true)
      } else {
        setDiscoveryNotice(result.errorCode)
      }
    } catch {
      if (isCurrentRequest()) setDiscoveryNotice('network')
    } finally {
      if (isCurrentRequest()) setDiscovering(false)
    }
  }

  const discoveryNoticeText = discoveryNotice === 'auth'
      ? text('鉴权失败：请检查 API Key。手工模型 ID 仍可使用。', 'Authentication failed. Check the API key. Manual model IDs remain available.')
      : discoveryNotice === 'unsupported'
        ? text('该端点不支持标准模型列表接口。请继续手工填写模型 ID。', 'This endpoint does not support the standard model-list API. Continue with a manual model ID.')
        : discoveryNotice === 'network'
          ? text('网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。', 'The network request failed. Check the endpoint or network and retry. Manual model IDs remain available.')
          : discoveryNotice === 'invalid_response'
            ? text('端点返回了无法识别的模型列表。请继续手工填写模型 ID。', 'The endpoint returned an invalid model list. Continue with a manual model ID.')
            : discoveryNotice === 'empty'
              ? text('端点返回了空模型列表。请继续手工填写模型 ID。', 'The endpoint returned an empty model list. Continue with a manual model ID.')
              : null

  return (
    <div
      className="rounded-xl p-5 space-y-4"
      style={{ border: '1.5px solid var(--color-accent)', backgroundColor: 'var(--color-panel)' }}
    >
      {/* 顶部返回与导航栏 */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer py-1 px-2 rounded-md hover:bg-[var(--color-hover)]"
        >
          <ArrowLeft size={14} />
          <span>{text('返回列表', 'Back to list')}</span>
        </button>
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          {channelName ? text(`编辑渠道：${channelName}`, `Edit channel: ${channelName}`) : text('新建渠道配置', 'New channel configuration')}
        </span>
        <button
          type="button"
          onClick={onCancel}
          title={text('取消并返回', 'Cancel and return')}
          aria-label={text('返回', 'Back')}
          className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover)] transition-colors cursor-pointer"
        >
          <X size={15} />
        </button>
      </div>

      {generationModelLacksToolCalling(model) && (
        <div className="text-xs rounded-lg px-3 py-2 bg-[var(--color-error)]/10 text-[var(--color-error-text)]">
          {toolCallingRequiredMessage(locale === 'en-US' ? 'en-US' : 'zh-CN')}
        </div>
      )}

      {/* 渠道名称 */}
      <div>
        <Label>{text('渠道名称', 'Channel name')}</Label>
        <Input
          value={channelName}
          onChange={(e) => {
            const val = e.target.value
            setChannelName(val)
            up('channelName', val)
          }}
          placeholder={text('如：hajimi / 自定义中转', 'e.g. hajimi / Custom gateway')}
        />
      </div>

      {/* 服务商 + 协议 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{text('服务商', 'Provider')}</Label>
          <NativeSelect
            value={model.provider}
            onChange={(e) => handleProviderChange(e.target.value as ModelProfile['provider'])}
          >
            {presets.length > 0 ? (
              presets.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.displayName || p.provider}
                </option>
              ))
            ) : (
              <>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="gemini">Google Gemini</option>
                <option value="xai">xAI</option>
                <option value="siliconflow">SiliconFlow</option>
                <option value="ollama">Ollama</option>
                <option value="bigmodel">BigModel</option>
              </>
            )}
            {!presets.some((p) => p.provider === 'custom') && (
              <option value="custom">{text('自定义', 'Custom')}</option>
            )}
          </NativeSelect>
        </div>
        <div>
          <Label>{text('调用协议', 'Protocol')}</Label>
          <NativeSelect
            value={model.protocol}
            onChange={(e) => up('protocol', e.target.value as 'openai' | 'gemini')}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="anthropic">Anthropic</option>
          </NativeSelect>
        </div>
      </div>

      {/* Base URL */}
      <div>
        <Label>{text('base_url', 'base_url')}</Label>
        <Input
          value={model.baseUrl}
          onChange={(e) => up('baseUrl', e.target.value)}
          placeholder="https://api.openai.com"
        />
        {model.provider !== 'custom' && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {text(`已自动填入 ${model.provider} 官方地址，如使用中转地址可手动修改`, `The official ${model.provider} URL was filled automatically. Edit it when using a gateway.`)}
          </p>
        )}
      </div>

      {/* API Key */}
      <div>
        <Label>{text('API Key', 'API Key')}</Label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={model.apiKey}
            onChange={(e) => up('apiKey', e.target.value)}
            placeholder={model.provider === 'ollama' ? text('本地部署可留空', 'Optional for local deployment') : 'sk-...'}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {isEmbedding && model.provider === 'siliconflow' && (
        <div className="rounded-lg p-3 space-y-2" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            {text('BAAI/bge-m3 当前在 SiliconFlow 提供免费调用。完成实名认证后可使用，仍受固定速率限制约束。', 'BAAI/bge-m3 is currently free on SiliconFlow. Verification is required; fixed rate limits still apply.')}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-invite', text)} className="text-[var(--color-accent)] hover:underline cursor-pointer">
              {text('邀请注册链接', 'Invitation registration link')}
            </button>
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-console', text)} className="text-[var(--color-accent)] hover:underline cursor-pointer">
              {text('官方控制台', 'Official console')}
            </button>
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-docs', text)} className="text-[var(--color-accent)] hover:underline cursor-pointer">
              {text('官方文档', 'Official documentation')}
            </button>
          </div>
        </div>
      )}

      {/* 模型列表 (支持 0 到 N 个模型，全部模型平权均可删除) */}
      <div className="space-y-3 rounded-lg p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
        <div className="flex items-center justify-between gap-3">
          <Label className="mb-0">
            {text('模型列表', 'Models')}
          </Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTestAllModels}
              disabled={testing || channelModels.length === 0}
            >
              <Zap size={13} className={testing ? 'animate-pulse text-[var(--color-accent)]' : undefined} />
              {testing ? text('测试中...', 'Testing...') : text('测试连接', 'Test connection')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDiscoverModels}
              disabled={discovering}
            >
              <RefreshCw size={13} className={discovering ? 'animate-spin' : undefined} />
              {discovering ? text('获取中...', 'Refreshing...') : text('获取模型列表', 'Refresh model list')}
            </Button>
          </div>
        </div>

        {/* 端点模型下拉快捷选择（满足已有端点模型列表选择契约） */}
        {discoveredModels.length > 0 && (
          <NativeSelect
            aria-label={text('端点模型列表', 'Endpoint model list')}
            value=""
            onChange={(event) => {
              const value = event.target.value
              if (!value) return
              const presetCaps = capabilitiesForPresetModel(value)
              setChannelModels(prev => {
                if (prev.length <= 1) {
                  const targetId = prev[0]?.id || model.id
                  return [{
                    id: targetId,
                    modelName: value,
                    name: prev[0]?.name || '',
                    temperature: prev[0]?.temperature ?? model.temperature ?? 0.7,
                    contextWindowTokens: prev[0]?.contextWindowTokens ?? model.capabilities?.contextWindowTokens ?? presetCaps?.contextWindowTokens ?? null,
                    maxOutputTokens: prev[0]?.maxOutputTokens ?? model.capabilities?.maxOutputTokens ?? model.maxTokens ?? presetCaps?.maxOutputTokens ?? 4096,
                  }]
                }
                const emptyIdx = prev.findIndex(m => !m.modelName.trim())
                if (emptyIdx >= 0) {
                  return prev.map((m, i) => i === emptyIdx ? {
                    ...m,
                    modelName: value,
                    contextWindowTokens: m.contextWindowTokens ?? presetCaps?.contextWindowTokens ?? null,
                    maxOutputTokens: m.maxOutputTokens ?? presetCaps?.maxOutputTokens ?? 4096,
                  } : m)
                }
                if (prev.some(m => m.modelName === value)) return prev
                return [...prev, {
                  id: randomUUID(),
                  modelName: value,
                  name: '',
                  temperature: 0.7,
                  contextWindowTokens: presetCaps?.contextWindowTokens ?? null,
                  maxOutputTokens: presetCaps?.maxOutputTokens ?? 4096,
                }]
              })
            }}
          >
            <option value="">{text('选择端点返回的模型（快捷填入）', 'Choose a model returned by the endpoint')}</option>
            {discoveredModels.map(candidate => (
              <option key={`${candidate.id}:${candidate.value}`} value={candidate.value}>
                {candidate.name === candidate.id ? candidate.id : `${candidate.name} (${candidate.id})`}
              </option>
            ))}
          </NativeSelect>
        )}

        {/* 获取端点模型弹窗 (DSH 风格) */}
        <FetchModelsModal
          open={showDiscoveryModal}
          onClose={() => setShowDiscoveryModal(false)}
          discoveredModels={discoveredModels}
          alreadyAddedModelNames={channelModels.map(m => m.modelName).filter(Boolean)}
          onAddModels={(modelNames) => {
            const toAdd = modelNames.filter(name => !channelModels.some(m => m.modelName === name))
            setChannelModels(prev => [
              ...prev,
              ...toAdd.map(name => ({ id: randomUUID(), modelName: name, name }))
            ])
            void onAddModels(model, modelNames)
          }}
        />

        {discoveryNoticeText && (
          <p role="status" className="text-xs" style={{ color: 'var(--color-error-text)' }}>
            {discoveryNoticeText}
          </p>
        )}

        {/* 模型行列表：所有模型平权，均可删除，且均可独立设置参数 */}
        {channelModels.length === 0 ? (
          <div className="text-xs py-4 px-3 text-center rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] bg-[var(--color-bg)]">
            {text('该渠道下暂无模型。点击下方「+ 添加模型」或右侧「获取模型列表」添加。', 'No models in this channel. Click "+ Add model" or fetch from endpoint.')}
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {channelModels.map((item, index) => (
              <div key={item.id} className="rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] p-2 transition-all">
                <div className="flex items-center gap-2">
                  <Input
                    value={item.modelName}
                    placeholder={text('模型 ID (如 gemini-3.8-flash-high)', 'Model ID (e.g. gemini-3.8-flash-high)')}
                    className="flex-1 text-xs"
                    onChange={(e) => {
                      const val = e.target.value
                      const presetCaps = capabilitiesForPresetModel(val)
                      setChannelModels(prev => prev.map((m, i) => i === index ? {
                        ...m,
                        modelName: val,
                        ...(presetCaps?.contextWindowTokens ? { contextWindowTokens: presetCaps.contextWindowTokens } : {}),
                        ...(presetCaps?.maxOutputTokens ? { maxOutputTokens: presetCaps.maxOutputTokens } : {}),
                      } : m))
                      setModelTestStatuses(prev => ({ ...prev, [item.id]: { status: 'idle' } }))
                    }}
                  />
                  <Input
                    value={item.name}
                    placeholder={text('模型别名 (可选，留空同模型 ID)', 'Model alias (optional, defaults to model ID)')}
                    className="flex-1 text-xs"
                    onChange={(e) => {
                      const val = e.target.value
                      setChannelModels(prev => prev.map((m, i) => i === index ? { ...m, name: val } : m))
                    }}
                  />

                  {/* 独立模型高级参数设置切换按钮 */}
                  <button
                    type="button"
                    title={text('高级参数设置（上下文窗口、温度、最大 Token）', 'Advanced settings (Context window, temperature, max tokens)')}
                    aria-label={text('高级设置', 'Advanced settings')}
                    aria-expanded={expandedModelId === item.id}
                    onClick={() => setExpandedModelId(cur => cur === item.id ? null : item.id)}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 rounded transition-colors cursor-pointer text-xs border border-[var(--color-border)]',
                      expandedModelId === item.id
                        ? 'bg-[var(--color-hover)] text-[var(--color-accent)] font-medium border-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover)]'
                    )}
                  >
                    <Settings2 size={13} style={expandedModelId === item.id ? { color: 'var(--color-accent)' } : undefined} />
                    <span className="text-[0.72rem] hidden sm:inline">{text('高级设置', 'Advanced settings')}</span>
                    <ChevronDown size={12} className={cn('transition-transform', expandedModelId === item.id && 'rotate-180')} />
                  </button>

                  {/* 状态圆点 */}
                  {(() => {
                    const testInfo = modelTestStatuses[item.id] || { status: 'idle' }
                    let dotClass = 'bg-neutral-300 dark:bg-neutral-600'
                    let statusText = text('未测试连通性（点击可单独测试）', 'Not tested (click to test)')

                    if (testInfo.status === 'testing') {
                      dotClass = 'bg-amber-400 animate-pulse ring-2 ring-amber-400/30'
                      statusText = text('正在测试连接...', 'Testing...')
                    } else if (testInfo.status === 'success') {
                      dotClass = 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]'
                      statusText = text('测试通过：连接正常可用', 'Passed: Available')
                    } else if (testInfo.status === 'error') {
                      dotClass = 'bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]'
                      statusText = text(`测试未通过：${testInfo.error || '无法连接'}`, `Failed: ${testInfo.error || 'Cannot connect'}`)
                    }

                    return (
                      <button
                        type="button"
                        className="flex items-center justify-center p-1.5 rounded hover:bg-[var(--color-hover)] transition-colors cursor-pointer"
                        title={statusText}
                        aria-label={statusText}
                        disabled={testInfo.status === 'testing'}
                        onClick={() => void handleTestSingleModel(item.id)}
                      >
                        <span
                          className={cn('w-2.5 h-2.5 rounded-full transition-all flex-shrink-0', dotClass)}
                          data-test-status={testInfo.status}
                        />
                      </button>
                    )
                  })()}

                  {/* 删除按钮 */}
                  <button
                    type="button"
                    title={text('删除模型', 'Remove model')}
                    aria-label={`${text('删除模型', 'Remove model')} ${index + 1}`}
                    onClick={() => {
                      setChannelModels(prev => prev.filter((_, i) => i !== index))
                      setModelTestStatuses(prev => {
                        const next = { ...prev }
                        delete next[item.id]
                        return next
                      })
                      if (expandedModelId === item.id) setExpandedModelId(null)
                    }}
                    className="p-1.5 rounded hover:bg-[var(--color-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-error-text)] transition-colors cursor-pointer"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                {/* 展开的单模型参数设置 */}
                {expandedModelId === item.id && (
                  <div className="mt-2.5 pt-2.5 border-t border-[var(--color-border)] space-y-2.5" data-model-advanced-settings>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <Label className="text-[0.72rem] mb-1">{text('上下文窗口', 'Context Window')}</Label>
                        <Input
                          aria-label={text('上下文窗口', 'Context Window')}
                          type="number"
                          min={0}
                          value={item.contextWindowTokens ?? ''}
                          placeholder={text('可选 (Tokens)', 'Optional (Tokens)')}
                          className="text-xs h-7"
                          onChange={(e) => {
                            const val = e.target.value === '' ? null : parseInt(e.target.value) || null
                            setChannelModels(prev => prev.map((m, i) => i === index ? { ...m, contextWindowTokens: val } : m))
                          }}
                        />
                      </div>
                      <div>
                        <Label className="text-[0.72rem] mb-1">{text('温度', 'Temperature')}</Label>
                        <Input
                          aria-label={text('温度', 'Temperature')}
                          type="number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={item.temperature ?? 0.7}
                          className="text-xs h-7"
                          onChange={(e) => {
                            const val = e.target.value === '' ? 0.7 : parseFloat(e.target.value)
                            setChannelModels(prev => prev.map((m, i) => i === index ? { ...m, temperature: val } : m))
                          }}
                          onBlur={() => {
                            const val = Number(item.temperature)
                            if (Number.isNaN(val)) {
                              setChannelModels(prev => prev.map((m, i) => i === index ? { ...m, temperature: 0.7 } : m))
                            }
                          }}
                        />
                      </div>
                      <div>
                        <Label className="text-[0.72rem] mb-1">{text('最大输出 Token', 'Max output tokens')}</Label>
                        <Input
                          aria-label={text('最大输出 Token', 'Max output tokens')}
                          type="number"
                          min={0}
                          value={item.maxOutputTokens ?? 4096}
                          className="text-xs h-7"
                          onChange={(e) => {
                            const val = e.target.value === '' ? 4096 : parseInt(e.target.value) || 4096
                            setChannelModels(prev => prev.map((m, i) => i === index ? { ...m, maxOutputTokens: val } : m))
                          }}
                        />
                      </div>
                    </div>

                    {item.contextWindowTokens && item.maxOutputTokens && item.maxOutputTokens >= item.contextWindowTokens && (
                      <p
                        role="status"
                        className="rounded border px-2 py-1 text-[0.7rem] leading-normal"
                        style={{
                          borderColor: 'var(--color-warning)',
                          backgroundColor: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
                          color: 'var(--color-warning-text)',
                        }}
                      >
                        {text(
                          '最大输出接近或超过上下文窗口，建议预留足够的上下文空间给提示词与历史记录。',
                          'Max output approaches or exceeds the context window. Reserving ample room for prompts is recommended.',
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* + 添加模型按钮 */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full mt-2"
          onClick={() => {
            setChannelModels(prev => [...prev, {
              id: randomUUID(),
              modelName: '',
              name: '',
              temperature: 0.7,
              contextWindowTokens: null,
              maxOutputTokens: 4096,
            }])
          }}
        >
          <Plus size={13} />
          {text('添加模型', 'Add model')}
        </Button>
      </div>

      {isEmbedding && (
        <div className="space-y-3 rounded-lg p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="mb-0">{text('向量化高级参数', 'Embedding advanced settings')}</Label>
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {text('按当前向量模型保存。降低批量数可减少本地显存占用；不会影响生成模型。', 'Saved with this embedding model. Lower batches reduce local VRAM use and do not affect generation models.')}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => up('embeddingOptions', LOW_VRAM_EMBEDDING_OPTIONS)}>
              {text('应用低显存推荐', 'Use low-VRAM preset')}
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>{text('分块字符数', 'Chunk characters')}</Label>
              <Input type="number" min={100} max={4000} value={embeddingOptions.chunkSize}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, chunkSize: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>{text('重叠字符数', 'Overlap characters')}</Label>
              <Input type="number" min={0} max={embeddingOptions.chunkSize - 1} value={embeddingOptions.chunkOverlap}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, chunkOverlap: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>{text('请求批量', 'Request batch')}</Label>
              <Input type="number" min={1} max={50} value={embeddingOptions.batchSize}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, batchSize: Number(e.target.value) }))} />
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          className="flex-1"
          onClick={() => {
            const validModels = channelModels.filter(m => m.modelName.trim() !== '')
            const isMultiModelChannel = validModels.length > 1 || Boolean(model.channelName)
            const finalChannelName = isMultiModelChannel ? (channelName.trim() || undefined) : (model.channelName ? (channelName.trim() || undefined) : undefined)

            // 计算被用户删除的原有模型 ID
            const currentIds = new Set(validModels.map(m => m.id))
            const deletedIds = Array.from(initialModelIds).filter(id => !currentIds.has(id))

            if (validModels.length === 0) {
              // 渠道下模型数为 0：保存一个空模型渠道占位配置
              const emptyChannelProfile: ModelProfile = {
                ...model,
                id: model.id,
                name: finalChannelName || model.name || '',
                channelName: finalChannelName,
                modelName: '',
              }
              const filteredDeletedIds = deletedIds.filter(id => id !== model.id)
              onSave([emptyChannelProfile], filteredDeletedIds)
              return
            }

            // 保存所有有效模型（各自保存独立的温度、上下文窗口与最大输出 Token）
            const profilesToSave: ModelProfile[] = validModels.map((row) => {
              const maxOutputTokens = row.maxOutputTokens ?? model.maxTokens ?? 4096
              const presetCaps = capabilitiesForPresetModel(row.modelName)
              const hasCapabilities = Boolean(model.capabilities || presetCaps || (row.contextWindowTokens !== null && row.contextWindowTokens !== undefined))
              const capabilities: ModelCapabilities | undefined = hasCapabilities ? {
                reasoning: presetCaps?.reasoning ?? model.capabilities?.reasoning ?? false,
                structuredOutput: presetCaps?.structuredOutput ?? model.capabilities?.structuredOutput ?? false,
                usage: presetCaps?.usage ?? model.capabilities?.usage ?? false,
                ...(presetCaps?.toolCalling !== undefined ? { toolCalling: presetCaps.toolCalling } : (model.capabilities?.toolCalling !== undefined ? { toolCalling: model.capabilities.toolCalling } : {})),
                ...(presetCaps?.reasoningAdapter ? { reasoningAdapter: presetCaps.reasoningAdapter } : (model.capabilities?.reasoningAdapter ? { reasoningAdapter: model.capabilities.reasoningAdapter } : {})),
                contextWindowTokens: row.contextWindowTokens !== undefined ? row.contextWindowTokens : (model.capabilities?.contextWindowTokens ?? null),
                maxOutputTokens,
              } : undefined

              let modelDisplayName: string
              if (row.name.trim() !== '') {
                modelDisplayName = row.name.trim()
              } else if (isMultiModelChannel) {
                modelDisplayName = row.modelName.trim()
              } else {
                modelDisplayName = model.name !== undefined ? model.name : row.modelName.trim()
              }

              return {
                ...model,
                id: row.id,
                ...(finalChannelName ? { channelName: finalChannelName } : {}),
                modelName: row.modelName.trim(),
                name: modelDisplayName,
                temperature: typeof row.temperature === 'number' ? row.temperature : (model.temperature ?? 0.7),
                maxTokens: maxOutputTokens,
                ...(capabilities ? { capabilities } : {}),
              }
            })

            onSave(profilesToSave, deletedIds)
          }}
          disabled={saving || !model.baseUrl.trim() || (!model.apiKey.trim() && model.provider !== 'ollama')}
        >
          <Save size={13} />
          {saving ? text('保存中...', 'Saving...') : text('保存配置', 'Save configuration')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{text('取消', 'Cancel')}</Button>
      </div>
      {testResult && (
        <div className={`text-xs p-2 rounded ${testResult.success ? 'bg-green-500/10 text-[var(--color-success-text)] border border-green-500/20' : 'bg-red-500/10 text-[var(--color-error-text)] border border-red-500/20'} break-all`}>
          {testResult.success ? text('连接成功', 'Connection succeeded') : text(`连接失败：${testResult.error}`, `Connection failed: ${testResult.error}`)}
        </div>
      )}
    </div>
  )
}


// ==================== 代理设置 ====================

function ProxySection() {
  const text = useLocaleStore(s => s.text)
  const [proxy, setProxy] = useState<{
    enabled: boolean; type: 'http' | 'socks5'; host: string; port: number
  }>({ enabled: false, type: 'http', host: '', port: 7890 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((cfg) => {
      if (cfg?.proxy) {
        setProxy({
          enabled: cfg.proxy.enabled ?? false, // 明确默认关闭
          type: cfg.proxy.type ?? 'http',
          host: cfg.proxy.host ?? '',
          port: cfg.proxy.port ?? 7890,
        })
      }
    }).catch((error) => {
      logFailure('Settings', 'failed to load proxy config', error)
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await ipc.invoke('config:set', { proxy })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setSaved(false)
      setSaveError(text(
        `代理配置保存失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not save proxy settings: ${error instanceof Error ? error.message : String(error)}`,
      ))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[480px] space-y-5">
      {/* 启用开关 */}
      <div
        className="flex items-center justify-between p-4 rounded-xl"
        style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
      >
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('启用代理', 'Enable proxy')}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {text('所有 AI API 请求将通过代理发送', 'All AI API requests will be sent through the proxy.')}
          </p>
        </div>
        <Switch
          checked={proxy.enabled}
          onCheckedChange={(checked) => setProxy({ ...proxy, enabled: checked })}
          aria-label={text('启用代理', 'Enable proxy')}
        />
      </div>

      {/* 代理详情 */}
      {proxy.enabled && (
        <div
          className="space-y-3 p-4 rounded-xl"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
        >
          <div>
            <Label>{text('代理类型', 'Proxy type')}</Label>
            <NativeSelect
              value={proxy.type}
              onChange={(e) => setProxy({ ...proxy, type: e.target.value as 'http' | 'socks5' })}
            >
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </NativeSelect>
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <Label>{text('主机地址', 'Host')}</Label>
              <Input
                value={proxy.host}
                onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </div>
            <div>
              <Label>{text('端口', 'Port')}</Label>
              <Input
                type="number"
                value={proxy.port}
                onChange={(e) => setProxy({ ...proxy, port: (e.target.value === '' ? '' : parseInt(e.target.value)) as number })}
                onBlur={() => {
                  const v = Number(proxy.port);
                  if (!v) setProxy({ ...proxy, port: 7890 })
                }}
              />
            </div>
          </div>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving}>
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? text('已保存', 'Saved') : saving ? text('保存中...', 'Saving...') : text('保存代理配置', 'Save proxy settings')}
      </Button>
      {saveError && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{saveError}</p>}
    </div>
  )
}

// ==================== 编辑器设置 ====================

/** 字体下拉菜单（界面字体 + 写作字体共用） */
function FontSelect({
  value,
  onChange,
}: {
  value: FontId
  onChange: (id: FontId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { locale, text } = useLocaleStore()
  const current = FONT_OPTIONS.find((o) => o.id === value) ?? FONT_OPTIONS[0]

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      {/* 触发按鈕 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 h-9 rounded-lg transition-colors text-left"
        style={{
          border: '1px solid var(--color-border)',
          backgroundColor: open ? 'var(--color-hover)' : 'var(--color-panel)',
          color: 'var(--color-text)',
        }}
      >
        {/* 当前字体预览 */}
        <span
          className="flex-1 text-sm truncate"
          style={{ fontFamily: current.family }}
        >
          {text(current.label, current.labelEn)}
        </span>
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {text(current.preview, current.previewEn)}
        </span>
        <ChevronDown
          size={13}
          className="flex-shrink-0 transition-transform"
          style={{
            color: 'var(--color-text-muted)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {/* 下拉选项列表 */}
      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-xl overflow-hidden"
          style={{
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-panel)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => { onChange(opt.id); setOpen(false) }}
              className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors hover:bg-[var(--color-hover)]"
              style={{
                backgroundColor: value === opt.id
                  ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
                  : 'transparent',
              }}
            >
              {/* 选中标记 */}
              <span
                className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center"
                style={{
                  backgroundColor: value === opt.id ? 'var(--color-accent)' : 'transparent',
                  border: value === opt.id ? 'none' : '1.5px solid var(--color-border)',
                }}
              >
                {value === opt.id && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </span>

              {/* 字体名 + 描述 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium" style={{ color: 'var(--color-text)', fontFamily: opt.family }}>
                    {text(opt.label, opt.labelEn)}
                  </span>
                  {locale === 'zh-CN' && (
                    <span className="text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
                      {opt.labelEn}
                    </span>
                  )}
                </div>
                <p className="text-[0.65rem] truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {text(opt.desc, opt.descEn)}
                </p>
              </div>

              {/* 预览文字 */}
              <span
                className="text-sm flex-shrink-0"
                style={{ fontFamily: opt.family, color: 'var(--color-text-secondary)' }}
              >
                {text(opt.preview, opt.previewEn)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EditorSection() {
  const { writingFont, setWritingFont, uiFont, setUiFont } = useThemeStore()
  const { locale, setLocale, t, text } = useLocaleStore()
  const [autoOpenNextChapterAfterFinalize, setAutoOpenNextChapterAfterFinalize] = useState(false)
  const [autoOpenNextSaving, setAutoOpenNextSaving] = useState(false)
  const [autoOpenNextError, setAutoOpenNextError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((config) => {
      setAutoOpenNextChapterAfterFinalize(config.autoOpenNextChapterAfterFinalize === true)
    }).catch((error) => {
      logFailure('Settings', 'failed to load editor auto-open-next-chapter config', error)
    })
  }, [])

  const setAutoOpenNext = async (checked: boolean) => {
    const previous = autoOpenNextChapterAfterFinalize
    setAutoOpenNextChapterAfterFinalize(checked)
    setAutoOpenNextSaving(true)
    setAutoOpenNextError(null)
    try {
      const result = await ipc.invoke('config:set', { autoOpenNextChapterAfterFinalize: checked })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
    } catch (error) {
      setAutoOpenNextChapterAfterFinalize(previous)
      setAutoOpenNextError(text(
        `自动打开下一章设置保存失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not save the open-next-chapter setting: ${error instanceof Error ? error.message : String(error)}`,
      ))
    } finally {
      setAutoOpenNextSaving(false)
    }
  }

  return (
    <div className="max-w-md space-y-5">
      <div className="space-y-1.5">
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
            {t('language.settingLabel')}
          </p>
          <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {t('language.settingDescription')}
          </p>
        </div>
        <NativeSelect
          value={locale}
          onChange={(event) => void setLocale(event.target.value as Locale)}
        >
          <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
          <option value="en-US">English</option>
        </NativeSelect>
      </div>

      {/* 界面字体 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>{text('界面字体', 'Interface font')}</p>
            <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {text('左侧栏、菜单、对话框等 UI 区域', 'Sidebars, menus, dialogs, and other interface areas')}
            </p>
          </div>
        </div>
        <FontSelect value={uiFont} onChange={setUiFont} />
      </div>

      {/* 写作字体 */}
      <div className="space-y-1.5">
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>{text('写作字体', 'Writing font')}</p>
          <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {text('草稿、终稿、架构文档等正文区域', 'Drafts, manuscripts, and architecture documents')}
          </p>
        </div>
        <FontSelect value={writingFont} onChange={setWritingFont} />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl p-4" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}>
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>{text('定稿后打开下一章', 'Open next chapter after finalizing')}</p>
          <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {text('当前章的定稿和后处理全部完成后，自动打开已有蓝图的下一章创作窗口；不会自动生成正文或覆盖已有草稿。', 'After finalization and post-processing finish, opens the next planned chapter. It never starts generation or overwrites an existing draft.')}
          </p>
        </div>
        <Switch checked={autoOpenNextChapterAfterFinalize} onCheckedChange={(checked) => void setAutoOpenNext(checked)} disabled={autoOpenNextSaving} aria-label={text('定稿后打开下一章', 'Open next chapter after finalizing')} />
      </div>
      {autoOpenNextError && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{autoOpenNextError}</p>}

      {/* 说明 */}
      <div
        className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs"
        style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-muted)' }}
      >
        <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{text('提示', 'Note')}</span>
        <span>{text('所有字体已内置在应用中，无需网络连接，切换后立即生效。', 'All fonts are bundled with the app and switch immediately without a network connection.')}</span>
      </div>
    </div>
  )
}

// ==================== 关于区 ====================

function AboutSection() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="space-y-6 max-w-[600px] p-2">
      <div
        className="flex flex-col items-center justify-center py-8 rounded-xl space-y-2.5"
        style={{ backgroundColor: 'var(--color-sidebar)', border: '1px solid var(--color-border)' }}
      >
        <h1 className="text-2xl font-bold brand-gradient tracking-wider">{text(APP_BRAND.zhName, APP_BRAND.enName)}</h1>
        <p className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {text(APP_BRAND.tagline, APP_BRAND.taglineEn)}
        </p>
        <div className="pt-1">
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-semibold"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
              color: 'var(--color-accent)',
              border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)',
            }}
          >
            <span>{text('版本号', 'Version')}</span>
            <span>v{__APP_VERSION__}</span>
          </span>
        </div>
      </div>

      <div className="space-y-3 pt-2">
        <h3
          className="text-sm font-semibold pb-2"
          style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {text('本地创作工作台', 'Local writing workspace')}
        </h3>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
          {text('这是面向中文长篇小说、角色设定、章节蓝图和本地模型生成的桌面写作环境。默认优先使用本机模型与本地项目数据，适合离线创作、风格拆解、章节规划和长文续写。', 'A desktop writing environment for long-form fiction, character design, chapter blueprints, and local model generation. It prioritizes local models and project data for offline writing, style analysis, planning, and continuation.')}
        </p>
      </div>

      <div
        className="grid grid-cols-2 gap-3 pt-2"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <div className="rounded-xl p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text)' }}>{text('核心流程', 'Core pipeline')}</div>
          <p className="text-xs leading-relaxed">{text('架构、角色、蓝图、草稿、评审、修订、定稿。', 'Architecture, characters, blueprints, drafts, reviews, revisions, and final manuscripts.')}</p>
        </div>
        <div className="rounded-xl p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text)' }}>{text('模型连接', 'Model connections')}</div>
          <p className="text-xs leading-relaxed">{text('支持 OpenAI 兼容接口、Ollama、本地与自定义供应商。', 'Supports OpenAI-compatible APIs, Ollama, local models, and custom providers.')}</p>
        </div>
      </div>
    </div>
  )
}

// ==================== 工具函数 ====================

function providerIcon(provider: string) {
  const commonProps = { size: 18, strokeWidth: 1.8 }

  switch (provider) {
    case 'openai':
      return <Zap {...commonProps} />
    case 'deepseek':
      return <Database {...commonProps} />
    case 'gemini':
      return <Globe {...commonProps} />
    case 'xai':
      return <Cpu {...commonProps} />
    case 'siliconflow':
      return <Database {...commonProps} />
    case 'ollama':
      return <Cpu {...commonProps} />
    case 'bigmodel':
      return <MessageSquare {...commonProps} />
    case 'custom':
      return <Settings2 {...commonProps} />
    default:
      return <Cpu {...commonProps} />
  }
}
