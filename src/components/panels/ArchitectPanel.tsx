import { useEffect } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import AgentHeader from './agent/AgentHeader'
import AgentConversation from './agent/AgentConversation'

/**
 * 右侧 AI 架构助手面板（Chief Story Architect）
 * 专职故事大纲构思、世界观设定、人物关系规划与章节细纲蓝图推演
 * - 顶部：AgentHeader（专属架构助手标题与会话管理）
 * - 主体：AgentConversation（专属架构助手空状态/推演历史）
 */
export default function ArchitectPanel() {
  const init = useLLMStore(s => s.init)
  const loaded = useLLMStore(s => s.loaded)
  useEffect(() => {
    if (!loaded) init()
  }, [init, loaded])

  return (
    <div className="writer-ai-panel w-full h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏（架构助手模式） */}
      <AgentHeader assistantType="architect" />

      {/* 主对话区：占满剩余高度 */}
      <div className="flex-1 overflow-hidden">
        <AgentConversation assistantType="architect" />
      </div>
    </div>
  )
}
