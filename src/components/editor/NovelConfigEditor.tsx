import { useEffect, useRef, useState } from 'react'
import { Save, Sparkles, Info, Loader2, RotateCcw, ChevronDown } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler } from '../../stores/editor-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import type { NovelConfig } from '../../shared/ipc-channels'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../shared/narrative-thread'
import {
  resolveWritingLanguage,
  type WritingLanguage,
} from '../../shared/writing-language'
import type { GeneratableField } from '../../services/workflows/commands/generate-field.command'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import GenerateConfigDialog from '../dialogs/GenerateConfigDialog'
import { useLocaleStore } from '../../stores/locale-store'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import { AUDIENCE_EN, GENRE_EN } from './novel-config-labels'

/** 小说配置编辑器 — Tab 内的可视化配置面板 */
export default function NovelConfigEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession && isProjectSessionPath(projectSession, projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${projectKey}`

  // 同路径项目重新打开时强制重挂载，避免旧会话的保存/生成状态泄漏到新 lease。
  return <NovelConfigEditorSession key={sessionKey} projectKey={projectKey} />
}

function NovelConfigEditorSession({ projectKey }: { projectKey: string }) {
  // ✅ 用 selector 精确订阅：只有 currentProject 变化时才重新渲染
  //    不订阅 fileTree、recentProjects 等无关字段
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const saveProject = useProjectStore(s => s.saveProject)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  // ✅ addLog 用 getState() 命令式调用，不订阅 workflow store
  //    避免 AI 流式生成时 globalLogs 高频更新导致本组件被动重渲染
  const addLog = useWorkflowStore.getState().addLog
  const [saving, setSaving] = useState(false)
  const [showGenerateConfig, setShowGenerateConfig] = useState(false)
  const text = useLocaleStore(s => s.text)
  const [generateSession, setGenerateSession] = useState<ReturnType<typeof captureProjectSession>>(null)

  // 各区块的独立生成状态
  const [generatingField, setGeneratingField] = useState<GeneratableField | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})

  // 直接从 Store 读取配置 — 单一数据源，无需 local state 镜像
  const projectMatches = currentProject?.path === projectKey
  const config = projectMatches ? currentProject.novelConfig : null
  const exitSaveRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'config',
      projectKey,
      save: () => exitSaveRef.current(),
    })
  }, [projectKey])

  // 直接写 Store — 消除双向同步风险
  const update = <K extends keyof NovelConfig>(key: K, value: NovelConfig[K]) => {
    if (!config) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    updateNovelConfig({ [key]: value }, projectSession)
  }

  /** 保存配置 — Store 已是最新数据，仅需持久化到磁盘 */
  const handleSave = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!config || saving || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setSaving(true)
    try {
      const saved = await saveProject(projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!saved) throw new Error(text('项目配置未能写入磁盘', 'The project configuration could not be written to disk.'))
      addLog('info', text('小说配置已保存', 'Novel configuration saved'))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      console.error('[NovelConfigEditor] 保存失败:', error)
      addLog('error', text(`保存失败：${error}`, `Save failed: ${error}`))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }
  useEffect(() => {
    exitSaveRef.current = handleSave
  })

  if (!config) return (
    <div className="h-full flex items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
      <span className="text-sm opacity-50">
        {projectMatches
          ? text('加载配置中...', 'Loading configuration...')
          : text('此标签属于另一个项目，请切回原项目后继续。', 'This tab belongs to another project. Switch back to continue.')}
      </span>
    </div>
  )

  /** AI 生成配置 — 打开弹框 */
  const handleAIGenerate = () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!defaultModelId) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    setGenerateSession(projectSession)
    setShowGenerateConfig(true)
  }

  /** 单字段 AI 生成 */
  const handleFieldGenerate = async (fieldKey: GeneratableField) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!defaultModelId) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    if (generatingField) return // 防止并发

    setCollapsedSections(current => ({ ...current, [fieldKey]: false }))
    setGeneratingField(fieldKey)
    try {
      const { GenerateFieldCommand } = await import('../../services/workflows/commands/generate-field.command')
      if (!isProjectSessionCurrent(projectSession)) return
      const cmd = new GenerateFieldCommand(fieldKey)
      await cmd.execute({
        step: { id: '', commandId: '', name: '', params: {} },
        context: {
          runId: 'config-field',
          projectPath: projectSession.projectPath,
          projectSession,
          writingLanguage: resolveWritingLanguage(currentProject?.novelConfig.writingLanguage),
          uiLocale: useLocaleStore.getState().locale,
          data: {},
          cancelled: false,
        },
        callbacks: {
          log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
          setProgress: () => { },
          appendText: () => { },
        },
      })
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      addLog('error', text(`生成失败：${e}`, `Generation failed: ${e}`))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setGeneratingField(null)
    }
  }

  const genres = ['玄幻', '仙侠', '都市', '科幻', '历史', '军事', '游戏', '末世', '悬疑', '灵异', '言情', '古言', '现言', '奇幻', '武侠', '轻小说', '同人', '职场']
  const dormantThreshold = resolveNarrativeThreadDormantThreshold(
    config.narrativeThreadDormantChapterThreshold,
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
              {text('小说配置', 'Novel configuration')}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {text('定义你的小说基本信息和写作参数', 'Define the novel’s core information and writing parameters.')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ai" onClick={handleAIGenerate}>
              <Sparkles size={13} /> {text('AI 填充配置', 'Fill with AI')}
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={saving}>
              <Save size={13} /> {saving ? text('保存中...', 'Saving...') : text('保存', 'Save')}
            </Button>
          </div>
        </div>

        {/* 配置表单 */}
        <div className="space-y-5">
          {/* 基本信息 */}
          <Section title={text('基本信息', 'Basic information')}>
            <div className="grid grid-cols-3 gap-4">
              <Field label={text('类型', 'Genre')}>
                <NativeSelect value={config.genre} onChange={(e) => update('genre', e.target.value)}>
                  <option value="" disabled>{text('请选择类型', 'Select a genre')}</option>
                  {config.genre && !genres.includes(config.genre) && (
                    <option value={config.genre}>{config.genre}</option>
                  )}
                  {genres.map((g) => <option key={g} value={g}>{text(g, GENRE_EN[g] ?? g)}</option>)}
                </NativeSelect>
              </Field>
              <Field label={text('细分类型', 'Subgenre')}>
                <Input value={config.subGenre} onChange={(e) => update('subGenre', e.target.value)} placeholder={text('如：修仙/重生/末世', 'e.g. cultivation / rebirth / post-apocalyptic')} />
              </Field>
              <Field label={text('目标受众', 'Audience')}>
                <NativeSelect value={config.targetAudience} onChange={(e) => update('targetAudience', e.target.value)}>
                  <option value="" disabled>{text('请选择目标受众', 'Select an audience')}</option>
                  {config.targetAudience && !Object.hasOwn(AUDIENCE_EN, config.targetAudience) && (
                    <option value={config.targetAudience}>{config.targetAudience}</option>
                  )}
                  {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => (
                    <option key={value} value={value}>{text(value, labelEn)}</option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <div className="grid grid-cols-4 gap-4 mt-4">
              <Field label={text('故事结构', 'Story structure')} tipItems={[
                '三幕结构：经典的“建置→对抗→高潮”，适合大多数网文类型',
                '英雄之旅：神话学十二阶段，适合冒险/成长类，强调内在蜕变',
                '节拍表：好莱坞十五拍结构，节奏最精细，适合情感张力强的故事',
                '起承转合：中国传统四段式结构，适合古言/武侠/仙侠',
                '多线叙事：多条故事线并进交织，适合群像或复杂情节',
                '自由结构：不限定特定框架，AI 根据内容自适应，适合日常/轻小说',
              ].map((item, index) => text(item, [
                'Three-act structure: setup, confrontation, and climax; suitable for most genres',
                'Hero’s journey: a transformation-focused adventure structure',
                'Beat sheet: detailed pacing for emotionally intense stories',
                'Kishōtenketsu: a four-part East Asian structure',
                'Multi-thread: interwoven story lines for ensembles and complex plots',
                'Freeform: AI adapts the structure to the content',
              ][index]))}>
                <NativeSelect value={config.plotStructure || 'three_act'} onChange={(e) => update('plotStructure', e.target.value as NovelConfig['plotStructure'])}>
                  <option value="three_act">{text('三幕结构', 'Three-act')}</option>
                  <option value="heros_journey">{text('英雄之旅', 'Hero’s journey')}</option>
                  <option value="save_the_cat">{text('节拍表', 'Beat sheet')}</option>
                  <option value="kishotenketsu">{text('起承转合', 'Kishōtenketsu')}</option>
                  <option value="multi_thread">{text('多线叙事', 'Multi-thread')}</option>
                  <option value="freeform">{text('自由结构', 'Freeform')}</option>
                </NativeSelect>
              </Field>
              <Field label={text('叙事视角', 'Point of view')} tipItems={[
                '第一人称："我"视角叙事，代入感最强，信息受限',
                '第三人称有限视角：跟随主角视角，兼顾代入感和灵活性，最常用',
                '第三人称全知视角：可自由切换角色内心，适合群像叙事',
                '多视角轮换：多名角色交替叙事，适合复杂群像故事',
              ].map((item, index) => text(item, [
                'First person: immersive and intentionally limited information',
                'Third-person limited: follows one viewpoint with flexibility',
                'Third-person omniscient: can enter any character’s perspective',
                'Multiple POV: alternates between several viewpoint characters',
              ][index]))}>
                <NativeSelect value={config.narrativePOV || 'third_limited'} onChange={(e) => update('narrativePOV', e.target.value as NovelConfig['narrativePOV'])}>
                  <option value="first_person">{text('第一人称', 'First person')}</option>
                  <option value="third_limited">{text('第三人称有限视角', 'Third-person limited')}</option>
                  <option value="third_omniscient">{text('第三人称全知视角', 'Third-person omniscient')}</option>
                  <option value="multi_pov">{text('多视角轮换', 'Multiple POV')}</option>
                </NativeSelect>
              </Field>
              <Field label={text('总章数', 'Total chapters')}>
                <Input
                  type="number"
                  value={config.totalChapters}
                  onChange={(e) => update('totalChapters', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.totalChapters)
                    if (!v || v < 1) update('totalChapters', 100)
                  }}
                  placeholder="100"
                  min={1}
                />
              </Field>
              <Field label={text('每章字数', 'Words per chapter')}>
                <Input
                  type="number"
                  value={config.wordsPerChapter}
                  onChange={(e) => update('wordsPerChapter', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.wordsPerChapter)
                    if (!v || v < 100) update('wordsPerChapter', 3000)
                  }}
                  placeholder="3000"
                  min={100}
                />
              </Field>
            </div>
            <div className="grid grid-cols-4 gap-4 mt-4 items-end">
              <Field label={text('写作语言', 'Writing language')} htmlFor="project-writing-language">
                <NativeSelect
                  id="project-writing-language"
                  value={resolveWritingLanguage(config.writingLanguage)}
                  onChange={(e) => update('writingLanguage', e.target.value as WritingLanguage)}
                >
                  <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
                  <option value="en-US">English</option>
                </NativeSelect>
              </Field>
              <Field label={text('沉寂提醒阈值（章）', 'Dormant reminder threshold (chapters)')} htmlFor="narrative-thread-dormant-threshold">
                <div className="flex items-center gap-1.5">
                  <Input
                    id="narrative-thread-dormant-threshold"
                    type="number"
                    min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD}
                    max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD}
                    value={dormantThreshold}
                    onChange={event => update(
                      'narrativeThreadDormantChapterThreshold',
                      resolveNarrativeThreadDormantThreshold(Number(event.target.value)),
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => update(
                      'narrativeThreadDormantChapterThreshold',
                      DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
                    )}
                    title={text('恢复默认值', 'Restore default')}
                    aria-label={text('恢复默认值', 'Restore default')}
                  >
                    <RotateCcw size={13} />
                  </Button>
                </div>
              </Field>
            </div>
          </Section>

          <SettingDocument>
            <SettingSection
              title={text('核心大纲', 'Core outline')}
              collapsed={Boolean(collapsedSections.coreOutline)}
              onToggle={() => setCollapsedSections(current => ({ ...current, coreOutline: !current.coreOutline }))}
              generating={generatingField === 'coreOutline'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('coreOutline')}
            >
              <DocumentBody
                value={config.coreOutline}
                onChange={value => update('coreOutline', value)}
                placeholder={text('在标题下直接写正文，或点 AI 生成填充……', 'Write under this heading, or generate with AI…')}
              />
            </SettingSection>
            <SettingSection
              title={text('世界观 / 初始设定', 'World / initial setting')}
              collapsed={Boolean(collapsedSections.worldSetting)}
              onToggle={() => setCollapsedSections(current => ({ ...current, worldSetting: !current.worldSetting }))}
              generating={generatingField === 'worldSetting'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('worldSetting')}
            >
              <DocumentBody
                value={config.worldSetting}
                onChange={value => update('worldSetting', value)}
                placeholder={text('时代、地点、规则、冲突来源……', 'Era, place, rules, and sources of conflict…')}
              />
            </SettingSection>
            <SettingSection
              title={text('金手指 / 核心卖点', 'Protagonist advantage / core hook')}
              collapsed={Boolean(collapsedSections.goldenFinger)}
              onToggle={() => setCollapsedSections(current => ({ ...current, goldenFinger: !current.goldenFinger }))}
              generating={generatingField === 'goldenFinger'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('goldenFinger')}
            >
              <DocumentBody
                value={config.goldenFinger}
                onChange={value => update('goldenFinger', value)}
                placeholder={text('来源、机制、限制与代价……', 'Origin, mechanism, limits, and cost…')}
              />
            </SettingSection>
            <SettingSection
              title={text('主角人设', 'Protagonist profile')}
              collapsed={Boolean(collapsedSections.protagonistProfile)}
              onToggle={() => setCollapsedSections(current => ({ ...current, protagonistProfile: !current.protagonistProfile }))}
              generating={generatingField === 'protagonistProfile'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('protagonistProfile')}
            >
              <DocumentBody
                value={config.protagonistProfile}
                onChange={value => update('protagonistProfile', value)}
                placeholder={text('性格、背景、目标、弱点……', 'Personality, backstory, goal, and weakness…')}
              />
            </SettingSection>
            <SettingSection
              title={text('全局写作要求', 'Global writing guidance')}
              collapsed={Boolean(collapsedSections.globalGuidance)}
              onToggle={() => setCollapsedSections(current => ({ ...current, globalGuidance: !current.globalGuidance }))}
              generating={generatingField === 'globalGuidance'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('globalGuidance')}
            >
              <DocumentBody
                value={config.globalGuidance}
                onChange={value => update('globalGuidance', value)}
                placeholder={text('跨章节长期有效的规则……', 'Stable cross-chapter rules…')}
              />
            </SettingSection>
            <SettingSection
              title={text('文风配置', 'Writing style')}
              collapsed={Boolean(collapsedSections.writingStyle)}
              onToggle={() => setCollapsedSections(current => ({ ...current, writingStyle: !current.writingStyle }))}
              generating={generatingField === 'writingStyle'}
              generateDisabled={generatingField != null}
              onGenerate={() => void handleFieldGenerate('writingStyle')}
            >
              <DocumentBody
                value={config.writingStyle || ''}
                onChange={value => update('writingStyle', value)}
                placeholder={text('节奏、对话、描写密度……', 'Pacing, dialogue, and descriptive density…')}
              />
            </SettingSection>
            <SettingSection
              title={text('参考作品', 'Reference works')}
              collapsed={Boolean(collapsedSections.referenceWorks)}
              onToggle={() => setCollapsedSections(current => ({ ...current, referenceWorks: !current.referenceWorks }))}
            >
              <DocumentBody
                value={config.referenceWorks || ''}
                onChange={value => update('referenceWorks', value)}
                placeholder={text('参考哪些作品的风格或体系……', 'Which works should inform style or systems…')}
              />
            </SettingSection>
          </SettingDocument>
        </div>
      </div>

      {/* AI 生成配置弹框 */}
      <GenerateConfigDialog
        isOpen={showGenerateConfig}
        onClose={() => {
          setGenerateSession(null)
          setShowGenerateConfig(false)
        }}
        onGenerated={(parsed) => {
          const projectSession = generateSession
          if (!isProjectSessionCurrent(projectSession)) return
          // 只允许开启对话框时冻结的会话提交生成结果。
          updateNovelConfig(parsed, projectSession)
        }}
      />
    </div>
  )
}

/** 表单分组 */
function Section({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="p-4 rounded-xl bg-[var(--color-sidebar)] border border-[var(--color-border)]">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
          {desc && <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

function SettingDocument({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-5 py-4 rounded-xl border"
      style={{
        backgroundColor: 'var(--color-editor-bg)',
        borderColor: 'var(--color-border)',
      }}
    >
      {children}
    </div>
  )
}

function SettingSection({
  title,
  collapsed,
  onToggle,
  generating = false,
  generateDisabled = false,
  onGenerate,
  children,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  generating?: boolean
  generateDisabled?: boolean
  onGenerate?: () => void
  children: React.ReactNode
}) {
  const text = useLocaleStore(s => s.text)
  return (
    <section className="mb-1">
      <div
        className="flex items-center gap-2 py-2"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded-sm shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title={collapsed ? text('展开', 'Expand') : text('收起', 'Collapse')}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronDown size={14} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }} />
        </button>
        <h3 className="text-sm font-semibold m-0" style={{ color: 'var(--color-text)' }}>{title}</h3>
        {onGenerate && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={onGenerate}
            disabled={generateDisabled}
            title={generating ? text('正在生成...', 'Generating...') : text('AI 生成', 'Generate with AI')}
          >
            {generating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {generating ? text('生成中...', 'Generating...') : text('AI 生成', 'Generate with AI')}
          </Button>
        )}
      </div>
      {!collapsed && children}
    </section>
  )
}

function DocumentBody({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 72)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      rows={3}
      className="w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
      style={{
        color: 'var(--color-text)',
        minHeight: 72,
        lineHeight: 1.7,
      }}
    />
  )
}

/** 表单字段 */
function Field({
  label,
  htmlFor,
  tipItems,
  children,
}: {
  label: string
  htmlFor?: string
  tipItems?: string[]
  children: React.ReactNode
}) {
  const [showTip, setShowTip] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <label htmlFor={htmlFor} className="text-xs mb-1 flex items-center gap-1 font-medium text-[var(--color-text-muted)]">
        {label}
        {tipItems && tipItems.length > 0 && (
          <span
            style={{ position: 'relative', display: 'inline-flex' }}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          >
            <Info size={11} style={{ opacity: 0.5 }} />
            {showTip && (
              <div
                ref={tipRef}
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 6,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-line',
                  color: 'var(--color-text)',
                  background: 'var(--color-bg-elevated, var(--color-sidebar))',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                  zIndex: 9999,
                  width: 260,
                  pointerEvents: 'none',
                }}
              >
                {tipItems.map((item, i) => (
                  <div key={i} style={{ paddingLeft: 0 }}>
                    <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{item.split(/：|: /)[0]}</span>
                    {item.includes('：') ? '：' + item.split('：').slice(1).join('：') : ': ' + item.split(': ').slice(1).join(': ')}
                  </div>
                ))}
              </div>
            )}
          </span>
        )}
      </label>
      {children}
    </div>
  )
}
