export interface ArchFile {
  key: string
  fileName: string
  label: string
  iconName: string
  desc: string
}

/**
 * 故事架构（前提概要 / 人物 / 环境 / 情节）的四个子文件。
 */
export const ARCH_FILES: ArchFile[] = [
  { key: 'premise', fileName: 'premise.md', label: '前提概要', iconName: 'target', desc: 'Logline、核心冲突、金手指定位' },
  { key: 'characters', fileName: 'characters.md', label: '人物', iconName: 'users', desc: '角色弧光、关系网、矛盾交织' },
  { key: 'worldbuilding', fileName: 'worldbuilding.md', label: '环境', iconName: 'globe', desc: '核心规则、阶层断层、深层危机' },
  { key: 'synopsis', fileName: 'synopsis.md', label: '情节', iconName: 'map', desc: '三幕结构、拐点节奏、伏笔闭环' },
]
