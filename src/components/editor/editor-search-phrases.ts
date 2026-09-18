/**
 * CodeMirror 搜索/替换面板的界面文案。
 *
 * 这些词条由 CodeMirror 内部按固定英文键取值，必须覆盖官方的大小写变体，
 * 所以集中在这里维护；非中文界面返回空表，回落官方英文。
 */
import type { Locale } from '../../i18n/types'

export function buildSearchPhrases(locale: Locale): Record<string, string> {
  if (locale !== 'zh-CN') return {}
  return {
    "Find": "查找",
    "find": "查找",
    "Replace": "替换",
    "replace": "替换",
    "Replace all": "全部替换",
    "replace all": "全部替换",
    "Next": "下一个",
    "next": "下一个",
    "Previous": "上一个",
    "previous": "上一个",
    "All": "全部选中",
    "all": "全部选中",
    "Match case": "区分大小写",
    "match case": "区分大小写",
    "Regexp": "正则表达式",
    "regexp": "正则表达式",
    "by word": "全词匹配",
    "By word": "全词匹配",
    "Close": "关闭",
    "close": "关闭"
  }
}
