import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadWritingSkillCatalog } from '../writing-skill-catalog'

const roots: string[] = []

function temporaryDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** 造一个技能目录：`<root>/<name>/SKILL.md`。 */
function writeSkill(root: string, dirName: string, markdown: string): string {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8')
  return dir
}

function userRoot(): string {
  return temporaryDir('vela-skill-catalog-')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 清理失败不该让用例变红。
    }
  }
})

describe('loadWritingSkillCatalog', () => {
  it('loads a spec-shaped skill with the app extras from frontmatter', async () => {
    const root = userRoot()
    writeSkill(root, 'scene-craft', `---
name: scene-craft
display_name: 场景塑造
description: 以有后果的选择推进场景。
version: 1.2.0
language: zh-CN
stage: drafting
---
每个场景围绕一次有代价的选择展开。`)

    const catalog = await loadWritingSkillCatalog({ userRoot: root })

    expect(catalog.diagnostics).toEqual([])
    expect(catalog.skills).toHaveLength(1)
    expect(catalog.skills[0]).toMatchObject({
      name: 'scene-craft',
      description: '以有后果的选择推进场景。',
      content: '每个场景围绕一次有代价的选择展开。',
      source: 'user',
      displayName: '场景塑造',
      version: '1.2.0',
      language: 'zh-CN',
      stage: 'drafting',
      compatible: true,
    })
    expect(catalog.skills[0].baseDir).toBe(path.join(root, 'scene-craft'))
    expect(catalog.skills[0].filePath).toBe(path.join(root, 'scene-craft', 'SKILL.md'))
  })

  it('parses YAML frontmatter the way the spec expects', async () => {
    const root = userRoot()
    // 引号会被 YAML 解析器去掉；块标量折叠成一行——自家行解析器做不到这两条。
    writeSkill(root, 'quoted-skill', `---
name: "quoted-skill"
description: >
  A folded description
  spanning two lines
---
Body.`)

    const [skill] = (await loadWritingSkillCatalog({ userRoot: root })).skills

    expect(skill.name).toBe('quoted-skill')
    expect(skill.description).toBe('A folded description spanning two lines\n')
  })

  it('reports spec violations as diagnostics instead of dropping the skill', async () => {
    const root = userRoot()
    writeSkill(root, 'scene-craft', `---
name: SceneCraft
description: 名字与目录不一致，而且用了大写。
---
正文。`)
    writeSkill(root, 'too-long', `---
name: too-long
description: ${'x'.repeat(1100)}
---
正文。`)

    const catalog = await loadWritingSkillCatalog({ userRoot: root })
    const messages = catalog.diagnostics.map(diagnostic => diagnostic.message).join('\n')

    expect(catalog.skills.map(skill => skill.name).sort()).toEqual(['SceneCraft', 'too-long'])
    expect(messages).toContain('does not match parent directory')
    expect(messages).toContain('description exceeds')
    expect(catalog.diagnostics.every(diagnostic => diagnostic.code === 'invalid_metadata')).toBe(true)
  })

  it('honours frontmatter disable-model-invocation', async () => {
    const root = userRoot()
    writeSkill(root, 'internal-notes', `---
name: internal-notes
description: 只给用户手动调用。
disable-model-invocation: true
---
正文。`)

    const [skill] = (await loadWritingSkillCatalog({ userRoot: root })).skills
    expect(skill.disableModelInvocation).toBe(true)
  })

  it('loads a root-level markdown file with skill frontmatter', async () => {
    const root = userRoot()
    fs.writeFileSync(path.join(root, 'loose-skill.md'), `---
name: loose-skill
description: 直接把 .md 放在技能根目录。
---
正文。`, 'utf8')

    const catalog = await loadWritingSkillCatalog({ userRoot: root })
    expect(catalog.skills.map(skill => skill.name)).toEqual(['loose-skill'])
  })

  it('skips dot directories and honours ignore files', async () => {
    const root = userRoot()
    writeSkill(root, 'kept-skill', '---\nname: kept-skill\ndescription: 保留。\n---\n正文。')
    writeSkill(root, '.hidden-skill', '---\nname: hidden-skill\ndescription: 点目录。\n---\n正文。')
    writeSkill(root, 'ignored-skill', '---\nname: ignored-skill\ndescription: 被忽略。\n---\n正文。')
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-skill/\n', 'utf8')

    const names = (await loadWritingSkillCatalog({ userRoot: root })).skills.map(skill => skill.name)
    expect(names).toContain('kept-skill')
    expect(names).not.toContain('hidden-skill')
    expect(names).not.toContain('ignored-skill')
  })

  it('keeps our compatibility verdict for prompt-only writing skills', async () => {
    const root = userRoot()
    writeSkill(root, 'unsafe-skill', `---
name: unsafe-skill
description: 需要跑脚本。
stage: drafting
---
Run scripts/install.js before writing.`)

    const [skill] = (await loadWritingSkillCatalog({ userRoot: root })).skills
    expect(skill.compatible).toBe(false)
    expect(skill.reasons).toContain('script-dependency')
    expect(skill.suggestedStage).toBe('drafting')
  })

  it('loads project skills next to user skills and tags each source', async () => {
    const root = userRoot()
    const projectPath = temporaryDir('vela-skill-project-')
    writeSkill(root, 'user-skill', '---\nname: user-skill\ndescription: 用户级。\n---\n正文。')
    writeSkill(path.join(projectPath, '.vela', 'skills'), 'project-skill', '---\nname: project-skill\ndescription: 项目级。\n---\n正文。')

    const catalog = await loadWritingSkillCatalog({ userRoot: root, projectPath })
    const byName = new Map(catalog.skills.map(skill => [skill.name, skill]))

    expect(byName.get('user-skill')?.source).toBe('user')
    expect(byName.get('project-skill')?.source).toBe('project')
  })

  it('returns nothing (and does not throw) when the roots are missing', async () => {
    const catalog = await loadWritingSkillCatalog({
      userRoot: path.join(os.tmpdir(), 'vela-missing-skills-root'),
      projectPath: path.join(os.tmpdir(), 'vela-missing-skills-project'),
    })
    expect(catalog).toEqual({ skills: [], diagnostics: [] })
  })

  it('refuses a symlinked user skills root', async () => {
    const parent = temporaryDir('vela-skill-link-')
    const real = path.join(parent, 'real-skills')
    fs.mkdirSync(real)
    writeSkill(real, 'linked-skill', '---\nname: linked-skill\ndescription: 链接。\n---\n正文。')
    const link = path.join(parent, 'skills')
    try {
      fs.symlinkSync(real, link, 'dir')
    } catch {
      return // 平台不支持符号链接（例如未开权限的 Windows）时跳过。
    }

    const catalog = await loadWritingSkillCatalog({ userRoot: link })
    expect(catalog.skills).toEqual([])
  })
})
