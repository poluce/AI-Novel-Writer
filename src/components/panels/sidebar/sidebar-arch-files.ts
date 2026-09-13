export interface ArchFile {
  key: string
  fileName: string
  label: string
  iconName: string
  desc: string
}

/**
 * 故事架构（故事前提 / 角色图谱 / 世界观）的三个子文件。
 *
 * 情节大纲已拆出为与故事架构并列的一级条目，不再属于这里。
 */
export const ARCH_FILES: ArchFile[] = [
  { key: 'premise', fileName: 'premise.md', label: '故事前提', iconName: 'target', desc: 'Logline、核心冲突、金手指定位' },
  { key: 'characters', fileName: 'characters.md', label: '角色图谱', iconName: 'users', desc: '角色弧光、关系网、矛盾交织' },
  { key: 'worldbuilding', fileName: 'worldbuilding.md', label: '世界观', iconName: 'globe', desc: '核心规则、阶层断层、深层危机' },
]
