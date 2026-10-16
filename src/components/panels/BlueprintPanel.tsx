import { useEffect } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import AgentHeader from './agent/AgentHeader'
import AgentConversation from './agent/AgentConversation'

/**
 * 右侧 AI 章节蓝图助手面板（Chapter Blueprint Designer）
 * 专职单章与连章细纲规划、场景节拍设计、前文伏笔承接与章末悬念编排
 * - 顶部：AgentHeader（专属蓝图助手标题与会话管理）
 * - 主体：AgentConversation（专属蓝图助手空状态/推演历史）
 */
export default function BlueprintPanel() {
  const init = useLLMStore(s => s.init)
  const loaded = useLLMStore(s => s.loaded)
  useEffect(() => {
    if (!loaded) init()
  }, [init, loaded])

  return (
    <div className="writer-ai-panel w-full h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏（蓝图助手模式） */}
      <AgentHeader assistantType="blueprint" />

      {/* 主对话区：占满剩余高度 */}
      <div className="flex-1 overflow-hidden">
        <AgentConversation assistantType="blueprint" />
      </div>
    </div>
  )
}
