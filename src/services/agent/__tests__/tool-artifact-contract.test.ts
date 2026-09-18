import { describe, expect, it } from 'vitest'

import {
  artifactFromToolResult,
  createToolArtifact,
  type ToolArtifact,
} from '../../../shared/agent-artifacts'

const session = { projectId: 'p', projectPath: 'C:\\novels\\p' }
const context = { projectPath: session.projectPath, projectSession: session }

describe('ToolArtifact contract', () => {
  it('requires observable workflow receipt fields', () => {
    const artifact: ToolArtifact = createToolArtifact({
      type: 'workflow_started',
      name: '写稿',
      projectPath: session.projectPath,
      projectSession: session,
      runId: 'run-1',
      status: 'running',
    })
    expect(artifact.type === 'workflow_started' && artifact.runId).toBe('run-1')
  })

  it('freezes the artifact and its project session', () => {
    const artifact = createToolArtifact({
      type: 'file_modified',
      name: 'notes.md',
      path: 'C:\\novels\\p\\notes.md',
      projectPath: session.projectPath,
      projectSession: session,
    })
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.projectSession)).toBe(true)
  })
})

describe.skip('compile-time invalid artifact examples', () => {
  it('rejects structurally incomplete or mixed artifacts', () => {
  // @ts-expect-error A workflow receipt without runId/status can never report success.
  createToolArtifact({ type: 'workflow_started', name: 'invalid', projectPath: session.projectPath, projectSession: session })
  // @ts-expect-error File artifacts cannot masquerade as workflow receipts.
  createToolArtifact({ type: 'file_modified', name: 'notes.md', path: 'notes.md', projectPath: session.projectPath, projectSession: session, runId: 'run-1', status: 'running' })
  })
})

describe('artifactFromToolResult', () => {
  it('builds a file card only for a committed write', () => {
    const writeArtifact = artifactFromToolResult('write', {
      path: 'C:\\novels\\p\\chapter1.md',
    }, context)
    expect(writeArtifact).toMatchObject({ type: 'file_modified', name: 'chapter1.md', path: 'C:\\novels\\p\\chapter1.md' })

    const editArtifact = artifactFromToolResult('edit', {
      path: 'C:\\novels\\p\\chapter2.md',
    }, context)
    expect(editArtifact).toMatchObject({ type: 'file_modified', name: 'chapter2.md', path: 'C:\\novels\\p\\chapter2.md' })

    expect(artifactFromToolResult('write', { path: 'notes.md', commitState: 'not_committed' }, context)).toBeNull()
  })

  it('builds a tab card for both builtin pages and project files', () => {
    expect(artifactFromToolResult('open_editor', { name: '情节大纲', editor: 'synopsis' }, context))
      .toMatchObject({ type: 'tab_opened', name: '情节大纲' })
    expect(artifactFromToolResult('open_editor', { name: 'notes.md', path: 'C:\\novels\\p\\notes.md' }, context))
      .toMatchObject({ type: 'tab_opened', name: 'notes.md', path: 'C:\\novels\\p\\notes.md' })
    expect(artifactFromToolResult('open_editor', {}, context)).toBeNull()
  })

  it('never builds a card without a frozen project session or for read-only tools', () => {
    expect(artifactFromToolResult('write', { name: 'notes.md', path: 'x', commitState: 'committed' }, {
      projectPath: session.projectPath,
      projectSession: null,
    })).toBeNull()
    expect(artifactFromToolResult('read_architecture', { premise: 'x' }, context)).toBeNull()
    expect(artifactFromToolResult('replace_draft_excerpt', { chapterNumber: 1 }, context)).toBeNull()
  })
})
