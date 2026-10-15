import { useState, useEffect, type ReactNode } from 'react'
import {
  X, Globe, Cpu, Database, Type, Settings2, MessageSquare,
  Info, Palette, BookOpen, Sliders, Server,
} from 'lucide-react'
import PromptSettings from './PromptSettings'
import SkillSettings from './SkillSettings'
import AppearanceSettings from './AppearanceSettings'
import PresetsSettings from './PresetsSettings'
import MCPSettings from './MCPSettings'
import { LLMSection } from './GenerationModelSettings'
import { ProxySection } from './ProxySettings'
import { EditorSection } from './EditorSettings'
import { AboutSection } from './AboutSettings'
import { cn } from '../../lib/utils'
import { useLayoutStore, type SettingsSection } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'

type SettingsModalSection = SettingsSection | 'appearance'

interface SectionItem {
  id: SettingsModalSection
  label: string
  labelEn: string
  icon: ReactNode
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
  { id: 'skills', label: '写作 Skills', labelEn: 'Writing skills', icon: <BookOpen size={16} />, description: '检查并安装提示词型写作 Skill', descriptionEn: 'Inspect and install prompt-only writing skills' },
  { id: 'mcp', label: 'MCP 服务器', labelEn: 'MCP servers', icon: <Server size={16} />, description: '添加、修改或删除项目助手可用的 MCP 服务器', descriptionEn: 'Add, edit, or delete MCP servers for the project assistant' },
  { id: 'about', label: '关于', labelEn: 'About', icon: <Info size={16} />, description: '版本、定位与本地部署说明', descriptionEn: 'Version, positioning, and local deployment' },
]

function resolveRequestedSettingsSection(rawSection: SettingsSection): SettingsModalSection {
  if (SETTINGS_SECTIONS.some(item => item.id === rawSection)) return rawSection as SettingsModalSection
  return SETTINGS_SECTIONS[0]?.id ?? 'appearance'
}

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const text = useLocaleStore(s => s.text)
  const rawSection = useLayoutStore(s => s.settingsSection)
  const requestedSection = resolveRequestedSettingsSection(rawSection)
  const [section, setSection] = useState<SettingsModalSection>(requestedSection)

  useEffect(() => {
    if (!open) return
    // 在提交后同步外部请求，避免 effect 阶段同步 setState 的级联渲染。
    const syncTimer = window.setTimeout(() => setSection(requestedSection), 0)
    return () => window.clearTimeout(syncTimer)
  }, [open, requestedSection])

  if (!open) return null

  const currentSectionItem = SETTINGS_SECTIONS.find(s => s.id === section)
  let sectionTitle = ''
  let sectionDescription = ''
  if (currentSectionItem) {
    sectionTitle = text(currentSectionItem.label, currentSectionItem.labelEn)
    sectionDescription = text(currentSectionItem.description, currentSectionItem.descriptionEn)
  }

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
        <aside
          className="flex flex-col w-52 flex-shrink-0 py-5 gap-1"
          style={{
            backgroundColor: 'var(--color-sidebar)',
            borderRight: '1px solid var(--color-border)',
          }}
        >
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

        <main className="flex-1 flex flex-col overflow-hidden">
          <div
            className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
                {sectionTitle}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {sectionDescription}
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

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {section === 'appearance' && <AppearanceSettings />}
            {section === 'llm' && <LLMSection purposes={['generation', 'refinement', 'summary']} purposeLabel={text('生成模型', 'generation models')} />}
            {section === 'embedding' && <LLMSection purposes={['embedding']} purposeLabel={text('向量模型', 'embedding models')} />}
            {section === 'presets' && <PresetsSettings />}
            {section === 'proxy' && <ProxySection />}
            {section === 'editor' && <EditorSection />}
            {section === 'prompts' && <PromptSettings />}
            {section === 'skills' && <SkillSettings />}
            {section === 'mcp' && <MCPSettings />}
            {section === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}
