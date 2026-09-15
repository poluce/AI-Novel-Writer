import path from 'node:path'

import {
  err,
  FileError,
  type Context,
  type ExecutionEnv,
  type ExecutionError,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-agent-core'

/**
 * 给 Pi harness 的原生执行工具（read / write / edit / bash）加一层路径围栏。
 *
 * 这些工具只认 `ExecutionEnv`，默认可以读写进程能碰到的任何路径，比应用
 * 现有的边界（ADR 0002：项目内文件，且写操作要用户确认）宽得多。围栏把
 * 文件类操作钉在允许的根目录内，越界一律返回 `permission_denied`——
 * 与 `assertProjectFilePath` 同样的语义：先做词法包含检查，能解析真身时
 * 再对 canonical path 检查一次，防止 junction/symlink 指到外面。
 *
 * `exec` 不在这里限制：命令本身由确认卡逐条过用户，且子进程天然不受
 * 文件 API 约束；cwd 由调用方构造 env 时钉死。
 */
export class ConfinedExecutionEnv implements ExecutionEnv {
  private readonly roots: readonly string[]

  constructor(
    private readonly inner: ExecutionEnv,
    roots: readonly string[],
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
    return guarded.ok ? this.inner.writeFile(guarded.value, content, context) : guarded
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
