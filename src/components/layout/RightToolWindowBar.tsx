import { Bot, DraftingCompass, ListTree, Workflow } from 'lucide-react'
import { useLayoutStore, type RightView } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'

/**
 * 右侧工具窗口栏（RightToolWindowBar）
 * JetBrains 风格：30px 宽，纯图标，激活时右侧 2px 竖线。
 * 提供三个独立的专用视图入口：
 * 1. AI 创作助手（Agent 对话面板）
 * 2. 架构助手（专职大纲/世界观/设定推演）
 * 3. 结构化工作流输出（AI Output 面板）
 */
export default function RightToolWindowBar() {
  const text = useLocaleStore(s => s.text)
  const isSsr = typeof window === 'undefined'

  const layout = useLayoutStore()
  const workflow = useWorkflowStore()

  const aiPanelOpen = isSsr ? useLayoutStore.getState().aiPanelOpen : layout.aiPanelOpen
  const rightView = isSsr ? useLayoutStore.getState().rightView : layout.rightView
  const toggleAIPanel = layout.toggleAIPanel
  const openRightPanel = layout.openRightPanel
  const setRightView = layout.setRightView

  const currentRun = isSsr ? useWorkflowStore.getState().currentRun : workflow.currentRun
  const activeRuns = isSsr ? useWorkflowStore.getState().activeRuns : workflow.activeRuns

  const isAgentActive = aiPanelOpen && rightView === 'agent'
  const isArchitectActive = aiPanelOpen && rightView === 'architect'
  const isBlueprintActive = aiPanelOpen && rightView === 'blueprint'
  const isWorkflowActive = aiPanelOpen && rightView === 'ai-output'

  /** 后台任务/工作流活跃时的指示脉冲 */
  const isRunning = (run?: { status?: string } | null) => Boolean(run && (run.status === 'running' || run.status === 'waiting'))
  const showPulse = Boolean(isRunning(currentRun) || activeRuns.some(r => isRunning(r)))

  const handleToggle = (targetView: RightView) => {
    if (!aiPanelOpen) {
      openRightPanel(targetView)
    } else if (rightView === targetView) {
      toggleAIPanel()
    } else {
      setRightView(targetView)
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
      {/* 1. AI 创作助手面板按钮 */}
      <button
        onClick={() => handleToggle('agent')}
        title={text('AI 助手', 'AI Assistant')}
        className="tool-btn relative"
        style={{
          height: 30,
          boxShadow: isAgentActive
            ? 'inset -2px 0 0 var(--color-activity-indicator)'
            : 'none',
          color: isAgentActive
            ? 'var(--color-activity-icon-active)'
            : 'var(--color-activity-icon)',
        }}
      >
        <Bot size={15} strokeWidth={isAgentActive ? 2 : 1.5} />
      </button>

      {/* 2. 架构助手面板按钮 */}
      <button
        onClick={() => handleToggle('architect')}
        title={text('架构助手', 'Architecture Assistant')}
        className="tool-btn relative"
        style={{
          height: 30,
          boxShadow: isArchitectActive
            ? 'inset -2px 0 0 var(--color-activity-indicator)'
            : 'none',
          color: isArchitectActive
            ? 'var(--color-activity-icon-active)'
            : 'var(--color-activity-icon)',
        }}
      >
        <DraftingCompass size={15} strokeWidth={isArchitectActive ? 2 : 1.5} />
      </button>

      {/* 3. 蓝图助手面板按钮 */}
      <button
        onClick={() => handleToggle('blueprint')}
        title={text('蓝图助手', 'Blueprint Assistant')}
        className="tool-btn relative"
        style={{
          height: 30,
          boxShadow: isBlueprintActive
            ? 'inset -2px 0 0 var(--color-activity-indicator)'
            : 'none',
          color: isBlueprintActive
            ? 'var(--color-activity-icon-active)'
            : 'var(--color-activity-icon)',
        }}
      >
        <ListTree size={15} strokeWidth={isBlueprintActive ? 2 : 1.5} />
      </button>

      {/* 4. 结构化工作流输出面板按钮 */}
      <button
        onClick={() => handleToggle('ai-output')}
        title={text('结构化工作流输出', 'Structured workflow output')}
        className="tool-btn relative"
        style={{
          height: 30,
          boxShadow: isWorkflowActive
            ? 'inset -2px 0 0 var(--color-activity-indicator)'
            : 'none',
          color: isWorkflowActive
            ? 'var(--color-activity-icon-active)'
            : 'var(--color-activity-icon)',
        }}
      >
        <Workflow size={15} strokeWidth={isWorkflowActive ? 2 : 1.5} />
        {/* 工作流/任务活跃且当前未在查看输出时的脉冲指示点 */}
        {showPulse && !isWorkflowActive && (
          <span
            className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full animate-pulse pointer-events-none"
            style={{ backgroundColor: 'var(--color-accent)' }}
          />
        )}
      </button>
    </div>
  )
}
