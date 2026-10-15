import { APP_BRAND } from '../../shared/brand'
import { useLocaleStore } from '../../stores/locale-store'

export function AboutSection() {
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
