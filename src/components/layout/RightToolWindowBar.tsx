import { Bot } from 'lucide-react'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'

/**
 * 右侧工具窗口栏（RightToolWindowBar）
 * JetBrains 风格：30px 宽，纯图标，激活时右侧 2px 竖线。
 * 统一收拢为单一 AI 助手面板入口，消除“AI Agent 面板”与“旧 AI 输出面板”双入口的割裂。
 */
export default function RightToolWindowBar() {
  const text = useLocaleStore(s => s.text)
  const aiPanelOpen = useLayoutStore(s => s.aiPanelOpen)
  const toggleAIPanel = useLayoutStore(s => s.toggleAIPanel)
  const openRightPanel = useLayoutStore(s => s.openRightPanel)
  const currentRun = useWorkflowStore((s) => s.currentRun)

  /** 后台任务/工作流活跃时的指示脉冲 */
  const showPulse = currentRun && (currentRun.status === 'running' || currentRun.status === 'waiting')

  const handleToggle = () => {
    if (!aiPanelOpen) {
      openRightPanel('agent')
    } else {
      toggleAIPanel()
    }
  }

  return (
    <div
      className="no-select flex flex-col items-center justify-start h-full py-0.5 gap-0.5"
      style={{
        width: 'var(--width-right-bar)', /* 30px */
        backgroundColor: 'var(--color-activity-bar)',
        borderLeft: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      {/* 统一 AI 助手面板按钮 */}
      <button
        onClick={handleToggle}
        title={text('AI 助手', 'AI Assistant')}
        className="tool-btn relative"
        style={{
          height: 30,
          boxShadow: aiPanelOpen
            ? 'inset -2px 0 0 var(--color-activity-indicator)'
            : 'none',
          color: aiPanelOpen
            ? 'var(--color-activity-icon-active)'
            : 'var(--color-activity-icon)',
        }}
      >
        <Bot size={15} strokeWidth={aiPanelOpen ? 2 : 1.5} />
        {/* 工作流/任务活跃时的脉冲指示点 */}
        {showPulse && !aiPanelOpen && (
          <span
            className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: 'var(--color-accent)' }}
          />
        )}
      </button>
    </div>
  )
}
