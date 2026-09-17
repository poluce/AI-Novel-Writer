import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/index.css')
const css = readFileSync(cssPath, 'utf8')
const root = postcss.parse(css, { from: cssPath })

/**
 * 默认（:root）与 .light 共享的浅色运行时调色板。
 * 2026-09-18 起默认浅色主题改为纯白冷灰 + 科技蓝，与 DSH 默认亮色主题对齐；
 * 宣纸墨韵整套移到 .paper，两套皮肤各自完整、互不回落。
 */
const approvedLightPalette = {
  '--color-bg': '#FFFFFF',
  '--color-raised': '#FFFFFF',
  '--color-sidebar': '#F9FAFB',
  '--color-panel': '#F9FAFB',
  '--color-titlebar': '#FFFFFF',
  '--color-activity-bar': '#F3F4F6',
  '--color-hover': '#F3F4F6',
  '--color-active': '#E5E7EB',
  '--color-text': '#0F1115',
  '--color-text-secondary': '#4B5563',
  '--color-text-muted': '#525866',
  '--color-border': '#E5E7EB',
  '--color-accent': '#4176E6',
  '--color-accent-hover': '#3364CB',
  '--color-editor-bg': '#FFFFFF',
  '--color-statusbar': '#F9FAFB',
  '--color-titlebar-text': '#0F1115',
}

const approvedPaperPalette = {
  '--color-bg': '#F7F3E8',
  '--color-raised': '#FCFAF3',
  '--color-sidebar': '#F0EADA',
  '--color-panel': '#F0EADA',
  '--color-titlebar': '#FCFAF3',
  '--color-activity-bar': '#F0EADA',
  '--color-hover': '#EAE3D2',
  '--color-active': '#E3DCC9',
  '--color-text': '#2B2A26',
  '--color-text-secondary': '#6E6A5F',
  '--color-text-muted': '#655F55',
  '--color-border': '#E3DCC9',
  '--color-accent': '#B5402C',
  '--color-accent-hover': '#9A3524',
  '--color-editor-bg': '#FCFAF3',
  '--color-statusbar': '#FCFAF3',
  '--color-titlebar-text': '#2B2A26',
}

const approvedPaletteKeys = new Set([
  ...Object.keys(approvedLightPalette),
  ...Object.keys(approvedPaperPalette),
])

function declarationsFor(selector: string) {
  const declarations: Record<string, string> = {}
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls((declaration: Declaration) => {
      if (declaration.prop.startsWith('--')) declarations[declaration.prop] = declaration.value
    })
  })
  return declarations
}

describe('runtime CSS token authority', () => {
  it('does not expose a second hand-copied TypeScript color-token source', () => {
    expect(existsSync(resolve(process.cwd(), 'src/tokens/index.ts'))).toBe(false)
  })

  it('defines each runtime palette once, on its own theme selectors', () => {
    const paletteRules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
    root.walkRules((rule: Rule) => {
      if (!rule.selectors.some(selector => selector === ':root' || selector === '.paper' || selector === '.light')) return

      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node): node is Declaration => node.type === 'decl' && approvedPaletteKeys.has(node.prop))
          .map(declaration => [declaration.prop, declaration.value]),
      )
      if (Object.keys(declarations).length > 0) paletteRules.push({ selectors: rule.selectors, declarations })
    })

    // 默认与 light 共用一套浅色；paper 自成一套。两边都必须定义完整，
    // 否则缺失的变量会静默回落到另一套皮肤，出现"纸色底 + 白色面板"这类半套皮肤。
    expect(paletteRules).toEqual([
      {
        selectors: [':root', '.light'],
        declarations: approvedLightPalette,
      },
      {
        selectors: ['.paper'],
        declarations: approvedPaperPalette,
      },
    ])
  })

  it.each([
    [':root', approvedLightPalette],
    ['.light', approvedLightPalette],
    ['.paper', approvedPaperPalette],
    ['.galaxy', {
      '--color-bg': '#0A1628',
      '--color-raised': '#0E1B30',
      '--color-sidebar': '#0E1B30',
      '--color-panel': '#0E1B30',
      '--color-titlebar': '#0A1628',
      '--color-activity-bar': '#071220',
      '--color-hover': '#142640',
      '--color-active': '#1C3050',
      '--color-text': '#E0ECF4',
      '--color-text-secondary': '#8BA4BE',
      '--color-text-muted': '#5A7A96',
      '--color-border': '#172B42',
      '--color-accent': '#7EC8E3',
      '--color-accent-hover': '#6AB8D8',
      '--color-editor-bg': '#091525',
      '--color-statusbar': '#071220',
      '--color-titlebar-text': '#8BA4BE',
    }],
    ['.dark', {
      '--color-bg': '#1E1E1E',
      '--color-raised': '#252526',
      '--color-sidebar': '#252526',
      '--color-panel': '#252526',
      '--color-titlebar': '#181818',
      '--color-activity-bar': '#333333',
      '--color-hover': '#2A2D2E',
      '--color-active': '#37373D',
      '--color-text': '#D4D4D4',
      '--color-text-secondary': '#A0A0A0',
      '--color-text-muted': '#888888',
      '--color-border': '#3C3C3C',
      '--color-accent': '#0E639C',
      '--color-accent-hover': '#1177BB',
      '--color-editor-bg': '#1E1E1E',
      '--color-statusbar': '#181818',
      '--color-titlebar-text': '#CCCCCC',
    }],
  ])('locks the approved %s runtime palette', (selector, expected) => {
    expect(declarationsFor(selector)).toMatchObject(expected)
  })
})

