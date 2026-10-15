import { create } from 'zustand'

/** 左侧活动栏的视图类型 */
export type SidebarView = 'home' | 'project' | 'knowledge' | 'characters' | 'settings'

/** 下方工具窗口 Tab */
export type BottomTab = 'tasks' | 'log' | 'models'

/** 右侧面板视图类型 */
export type RightView = 'agent' | 'ai-output'

/** 左侧主导航当前视觉激活项 */
export type LeftRailItem = SidebarView | 'blueprint' | 'world' | 'synopsis' | 'plot-tree' | BottomTab

const SETTINGS_SECTION_IDS = [
  'appearance',
  'llm',
  'embedding',
  'presets',
  'proxy',
  'editor',
  'prompts',
  'skills',
  'mcp',
  'about',
] as const

/** 设置弹窗分类 */
export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number]

/** 章节创建对话框的预填参数 */
export type ChapterCreationPrefill = Record<string, unknown> | null

interface LayoutState {
  // ===== 侧边栏 =====
  sidebarOpen: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  activeRailItem: LeftRailItem

  // ===== AI 对话面板 =====
  aiPanelOpen: boolean
  aiPanelWidth: number
  /** 右侧面板当前视图：Agent 对话 / AI 输出 */
  rightView: RightView

  // ===== 底部面板 =====
  bottomPanelOpen: boolean
  bottomTab: BottomTab
  bottomPanelHeight: number

  // ===== 全局弹窗状态（替代 window.dispatchEvent 事件总线）=====
  /** 设置弹窗是否打开 */
  settingsOpen: boolean
  /** 设置弹窗打开时默认定位的分类 */
  settingsSection: SettingsSection
  /** 新建项目对话框是否打开 */
  newProjectOpen: boolean
  /** 导出对话框是否打开 */
  exportOpen: boolean
  /** 导入小说对话框是否打开 */
  importNovelOpen: boolean
  /** 作者原稿导入对话框是否打开 */
  authorManuscriptImportOpen: boolean
  /** 小说拆解研习对话框是否打开 */
  novelDeconstructionOpen: boolean
  /** 章节创建对话框是否打开 */
  chapterCreationOpen: boolean
  /** 章节创建对话框的预填参数 */
  chapterCreationPrefill: ChapterCreationPrefill

  // ===== Actions =====
  toggleSidebar: () => void
  setSidebarView: (view: SidebarView, activeRailItem?: LeftRailItem) => void
  setSidebarWidth: (width: number) => void
  toggleAIPanel: () => void
  setAIPanelOpen: (open: boolean) => void
  setAIPanelWidth: (width: number) => void
  setRightView: (view: RightView) => void
  /** 打开右侧面板并切换到指定视图 */
  openRightPanel: (view: RightView) => void
  toggleBottomPanel: () => void
  setBottomTab: (tab: BottomTab) => void
  setBottomPanelHeight: (height: number) => void
  openBottomTab: (tab: BottomTab) => void

  // ===== 全局弹窗 Actions =====
  openSettings: (section?: SettingsSection, activeRailItem?: LeftRailItem) => void
  closeSettings: () => void
  openNewProject: () => void
  closeNewProject: () => void
  openExport: () => void
  closeExport: () => void
  openImportNovel: () => void
  closeImportNovel: () => void
  openAuthorManuscriptImport: () => void
  closeAuthorManuscriptImport: () => void
  openNovelDeconstruction: () => void
  closeNovelDeconstruction: () => void
  openChapterCreation: (prefill?: ChapterCreationPrefill) => void
  closeChapterCreation: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && SETTINGS_SECTION_IDS.includes(value as SettingsSection)
}

function resolveSettingsSection(section: unknown): SettingsSection {
  if (isSettingsSection(section)) return section
  return 'appearance'
}

function resolveSettingsRailItem(activeRailItem: unknown): LeftRailItem {
  if (typeof activeRailItem === 'string') return activeRailItem as LeftRailItem
  return 'settings'
}

function nextPanelOpen(sameButton: boolean, currentlyOpen: boolean): boolean {
  if (sameButton) return !currentlyOpen
  return true
}

function novelImportState(open: boolean): Pick<LayoutState, 'importNovelOpen' | 'novelDeconstructionOpen'> {
  return { importNovelOpen: open, novelDeconstructionOpen: open }
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  // 默认值
  sidebarOpen: true,
  sidebarView: 'project',
  sidebarWidth: 260,
  activeRailItem: 'project',

  aiPanelOpen: true,
  aiPanelWidth: 320,
  rightView: 'agent',

  bottomPanelOpen: false,
  bottomTab: 'tasks',
  bottomPanelHeight: 200,

  // 全局弹窗默认关闭
  settingsOpen: false,
  settingsSection: 'appearance',
  newProjectOpen: false,
  exportOpen: false,
  importNovelOpen: false,
  authorManuscriptImportOpen: false,
  novelDeconstructionOpen: false,
  chapterCreationOpen: false,
  chapterCreationPrefill: null,

  // Actions
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarView: (view, activeRailItem) =>
    set((s) => {
      const nextRailItem = activeRailItem ?? view
      const sameButton = s.sidebarView === view && s.activeRailItem === nextRailItem
      return {
        sidebarView: view,
        activeRailItem: nextRailItem,
        sidebarOpen: nextPanelOpen(sameButton, s.sidebarOpen),
      }
    }),
  setSidebarWidth: (width) => set({ sidebarWidth: clamp(width, 200, 500) }),

  toggleAIPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setAIPanelOpen: (open) => set({ aiPanelOpen: open }),
  setAIPanelWidth: (width) => set({ aiPanelWidth: clamp(width, 260, 600) }),
  setRightView: (view) => set({ rightView: view }),
  openRightPanel: (view) => set({ aiPanelOpen: true, rightView: view }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setBottomTab: (tab) =>
    set((s) => {
      const sameButton = s.bottomTab === tab && s.activeRailItem === tab
      return {
        bottomTab: tab,
        activeRailItem: tab,
        bottomPanelOpen: nextPanelOpen(sameButton, s.bottomPanelOpen),
      }
    }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: clamp(height, 100, 500) }),
  openBottomTab: (tab) => set({ bottomPanelOpen: true, bottomTab: tab, activeRailItem: tab }),

  // 全局弹窗 Actions
  openSettings: (section, activeRailItem) => {
    set({
      settingsOpen: true,
      settingsSection: resolveSettingsSection(section),
      activeRailItem: resolveSettingsRailItem(activeRailItem),
    })
  },
  closeSettings: () => set({ settingsOpen: false }),
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openImportNovel: () => set(novelImportState(true)),
  closeImportNovel: () => set(novelImportState(false)),
  openAuthorManuscriptImport: () => set({ authorManuscriptImportOpen: true }),
  closeAuthorManuscriptImport: () => set({ authorManuscriptImportOpen: false }),
  openNovelDeconstruction: () => set(novelImportState(true)),
  closeNovelDeconstruction: () => set(novelImportState(false)),
  openChapterCreation: (prefill = null) => set({ chapterCreationOpen: true, chapterCreationPrefill: prefill }),
  closeChapterCreation: () => set({ chapterCreationOpen: false, chapterCreationPrefill: null }),
}))
