import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LeftToolWindowBar from '../LeftToolWindowBar'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'

function countActiveRailButtons(html: string) {
  return [...html.matchAll(/<button\b[^>]*\bclass="([^"]*)"[^>]*>/g)]
    .filter(([, className]) => {
      const classTokens = className.split(/\s+/)
      return classTokens.includes('left-nav-button') && classTokens.includes('is-active')
    })
    .length
}

describe('LeftToolWindowBar', () => {
  it('renders visible Chinese labels for every left navigation item', () => {
    const html = renderToString(<LeftToolWindowBar />)

    for (const label of ['首页', '项目', '蓝图', '角色', '架构', '大纲', '剧情', '知识库', '任务', '设置']) {
      expect(html).toContain(label)
    }
  })

  it('does not render legacy sidebar labels as primary nav labels', () => {
    const html = renderToString(<LeftToolWindowBar />)

    expect(html).not.toContain('项目结构</span>')
    expect(html).not.toContain('小说</span>')
    expect(html).not.toContain('角色管理</span>')
  })

  it('keeps exactly one primary rail item visually active', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      sidebarView: 'project',
      aiPanelOpen: true,
      rightView: 'agent',
      bottomPanelOpen: true,
      bottomTab: 'models',
    })
    const html = renderToString(<LeftToolWindowBar />)

    expect(countActiveRailButtons(html)).toBe(1)
  })

  it('replaces the duplicate AI settings entry with the plot tree', () => {
    const source = renderToString(<LeftToolWindowBar />)

    expect(source).toContain('剧情树')
    expect(source).not.toContain('配置模型 API')
  })

  it('does not open blueprint or plot-tree editors until a project is open', () => {
    const rail = readFileSync(resolve(process.cwd(), 'src/components/layout/LeftToolWindowBar.tsx'), 'utf8')
    const empty = readFileSync(resolve(process.cwd(), 'src/components/panels/OpenProjectFirstPage.tsx'), 'utf8')
    expect(rail).toContain('if (!hasOpenProject) return')
    expect(rail).toContain("openBuiltinEditor('world-building-editor'")
    expect(empty).toContain("text('请先打开项目', 'Open a project first')")
    const sidebar = readFileSync(resolve(process.cwd(), 'src/components/panels/Sidebar.tsx'), 'utf8')
    expect(sidebar).toContain('workspaceNeedsProject')
    expect(sidebar).toContain("activeRailItem !== 'project'")
  })

  it('disables project-dependent navigation buttons when no project is open', () => {
    useProjectStore.setState({ currentProject: null })

    const html = renderToString(<LeftToolWindowBar />)
    const projectDependentLabels = ['角色', '蓝图', '架构', '大纲', '剧情', '知识库']

    for (const label of projectDependentLabels) {
      // Button containing this label must have disabled attribute and is-disabled class
      const pattern = new RegExp(`<button disabled=""[^>]*class="[^"]*is-disabled[^"]*"[^>]*>[\\s\\S]*?<span class="left-nav-label">${label}<\\/span>`, 'u')
      expect(html).toMatch(pattern)
    }

    // Home must remain enabled
    const homePattern = new RegExp(`<button(?! disabled)[^>]*>[\\s\\S]*?<span class="left-nav-label">首页<\\/span>`, 'u')
    expect(html).toMatch(homePattern)
  })
})
