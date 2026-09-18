/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Node 测试加载 better-sqlite3 时改走旁路 .node（当前 Node ABI），
 * 不碰包内 build/Release（Electron ABI）。
 *
 * 只在 Node 测试进程里注册；Electron 主进程不要加载本文件。
 */
'use strict'

const fs = require('fs')
const Module = require('module')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')

function nodeSidecarBindingPath() {
  const key = `node-v${process.versions.modules}-${process.platform}-${process.arch}`
  return path.join(repoRoot, 'node_modules', '.native-abi', 'better-sqlite3', key, 'better_sqlite3.node')
}

function resolveBetterSqlite3Root() {
  const direct = path.join(repoRoot, 'node_modules', 'better-sqlite3')
  const manifest = path.join(direct, 'package.json')
  if (!fs.existsSync(manifest)) {
    throw new Error(`Cannot resolve better-sqlite3 at ${direct}`)
  }
  return fs.realpathSync(direct)
}

function wrapDatabase(Real, sidecarPath) {
  function Database(filename, options) {
    const opts = options && typeof options === 'object' ? { ...options } : {}
    if (opts.nativeBinding == null) {
      opts.nativeBinding = sidecarPath
    }
    if (new.target == null) {
      return new Real(filename, opts)
    }
    return new Real(filename, opts)
  }

  Object.setPrototypeOf(Database, Real)
  Object.setPrototypeOf(Database.prototype, Real.prototype)
  for (const key of Object.getOwnPropertyNames(Real)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue
    const descriptor = Object.getOwnPropertyDescriptor(Real, key)
    if (descriptor) Object.defineProperty(Database, key, descriptor)
  }
  return Database
}

let wrapped

function loadWrapped() {
  if (wrapped) return wrapped
  if (process.versions.electron) {
    throw new Error('register-better-sqlite3-node.cjs must not load inside Electron')
  }
  const sidecarPath = nodeSidecarBindingPath()
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `Missing Node better-sqlite3 sidecar at ${sidecarPath}. Run: pnpm run prepare:native-node`,
    )
  }
  const Real = require(path.join(resolveBetterSqlite3Root(), 'lib', 'index.js'))
  wrapped = wrapDatabase(Real, sidecarPath)
  return wrapped
}

function register() {
  if (globalThis.__VELA_SQLITE_NODE_HOOK__) return
  if (process.versions.electron) return
  globalThis.__VELA_SQLITE_NODE_HOOK__ = true
  const originalLoad = Module._load
  Module._load = function loadBetterSqlite3(request, parent, isMain) {
    if (request === 'better-sqlite3') {
      return loadWrapped()
    }
    return originalLoad.call(this, request, parent, isMain)
  }
}

register()

module.exports = { register, nodeSidecarBindingPath, loadWrapped }
