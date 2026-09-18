import {
  FolderOpen,
  BookOpen,
  Users,
  Home,
  ListTree,
  Globe2,
  GitBranch,
  ListChecks,
  Settings,
  ScrollText,
  Cpu,
  Map} from 'lucide-react'
import { useLayoutStore, type SidebarView, type BottomTab } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { openBuiltinEditor } from '../panels/sidebar/sidebar-file-openers'
import { useLocaleStore } from '../../stores/locale-store'

/** 左侧侧边栏视图按钮配置（不含 Home，它单独渲染） */
const sidebarActivities: Array<{ id: SidebarView; icon: typeof FolderOpen; zh: string; en: string }> = [
  { id: 'project', icon: FolderOpen, zh: '项目', en: 'Project' },
]

/** 底部面板 Tab 按钮配置 */
const bottomTabs: Array<{ id: BottomTab; icon: typeof ListChecks; zh: string; en: string }> = [
  { id: 'tasks', icon: ListChecks, zh: '任务', en: 'Tasks' },
  { id: 'log', icon: ScrollText, zh: '日志', en: 'Logs' },
  { id: 'models', icon: Cpu, zh: '模型', en: 'Models' },
]

function LeftNavButton({
  icon: Icon,
  label,
  active,
  pulse,
  disabled,
  onClick,
  title}: {
  icon: typeof FolderOpen
  label: string
  active?: boolean
  pulse?: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  const text = useLocaleStore(s => s.text)
  const resolvedTitle = disabled
    ? `${title ?? label} (${text('请先打开项目', 'Open a project first')})`
    : (title ?? label)

  return (
    <div className="relative w-full px-1">
      <button
        onClick={onClick}
        disabled={disabled}
        title={resolvedTitle}
        className={`left-nav-button${active ? ' is-active' : ''}${disabled ? ' is-disabled opacity-35 cursor-not-allowed pointer-events-none' : ''}`}
      >
        <Icon size={22} strokeWidth={active ? 2 : 1.75} />
        <span className="left-nav-label">{label}</span>
      </button>
      {pulse && !disabled && (
        <span
          className="absolute top-[5px] right-[5px] w-[5px] h-[5px] rounded-full animate-pulse pointer-events-none"
          style={{ backgroundColor: 'var(--color-accent)' }}
        />
      )}
    </div>
  )
}

/**
 * 左侧工具窗口栏（LeftToolWindowBar）
 * JetBrains 风格：带文字标签的左侧主导航，全高
 */
export default function LeftToolWindowBar() {
  const activeRailItem = useLayoutStore(s => s.activeRailItem)
  const setSidebarView = useLayoutStore(s => s.setSidebarView)
  const setBottomTab = useLayoutStore(s => s.setBottomTab)
  const openSettings = useLayoutStore(s => s.openSettings)
  const currentRun = useWorkflowStore(s => s.currentRun)
  const hasOpenProject = useProjectStore(s => Boolean(s.currentProject))
  const text = useLocaleStore(s => s.text)

  const openProjectWorkspace = () => {
    setSidebarView('project')
    const project = useProjectStore.getState().currentProject
    if (!project) return
    useEditorStore.getState().openFile({
      id: 'config',
      name: text('小说配置', 'Novel configuration'),
      type: 'config',
      projectKey: project.path})
  }

  /** Home 按钮是否激活 */
  const homeActive = activeRailItem === 'home'
  const plotTreeActive = activeRailItem === 'plot-tree'

  return (
    <div
      className="writer-left-rail no-select flex flex-col h-full"
      style={{
        width: 'var(--width-left-bar)',
        flexShrink: 0}}
    >
      {/* ===== 顶部：Home + 侧边栏视图切换 ===== */}
      <div className="flex flex-col items-center w-full pt-0.5">

        {/* Home 按钮 — 点击切换到主页视图 */}
        <LeftNavButton
          icon={Home}
          label={text('首页', 'Home')}
          active={homeActive}
          onClick={() => setSidebarView('home')}
          title={text('欢迎页', 'Welcome')}
        />

        {/* 分割线 */}
        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        {/* 侧边栏视图按钮 */}
        {sidebarActivities.map(({ id, icon: Icon, zh, en }) => {
          const label = text(zh, en)
          const isActive = activeRailItem === id
          const isDisabled = id === 'characters' && !hasOpenProject
          return (
            <LeftNavButton
              key={id}
              icon={Icon}
              label={label}
              active={isActive}
              disabled={isDisabled}
              title={label}
              onClick={() => {
                if (isDisabled) return
                if (id === 'project') openProjectWorkspace()
                else setSidebarView(id)
              }}
            />
          )
        })}

        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        <LeftNavButton
          icon={Globe2}
          label={text('架构', 'Architecture')}
          active={activeRailItem === 'world'}
          disabled={!hasOpenProject}
          title={text('故事架构', 'Story architecture')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('project', 'world')
            openBuiltinEditor('world-building-editor', text('故事架构', 'Story architecture'), 'world-building')
          }}
        />
        <LeftNavButton
          icon={Map}
          label={text('大纲', 'Outline')}
          active={activeRailItem === 'synopsis'}
          disabled={!hasOpenProject}
          title={text('情节大纲', 'Plot outline')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('project', 'synopsis')
            openBuiltinEditor('synopsis-editor', text('情节大纲', 'Plot outline'), 'synopsis')
          }}
        />
        <LeftNavButton
          icon={ListTree}
          label={text('蓝图', 'Plot')}
          active={activeRailItem === 'blueprint'}
          disabled={!hasOpenProject}
          title={text('章节蓝图', 'Chapter blueprint')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('project', 'blueprint')
            openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card')
          }}
        />
        <LeftNavButton
          icon={GitBranch}
          label={text('剧情', 'Plot tree')}
          active={plotTreeActive}
          disabled={!hasOpenProject}
          title={text('剧情树', 'Plot tree')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('project', 'plot-tree')
            openBuiltinEditor(
              'narrative-thread-editor',
              text('剧情树与叙事线索', 'Plot tree & narrative threads'),
              'narrative-thread',
              'plot-tree',
            )
          }}
        />
        <LeftNavButton
          icon={Users}
          label={text('人物', 'Cast')}
          active={activeRailItem === 'characters'}
          disabled={!hasOpenProject}
          title={text('人物', 'Cast')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('characters')
          }}
        />
        <LeftNavButton
          icon={BookOpen}
          label={text('知识库', 'Knowledge')}
          active={activeRailItem === 'knowledge'}
          disabled={!hasOpenProject}
          title={text('知识库', 'Knowledge base')}
          onClick={() => {
            if (!hasOpenProject) return
            setSidebarView('knowledge')
          }}
        />
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* ===== 底部：底部面板 Tab 控制 ===== */}
      <div className="flex flex-col items-center w-full pb-1">
        <div className="writer-nav-divider w-8 mb-1" style={{ height: 1 }} />

        {bottomTabs.map(({ id, icon: Icon, zh, en }) => {
          const label = text(zh, en)
          const isActive = activeRailItem === id
          const showPulse = id === 'tasks' && currentRun &&
            (currentRun.status === 'running' || currentRun.status === 'waiting')

          return (
            <LeftNavButton
              key={id}
              icon={Icon}
              label={label}
              active={isActive}
              title={label}
              pulse={!!showPulse}
              onClick={() => setBottomTab(id)}
            />
          )
        })}

        <div className="writer-nav-divider w-8 my-1" style={{ height: 1 }} />

        <LeftNavButton
          icon={Settings}
          label={text('设置', 'Settings')}
          active={activeRailItem === 'settings'}
          onClick={() => openSettings()}
        />
      </div>
    </div>
  )
}
