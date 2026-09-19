/**
 * Sidebar — 左侧导航面板容器
 *
 * 纯路由容器，根据 sidebarView 切换子视图。
 * 所有子视图已拆分到 sidebar/ 子目录。
 */

import { useState, useEffect } from 'react'
import { BookOpen } from 'lucide-react'
import { useLayoutStore } from '../../stores/layout-store'
import { useProjectStore } from '../../stores/project-store'
import { ContextMenu } from '../ui/ContextMenu'
import { EmptyState } from '../ui/EmptyState'
import KnowledgePanel from './KnowledgePanel'
import HomeSidebarPanel from './sidebar/HomeSidebarPanel'
import ProjectTree from './sidebar/ProjectTree'
import CharactersView from './sidebar/CharactersView'
import {
  registerMenuSetter, unregisterMenuSetter,
  type SidebarMenuState,
} from './sidebar/sidebar-menu'
import { useLocaleStore } from '../../stores/locale-store'

/** 左侧面板 */
export default function Sidebar() {
  const sidebarView = useLayoutStore(s => s.sidebarView)
  const activeRailItem = useLayoutStore(s => s.activeRailItem)
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  // 全局右键菜单状态
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null)

  // 注册 / 注销右键菜单 setter
  useEffect(() => {
    registerMenuSetter(setSidebarMenu)
    return () => { unregisterMenuSetter() }
  }, [])

  const viewTitles: Record<string, string> = {
    home:       text('主页', 'Home'),
    project:    text('项目结构', 'Project'),
    knowledge:  text('知识库', 'Knowledge'),
    characters: text('角色管理', 'Characters'),
    blueprint:  text('章节蓝图', 'Chapter blueprint'),
    world:      text('故事架构', 'Story architecture'),
    synopsis:   text('情节', 'Plot'),
    'plot-tree': text('剧情树', 'Plot tree'),
  }
  const headerTitle = viewTitles[activeRailItem] ?? viewTitles[sidebarView]
  const workspaceNeedsProject = !currentProject && activeRailItem !== 'home' && activeRailItem !== 'project'

  return (
    <div
      className="skin-workspace-panel w-full h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--color-sidebar)',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      <div className="panel-header">
        <span>{headerTitle}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sidebarView === 'home' && <HomeSidebarPanel />}
        {workspaceNeedsProject && (
          <EmptyState
            icon={<BookOpen size={36} />}
            message={text('请先打开项目', 'Open a project first')}
            className="pb-[15vh]"
            opacity={0.4}
          />
        )}
        {!workspaceNeedsProject && sidebarView === 'project' && <ProjectTree />}
        {!workspaceNeedsProject && sidebarView === 'knowledge' && <KnowledgePanel />}
        {!workspaceNeedsProject && sidebarView === 'characters' && <CharactersView />}
      </div>

      {/* 动态右键菜单 */}
      {sidebarMenu && (
        <ContextMenu
          items={sidebarMenu.items}
          position={sidebarMenu.position}
          onClose={() => setSidebarMenu(null)}
        />
      )}
    </div>
  )
}
