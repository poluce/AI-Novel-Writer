import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import RightToolWindowBar from '../RightToolWindowBar'
import { useLayoutStore } from '../../../stores/layout-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'

describe('RightToolWindowBar', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      aiPanelOpen: false,
      rightView: 'agent',
    })
    useWorkflowStore.setState({
      currentRun: null,
      activeRuns: [],
    })
  })

  it('renders buttons for AI Assistant, Architecture Assistant, Blueprint Assistant, and Structured Workflow Output', () => {
    const html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('title="AI 助手"')
    expect(html).toContain('title="架构助手"')
    expect(html).toContain('title="蓝图助手"')
    expect(html).toContain('title="结构化工作流输出"')
  })

  it('visually activates the corresponding button based on rightView when aiPanelOpen is true', () => {
    // 1. Agent 激活
    useLayoutStore.setState({ aiPanelOpen: true, rightView: 'agent' })
    let html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('var(--color-activity-icon-active)')

    // 2. Architect 激活
    useLayoutStore.setState({ aiPanelOpen: true, rightView: 'architect' })
    html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('var(--color-activity-icon-active)')

    // 3. Blueprint 激活
    useLayoutStore.setState({ aiPanelOpen: true, rightView: 'blueprint' })
    html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('var(--color-activity-icon-active)')

    // 4. Workflow 激活
    useLayoutStore.setState({ aiPanelOpen: true, rightView: 'ai-output' })
    html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('var(--color-activity-icon-active)')
  })

  it('shows an indicator pulse on the workflow button when a background workflow is active and not currently viewed', () => {
    const run = {
      id: 'run-1',
      title: '正在生成章节',
      status: 'running',
    } as WorkflowRun

    useWorkflowStore.setState({
      activeRuns: [run],
      currentRun: run,
    })

    // 未在查看 ai-output 时应显示指示点
    useLayoutStore.setState({ aiPanelOpen: true, rightView: 'agent' })
    const html = renderToString(<RightToolWindowBar />)
    expect(html).toContain('animate-pulse')
  })
})
