import { BookOpen } from 'lucide-react'
import { EmptyState } from '../ui/EmptyState'
import { useLocaleStore } from '../../stores/locale-store'

/** Same empty workspace chrome as 小说/知识库 when no project is open. */
export function OpenProjectFirstPage({ title }: { title: string }) {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="skin-workspace-page h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
            {title}
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto relative">
        <EmptyState
          icon={<BookOpen size={36} />}
          message={text('请先打开项目', 'Open a project first')}
          opacity={0.4}
        />
      </div>
    </div>
  )
}
