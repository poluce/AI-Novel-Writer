import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { toast } from '../ui/Toast'
import type {
  NovelStudyDossier,
  NovelStudyProjectionOptions,
  NovelStudyProjectionReceipt,
} from '../../shared/novel-study'
import { Check, Sparkles, Users } from 'lucide-react'

export interface NovelStudyProjectionDialogProps {
  open: boolean
  onClose: () => void
  dossier: NovelStudyDossier | null
  onApplied?: (receipt: NovelStudyProjectionReceipt) => void
}

export default function NovelStudyProjectionDialog({
  open,
  onClose,
  dossier,
  onApplied,
}: NovelStudyProjectionDialogProps) {
  const text = useLocaleStore((s) => s.text)
  const currentProject = useProjectStore((s) => s.currentProject)

  const [applyStyle, setApplyStyle] = useState(true)
  const [applyOutline, setApplyOutline] = useState(false)
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>([])
  const [applyBlueprints, setApplyBlueprints] = useState(false)
  const [blueprintStart, setBlueprintStart] = useState(1)
  const [blueprintEnd, setBlueprintEnd] = useState(5)
  const [applying, setApplying] = useState(false)

  if (!dossier) return null

  const maxBlueprints = dossier.blueprints.length > 0
    ? Math.max(...dossier.blueprints.map((b) => b.chapterNumber))
    : 0

  const toggleCharacter = (name: string) => {
    setSelectedCharacters((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  const selectAllCharacters = () => {
    setSelectedCharacters(dossier.characterCards.map((c) => c.name))
  }

  const clearAllCharacters = () => {
    setSelectedCharacters([])
  }

  const handleApply = async () => {
    if (!currentProject) {
      toast.error(text('请先打开项目', 'Please open a project first'))
      return
    }

    setApplying(true)
    try {
      const options: NovelStudyProjectionOptions = {
        dossierId: dossier.id,
        applyStyle,
        applyOutline,
        selectedCharacterNames: selectedCharacters,
        ...(applyBlueprints
          ? { selectedBlueprintRange: { startChapter: blueprintStart, endChapter: blueprintEnd } }
          : {}),
      }

      const res = await ipc.invoke(
        'db:study-dossier-apply',
        options,
        currentProject.path,
      )

      if (res.success && res.receipt) {
        toast.success(
          text(
            '研习设定已按需应用到当前项目',
            'Study settings have been projected to the current project',
          ),
        )
        onApplied?.(res.receipt)
        onClose()
      } else {
        toast.error(res.error || text('应用失败', 'Failed to apply settings'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--color-accent)]" />
            {text('研习成果按需装配', 'Novel Study Projection')}
          </DialogTitle>
          <DialogDescription>
            {text(
              `已为参考作品「${dossier.title}」建立自包含研习档案。请勾选需要投影应用到当前项目的创作要素：`,
              `A self-contained study dossier was built for "${dossier.title}". Choose which elements to project into the current project:`,
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
          {/* 选项 1: 文风与仿写指南 */}
          <div
            className="p-3.5 rounded-lg border transition-colors cursor-pointer"
            style={{
              borderColor: applyStyle ? 'var(--color-accent)' : 'var(--color-border)',
              backgroundColor: applyStyle
                ? 'color-mix(in srgb, var(--color-accent) 6%, transparent)'
                : 'var(--color-bg-secondary)',
            }}
            onClick={() => setApplyStyle(!applyStyle)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded flex items-center justify-center border"
                  style={{
                    backgroundColor: applyStyle ? 'var(--color-accent)' : 'transparent',
                    borderColor: applyStyle ? 'var(--color-accent)' : 'var(--color-border)',
                    color: 'var(--color-bg)',
                  }}
                >
                  {applyStyle && <Check size={12} strokeWidth={3} />}
                </div>
                <span className="text-sm font-medium">
                  {text('应用写作风格与仿写约束', 'Apply Style and Imitation Constraints')}
                </span>
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">
                {text('写入小说配置', 'Project writing style')}
              </span>
            </div>
            {dossier.styleProfile?.rawAnalysis && (
              <p className="mt-2 text-xs text-[var(--color-text-secondary)] line-clamp-3 leading-relaxed pl-6">
                {dossier.styleProfile.rawAnalysis}
              </p>
            )}
          </div>

          {/* 选项 2: 全局大纲与世界观 */}
          <div
            className="p-3.5 rounded-lg border transition-colors cursor-pointer"
            style={{
              borderColor: applyOutline ? 'var(--color-accent)' : 'var(--color-border)',
              backgroundColor: applyOutline
                ? 'color-mix(in srgb, var(--color-accent) 6%, transparent)'
                : 'var(--color-bg-secondary)',
            }}
            onClick={() => setApplyOutline(!applyOutline)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded flex items-center justify-center border"
                  style={{
                    backgroundColor: applyOutline ? 'var(--color-accent)' : 'transparent',
                    borderColor: applyOutline ? 'var(--color-accent)' : 'var(--color-border)',
                    color: 'var(--color-bg)',
                  }}
                >
                  {applyOutline && <Check size={12} strokeWidth={3} />}
                </div>
                <span className="text-sm font-medium">
                  {text('导入故事架构与世界观大纲', 'Import Architecture and World Outline')}
                </span>
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">
                {text('可能覆盖当前设定', 'May overwrite current config')}
              </span>
            </div>
            {dossier.inferredOutline && (
              <div className="mt-2 text-xs text-[var(--color-text-secondary)] space-y-1 pl-6">
                <div>
                  <span className="text-[var(--color-text-muted)]">{text('类型: ', 'Genre: ')}</span>
                  {dossier.inferredOutline.genre || text('未指定', 'None')}
                  {dossier.inferredOutline.subGenre && ` / ${dossier.inferredOutline.subGenre}`}
                </div>
                {dossier.inferredOutline.coreOutline && (
                  <div className="line-clamp-2">
                    <span className="text-[var(--color-text-muted)]">{text('大纲: ', 'Outline: ')}</span>
                    {dossier.inferredOutline.coreOutline}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 选项 3: 角色原型候选 */}
          {dossier.characterCards.length > 0 && (
            <div
              className="p-3.5 rounded-lg border space-y-2.5"
              style={{
                borderColor: selectedCharacters.length > 0 ? 'var(--color-accent)' : 'var(--color-border)',
                backgroundColor: 'var(--color-bg-secondary)',
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users size={15} className="text-[var(--color-accent)]" />
                  <span className="text-sm font-medium">
                    {text(
                      `角色原型库（可选导入 ${dossier.characterCards.length} 人）`,
                      `Character Archetypes (Select from ${dossier.characterCards.length})`,
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={selectAllCharacters}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    {text('全选', 'Select all')}
                  </button>
                  <span className="text-[var(--color-border)]">|</span>
                  <button
                    type="button"
                    onClick={clearAllCharacters}
                    className="text-[var(--color-text-muted)] hover:underline"
                  >
                    {text('清空', 'Clear')}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                {dossier.characterCards.map((ch) => {
                  const selected = selectedCharacters.includes(ch.name)
                  return (
                    <div
                      key={ch.name}
                      onClick={() => toggleCharacter(ch.name)}
                      className="p-2 rounded border flex items-center justify-between gap-1.5 cursor-pointer text-xs transition-colors"
                      style={{
                        borderColor: selected ? 'var(--color-accent)' : 'var(--color-border)',
                        backgroundColor: selected
                          ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
                          : 'var(--color-bg)',
                      }}
                    >
                      <span className="font-medium truncate">{ch.name}</span>
                      <span className="text-[0.7rem] text-[var(--color-text-muted)] shrink-0">
                        {ch.role === 'protagonist'
                          ? text('主角', 'Protagonist')
                          : text('配角', 'Supporting')}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 选项 4: 章节细纲模板 */}
          {dossier.blueprints.length > 0 && (
            <div
              className="p-3.5 rounded-lg border space-y-2.5 cursor-pointer transition-colors"
              style={{
                borderColor: applyBlueprints ? 'var(--color-accent)' : 'var(--color-border)',
                backgroundColor: applyBlueprints
                  ? 'color-mix(in srgb, var(--color-accent) 6%, transparent)'
                  : 'var(--color-bg-secondary)',
              }}
              onClick={() => setApplyBlueprints(!applyBlueprints)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded flex items-center justify-center border"
                    style={{
                      backgroundColor: applyBlueprints ? 'var(--color-accent)' : 'transparent',
                      borderColor: applyBlueprints ? 'var(--color-accent)' : 'var(--color-border)',
                      color: 'var(--color-bg)',
                    }}
                  >
                    {applyBlueprints && <Check size={12} strokeWidth={3} />}
                  </div>
                  <span className="text-sm font-medium">
                    {text(
                      `导入反推章节细纲（共 ${dossier.blueprints.length} 章）`,
                      `Import Inferred Blueprints (${dossier.blueprints.length} chapters)`,
                    )}
                  </span>
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {text('章节蓝图', 'Chapter blueprints')}
                </span>
              </div>

              {applyBlueprints && (
                <div
                  className="flex items-center gap-2 pt-1 pl-6 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-[var(--color-text-secondary)]">{text('导入范围: 第', 'Range: Ch ')}</span>
                  <input
                    type="number"
                    min={1}
                    max={maxBlueprints}
                    value={blueprintStart}
                    onChange={(e) => setBlueprintStart(Math.max(1, Number(e.target.value)))}
                    className="w-14 px-1.5 py-0.5 rounded border text-center text-xs bg-[var(--color-input)] border-[var(--color-border)]"
                  />
                  <span>{text('章 至 第', ' to ')}</span>
                  <input
                    type="number"
                    min={blueprintStart}
                    max={maxBlueprints}
                    value={blueprintEnd}
                    onChange={(e) => setBlueprintEnd(Math.max(blueprintStart, Number(e.target.value)))}
                    className="w-14 px-1.5 py-0.5 rounded border text-center text-xs bg-[var(--color-input)] border-[var(--color-border)]"
                  />
                  <span>{text('章', '')}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 border-t pt-3">
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            {text('仅保存档案（不应用）', 'Keep in Dossier only')}
          </Button>
          <Button onClick={handleApply} disabled={applying}>
            {applying ? text('正在应用...', 'Applying...') : text('应用选中要素到项目', 'Apply Selected Elements')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