describe('writer chrome aliases', () => {
  it('declares the shared semantic aliases once and limits theme overrides to text contrast', () => {
    const aliasRules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
    root.walkRules((rule: Rule) => {
      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node): node is Declaration => node.type === 'decl' && node.prop.startsWith('--writer-'))
          .map(declaration => [declaration.prop, declaration.value]),
      )
      if (Object.keys(declarations).length > 0) aliasRules.push({ selectors: rule.selectors, declarations })
    })

    expect(aliasRules).toEqual([
      expect.objectContaining({ selectors: [':root', '.paper', '.light', '.dark', '.galaxy'] }),
      {
        selectors: [".app-skin-root[data-skin='classic'][data-theme='galaxy']"],
        declarations: {
          '--writer-primary-text': '#0A1628',
          '--writer-brand-mark-text': '#0A1628',
        },
      },
      {
        selectors: [".app-skin-root[data-skin='classic'][data-theme='dark']"],
        declarations: { '--writer-primary-text': '#FFFFFF' },
      },
    ])
  })
})

describe('relationship role semantics', () => {
  it('defines the approved role identity colors once for every runtime theme and image skin', () => {
    const roleRules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
    root.walkRules((rule: Rule) => {
      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node): node is Declaration => node.type === 'decl' && node.prop.startsWith('--color-role-'))
          .map(declaration => [declaration.prop, declaration.value]),
      )
      if (Object.keys(declarations).length > 0) roleRules.push({ selectors: rule.selectors, declarations })
    })

    expect(roleRules).toEqual([{
      selectors: [':root', '.paper', '.light', '.galaxy', '.dark'],
      declarations: {
        '--color-role-protagonist': '#B5402C',
        '--color-role-antagonist': '#54666E',
        '--color-role-supporting': '#527A5B',
        '--color-role-minor': '#A39D8D',
      },
    }])
  })
})

describe('Storybook token documentation', () => {
  it('renders every theme from runtime CSS variables without a hand-copied palette', () => {
    const story = readFileSync(resolve(process.cwd(), 'src/stories/Introduction.mdx'), 'utf8')

    expect(story).not.toMatch(/#[0-9a-f]{6}/i)
    expect(story).toContain("['light', 'galaxy', 'paper', 'dark'].map")
    expect(story).toContain('className={theme}')
    for (const token of [
      '--color-bg',
      '--color-text',
      '--color-accent',
      '--color-success',
      '--color-warning',
      '--color-error',
      '--color-info',
    ]) {
      expect(story).toContain(`var(${token})`)
    }
  })

  it('documents typography and radius through runtime semantic variables only', () => {
    const story = readFileSync(resolve(process.cwd(), 'src/stories/Introduction.mdx'), 'utf8')
    const fontSection = story.match(/### Font Families([\s\S]*?)### Type Scale/)?.[1]
    const radiusSection = story.match(/## Border Radius([\s\S]*?)## Components/)?.[1]

    expect(fontSection).toBeDefined()
    expect(radiusSection).toBeDefined()

    const documentedFontValues = [...(fontSection?.matchAll(/value:\s*'([^']+)'/g) ?? [])]
      .map(match => match[1])
    expect(documentedFontValues).toEqual([
      'var(--font-sans)',
      'var(--font-writing)',
      'var(--font-mono)',
    ])
    for (const token of ['--font-sans', '--font-writing', '--font-mono']) {
      expect(declarationsFor(':root')[token]).toBeDefined()
      expect(fontSection).toContain(`var(${token})`)
    }
    expect(fontSection).not.toMatch(/\b(?:Inter|Noto|LXGW|Fira Code|Consolas|system-ui|ui-monospace)\b/)
    expect(fontSection).not.toMatch(/fontFamily:\s*['"](?!var\(--font-)/)

    const documentedRadiusValues = [...(radiusSection?.matchAll(/value:\s*'([^']+)'/g) ?? [])]
      .map(match => match[1])
    expect(documentedRadiusValues).toEqual([
      'var(--radius-sm)',
      'var(--radius-md)',
      'var(--radius-lg)',
      'var(--radius-xl)',
      'var(--radius-2xl)',
    ])
    for (const token of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl']) {
      expect(declarationsFor(':root')[token]).toBeDefined()
      expect(radiusSection).toContain(`var(${token})`)
    }
    expect(radiusSection).not.toMatch(/\|\s*\d+(?:\.\d+)?(?:px|rem)\s*\|/)
    expect(radiusSection).not.toMatch(/border-?radius\s*[:=]\s*['"]?\d/i)
    expect(story).not.toMatch(/borderRadius:\s*['"]?\d/)
  })
})
