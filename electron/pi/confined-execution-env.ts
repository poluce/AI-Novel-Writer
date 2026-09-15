import path from 'node:path'

import { atomicWriteFailureCommitState } from '../security/windows-safe-file-system'

import {
  err,
  ok,
  FileError,
  type Context,
  type ExecutionEnv,
  type ExecutionError,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-agent-core'

/** 原子写实现：抛错时若带 `commitState`，调用方按它决定是否终止本轮。 */
export type AtomicTextWrite = (fullPath: string, content: string) => Promise<void>

export interface ConfinedExecutionEnvOptions {
  /**
   * 提供时，字符串写入走这条原子写路径（与领域写工具同一条），
   * 并跟踪「提交态未知」的路径供 `consumeUnknownCommit` 查询。
   */
  writeTextAtomically?: AtomicTextWrite
}

/**
 * 给 Pi harness 的原生执行工具（read / write / edit / bash）加一层路径围栏。
 *
 * 这些工具只认 `ExecutionEnv`，默认可以读写进程能碰到的任何路径，比应用
 * 现有的边界（ADR 0002：项目内文件，且写操作要用户确认）宽得多。围栏把
 * 文件类操作钉在允许的根目录内，越界一律返回 `permission_denied`——
 * 与 `assertProjectFilePath` 同样的语义：先做词法包含检查，能解析真身时
 * 再对 canonical path 检查一次，防止 junction/symlink 指到外面。
 *
 * 传了 `writeTextAtomically` 时，文件写入与领域工具 `write_file` 共用同一套
 * 提交态语义：要么整份落地，要么不落地；失败且提交态未知时记下来，
 * 让上层按 ADR 0008 终止本轮，而不是让模型自动重写一遍。
 *
 * `exec` 不在这里限制：命令本身由确认卡逐条过用户，且子进程天然不受
 * 文件 API 约束；cwd 由调用方构造 env 时钉死。
 */
export class ConfinedExecutionEnv implements ExecutionEnv {
  private readonly roots: readonly string[]
  /** 写入失败但无法证明没落地的路径；上层读一次就清掉。 */
  private readonly unknownCommits = new Set<string>()

  constructor(
    private readonly inner: ExecutionEnv,
    roots: readonly string[],
    private readonly options: ConfinedExecutionEnvOptions = {},
  ) {
    this.roots = roots.map(root => path.resolve(root))
  }

  get cwd(): string {
    return this.inner.cwd
  }

  absolutePath(target: string, context: Context): Promise<Result<string, FileError>> {
    return this.inner.absolutePath(target, context)
  }

  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.inner.joinPath(parts, context)
  }

  async readTextFile(target: string, context: Context): Promise<Result<string, FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.readTextFile(guarded.value, context) : guarded
  }

  async readTextLines(
    target: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.readTextLines(guarded.value, options, context) : guarded
  }

  async readBinaryFile(target: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.readBinaryFile(guarded.value, context) : guarded
  }

  async writeFile(
    target: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const guarded = await this.guard(target, context, false)
    if (!guarded.ok) return guarded
    const fullPath = guarded.value
    const writeText = this.options.writeTextAtomically
    // 二进制写入没有原子写实现；文本写入走与领域工具同一条路径。
    if (typeof content !== 'string' || !writeText) {
      return this.inner.writeFile(fullPath, content, context)
    }
    try {
      await writeText(fullPath, content)
      this.unknownCommits.delete(fullPath)
      return ok(undefined)
    } catch (error) {
      // 没有 commitState 的失败按「没落地」处理（与领域工具一致）：只有明确
      // 未知时才要求模型停手，避免把普通的权限/路径错误升级成终止。
      const commitState = atomicWriteFailureCommitState(error) ?? 'not_committed'
      if (commitState === 'unknown') this.unknownCommits.add(fullPath)
      return err(new FileError(
        'unknown',
        commitState === 'unknown'
          ? `写入失败且提交态未知，请勿自动重试：「${target}」（${errorMessage(error)}）`
          : `写入失败：「${target}」（${errorMessage(error)}）`,
        fullPath,
      ))
    }
  }

  /**
   * 检查并清除一条「提交态未知」记录。写工具结束时用它决定是否终止本轮；
   * 命中即清除，同一次失败不会连续终止两个回合。
   */
  consumeUnknownCommit(target: string): boolean {
    const resolved = path.resolve(this.inner.cwd, target)
    if (this.unknownCommits.delete(resolved)) return true
    // 大小写/分隔符差异下再比一次规范化路径。
    for (const candidate of this.unknownCommits) {
      if (path.normalize(candidate).toLowerCase() === path.normalize(resolved).toLowerCase()) {
        this.unknownCommits.delete(candidate)
        return true
      }
    }
    return false
  }

  async appendFile(
    target: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const guarded = await this.guard(target, context, false)
    return guarded.ok ? this.inner.appendFile(guarded.value, content, context) : guarded
  }

  async renameFile(
    source: string,
    destination: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const from = await this.guard(source, context, true)
    if (!from.ok) return from
    const to = await this.guard(destination, context, false)
    if (!to.ok) return to
    return this.inner.renameFile(from.value, to.value, context)
  }

  async fileInfo(target: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.fileInfo(guarded.value, context) : guarded
  }

  async listDir(target: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.listDir(guarded.value, context) : guarded
  }

  async canonicalPath(target: string, context: Context): Promise<Result<string, FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.canonicalPath(guarded.value, context) : guarded
  }

  async exists(target: string, context: Context): Promise<Result<boolean, FileError>> {
    const guarded = await this.guard(target, context, false)
    return guarded.ok ? this.inner.exists(guarded.value, context) : guarded
  }

  async createDir(
    target: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const guarded = await this.guard(target, context, false)
    return guarded.ok ? this.inner.createDir(guarded.value, options, context) : guarded
  }

  async remove(
    target: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const guarded = await this.guard(target, context, true)
    return guarded.ok ? this.inner.remove(guarded.value, options, context) : guarded
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempDir(prefix, context)
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.inner.createTempFile(options, context)
  }

  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return this.inner.exec(command, options, context)
  }

  cleanup(context: Context): Promise<void> {
    return this.inner.cleanup(context)
  }

  /** 越界路径一律以 `permission_denied` 返回，绝不抛异常（FileSystem 契约）。 */
  private async guard(
    target: string,
    context: Context,
    existing: boolean,
  ): Promise<Result<string, FileError>> {
    const absolute = await this.inner.absolutePath(target, context)
    if (!absolute.ok) return absolute
    if (!this.inside(absolute.value)) return this.denied(target, absolute.value)
    if (!existing) return absolute
    const canonical = await this.inner.canonicalPath(absolute.value, context)
    if (!canonical.ok) return canonical
    if (!this.inside(canonical.value)) return this.denied(target, canonical.value)
    return absolute
  }

  private inside(target: string): boolean {
    const resolved = path.resolve(target)
    return this.roots.some((root) => {
      const relative = path.relative(root, resolved)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
  }

  private denied(target: string, resolved: string): Result<string, FileError> {
    return err(new FileError(
      'permission_denied',
      `路径越界：「${target}」不在助手可访问的目录内。`,
      resolved,
    ))
  }
}

/** 原子写失败原因：优先用 `commitState` 之外的可读文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
