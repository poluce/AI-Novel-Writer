import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { useLocaleStore } from '../../stores/locale-store'

/** 长文本设置文档容器（小说配置 / 故事架构共用）。 */
export function SettingDocument({ children }: { children: ReactNode }) {
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

/** 带折叠 + 可选「清除」/「AI 生成」按钮的设置区块。 */
export function SettingSection({
  title,
  collapsed,
  onToggle,
  generating = false,
  generateDisabled = false,
  generateHidden = false,
  generateTitle,
  onGenerate,
  onClear,
  clearDisabled = false,
  clearHidden = false,
  clearTitle,
  children,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  generating?: boolean
  generateDisabled?: boolean
  generateHidden?: boolean
  generateTitle?: string
  onGenerate?: () => void
  onClear?: () => void
  clearDisabled?: boolean
  clearHidden?: boolean
  clearTitle?: string
  children: ReactNode
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
        {(Boolean(onClear && !clearHidden) || Boolean(onGenerate && !generateHidden)) && (
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {onClear && !clearHidden && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClear}
                disabled={clearDisabled || generating}
                title={clearTitle ?? text('清除内容', 'Clear content')}
              >
                <Trash2 size={11} />
                {text('清除', 'Clear')}
              </Button>
            )}
            {onGenerate && !generateHidden && (
              <Button
                variant="outline"
                size="sm"
                onClick={onGenerate}
                disabled={generateDisabled}
                title={generateTitle ?? (generating ? text('正在生成...', 'Generating...') : text('AI 生成', 'Generate with AI'))}
              >
                {generating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {generating ? text('生成中...', 'Generating...') : text('AI 生成', 'Generate with AI')}
              </Button>
            )}
          </div>
        )}
      </div>
      {!collapsed && children}
    </section>
  )
}

/** 可编辑长文本正文区（自动随内容伸缩高度）。 */
export function DocumentBody({
  value,
  onChange,
  placeholder,
  readOnly = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  readOnly?: boolean
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
      readOnly={readOnly}
      className="w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
      style={{
        color: 'var(--color-text)',
        minHeight: 72,
        lineHeight: 1.7,
      }}
    />
  )
}
