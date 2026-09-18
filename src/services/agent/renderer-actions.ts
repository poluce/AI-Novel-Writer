import type { RendererAction, RendererActionResult } from '../../shared/agent-events'
import { globalEventBus } from '../../shared/event-bus'
import { logFailure } from '../../shared/fail-log'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'

/**
 * 主进程工具要求渲染层做的编排（开编辑器、刷新项目、改草稿）。
 * 不放进 agent-store：那是会话状态，不是跨店用例。
 */
export async function handleRendererAction(action: RendererAction): Promise<RendererActionResult | void> {
  switch (action.type) {
    case 'open_editor': {
      if (action.target === 'builtin') {
        const { openBuiltinEditor } = await import('../../components/panels/sidebar/sidebar-file-openers')
        const uiText = useLocaleStore.getState().text
        const builtin = {
          config: null,
          blueprints: ['chapter-card-editor', uiText('章节蓝图', 'Chapter blueprints'), 'chapter-card'],
          characters: ['character-editor', uiText('角色管理', 'Characters'), 'character'],
          architecture: ['world-building-editor', uiText('故事架构', 'Story architecture'), 'world-building'],
          synopsis: ['synopsis-editor', uiText('情节大纲', 'Plot outline'), 'synopsis'],
        } as const
        const entry = builtin[action.editor]
        if (entry === null) {
          useEditorStore.getState().openFile({
            id: 'config',
            name: uiText('小说配置', 'Novel configuration'),
            type: 'config',
            projectKey: useProjectStore.getState().currentProject?.path ?? '',
          })
          return
        }
        openBuiltinEditor(entry[0], entry[1], entry[2])
        return
      }
      useEditorStore.getState().openFile({
        id: `agent-${Date.now()}`,
        name: action.fileName,
        type: 'outline',
        filePath: action.filePath,
        content: action.content,
        savedContent: action.content,
        projectKey: useProjectStore.getState().currentProject?.path ?? '',
      })
      return
    }
    case 'replace_draft_excerpt': {
      const { applyDraftExcerptReplace } = await import('./apply-draft-excerpt')
      try {
        return await applyDraftExcerptReplace({
          chapterNumber: action.chapterNumber,
          oldText: action.oldText,
          newText: action.newText,
          draftId: action.draftId,
        })
      } catch (error) {
        logFailure('Agent', 'replace_draft_excerpt failed', error, {
          chapterNumber: action.chapterNumber,
        })
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    case 'refresh_project_config': {
      const project = useProjectStore.getState().currentProject
      if (!project) return
      void useProjectStore.getState().reloadNovelConfig().catch((error) => {
        logFailure('Agent', 'reloadNovelConfig failed', error)
      })
      void useProjectStore.getState().refreshFileTree(project.path).catch((error) => {
        logFailure('Agent', `${action.type} refresh failed`, error)
      })
      return
    }
    case 'refresh_blueprint': {
      const project = useProjectStore.getState().currentProject
      if (!project) return
      void useProjectStore.getState().refreshFileTree(project.path).catch((error) => {
        logFailure('Agent', `${action.type} refresh failed`, error)
      })
      return
    }
    case 'refresh_architecture': {
      const project = useProjectStore.getState().currentProject
      if (!project) return
      const projectSession = projectSessionContextFromProject(project)
      if (!projectSession) return
      const files = action.section === 'premise'
        ? ['premise.md']
        : action.section === 'worldbuilding'
          ? ['worldbuilding.md']
          : action.section === 'synopsis'
            ? ['synopsis.md']
            : ['premise.md', 'worldbuilding.md', 'synopsis.md']
      for (const fileName of files) {
        globalEventBus.emit('ARCH_FILE_UPDATED', {
          fileName,
          projectPath: project.path,
          projectSession,
          runId: `agent-${Date.now()}`,
        })
      }
    }
  }
}
