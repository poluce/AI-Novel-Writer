import { useState, useEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { useThemeStore, FONT_OPTIONS, type FontId } from '../../stores/theme-store'
import { NativeSelect } from '../ui/NativeSelect'
import { ipc } from '../../services/ipc-client'
import { Switch } from '../ui/Switch'
import { useLocaleStore } from '../../stores/locale-store'
import { logFailure } from '../../shared/fail-log'
import type { Locale } from '../../i18n/types'

function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 字体下拉菜单（界面字体 + 写作字体共用） */
function fontSelectTriggerBackground(open: boolean): string {
  if (open) return 'var(--color-hover)'
  return 'var(--color-panel)'
}

function fontOptionRowBackground(selected: boolean): string {
  if (selected) return 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
  return 'transparent'
}

function fontOptionMarkStyle(selected: boolean): { backgroundColor: string; border: string } {
  if (selected) {
    return { backgroundColor: 'var(--color-accent)', border: 'none' }
  }
  return { backgroundColor: 'transparent', border: '1.5px solid var(--color-border)' }
}

function chevronRotation(open: boolean): string {
  if (open) return 'rotate(180deg)'
  return 'rotate(0deg)'
}

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
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 h-9 rounded-lg transition-colors text-left"
        style={{
          border: '1px solid var(--color-border)',
          backgroundColor: fontSelectTriggerBackground(open),
          color: 'var(--color-text)',
        }}
      >
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
            transform: chevronRotation(open),
          }}
        />
      </button>

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
                backgroundColor: fontOptionRowBackground(value === opt.id),
              }}
            >
              <span
                className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center"
                style={fontOptionMarkStyle(value === opt.id)}
              >
                {value === opt.id && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </span>

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

export function EditorSection() {
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
        `自动打开下一章设置保存失败：${thrownMessage(error)}`,
        `Could not save the open-next-chapter setting: ${thrownMessage(error)}`,
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
