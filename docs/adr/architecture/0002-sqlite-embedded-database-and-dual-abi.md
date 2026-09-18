# 架构 ADR 0002：SQLite 嵌入式存储与 Node/Electron 跨环境双 ABI 共存架构

- 状态：已采纳（现行系统基石，对应 commit `2ebb8cf`）
- 领域：持久化数据底座 / 原生编译模块与测试流水线

## 背景

长篇小说创作需要管理海量结构化元数据（分卷分章目录、定稿版本快照、角色名册与关系演进、细纲蓝图、审稿历史报告、研习档案等）。同时，桌面应用需要频繁在主进程中执行高并发测试与本地运行。

在此背景下，项目面临两个底层技术挑战：
1. **数据库选型**：纯 JSON 文本文件无法提供 ACID 事务保证，且随着正文字数增加，全量序列化会拖垮应用性能；而外部网络数据库违背“本地优先”原则；
2. **C++ 原生模块 ABI 冲突死锁**：Node.js C++ 原生扩展（如 `better-sqlite3`）与特定的 `NODE_MODULE_VERSION`（ABI）强绑定。Electron 41 运行时的内部 Node ABI 与开发者终端运行 Vitest 测试所使用的纯 Node.js CLI ABI 完全不一致。传统做法在每次运行测试前必须重新编译覆盖二进制文件，不仅耗时，更会导致开着的桌面应用因为文件被占用（EBUSY）或 ABI 版本不匹配而瞬间崩溃闪退。

## 决策

### 1. 存储底座选型：嵌入式 SQLite + `better-sqlite3`
* **每个小说项目独立单库**：每个小说工程根目录下维护专属的 `.vela/vela.db`，跟随工程文件夹整体迁移或备份；
* **为什么选 `better-sqlite3` 而非异步库**：
  * **真同步写入（Synchronous I/O）**：小说章节保存、定稿状态冻结必须具备强一致性。`better-sqlite3` 是 Node 生态中性能最强、延迟极低的同步 C++ 绑定，消除了异步 Promise 队列在进程突然退出时的“幽灵写入”风险；
  * **零 IPC 序列化开销**：在主进程中直接通过 C++ 内存指针读写 SQLite，无需额外经过子进程通信序列化；
  * **原子事务保障（ACID Transactions）**：在定稿发布、角色图谱投影时，通过 `db.transaction()` 保证多表更新要么全部成功，要么全部回滚。

### 2. 跨环境双 ABI 二进制物理共存方案
彻底废除“测试前覆盖编译、测试后切回编译”的脆弱往复流程，构建两份原生二进制物理并存机制：
* **Electron 桌面端**：固定使用 npm 安装的主路径：`node_modules/better-sqlite3/build/Release/better_sqlite3.node`（适配 Electron ABI）；
* **Node.js 测试环境（Vitest）**：使用独立的旁路缓存目录：`node_modules/.native-abi/better-sqlite3/`（适配当前纯 Node.js ABI）；
* **自动化旁路准备器（`scripts/native-abi.mjs`）**：
  * 自动探测当前 Node 运行时的 ABI 标签；
  * 若旁路已存在匹配的 Node 二进制则直接复用；若缺失则自动按需拉取或构建至旁路目录，**绝对不触碰与覆写 Electron 的 `build/Release` 目录**；
* **测试运行时动态钩子（`scripts/register-better-sqlite3-node.cjs`）**：
  * Vitest 启动时通过 `setupFiles` 注入 `Module._load` 拦截钩子，将测试环境中对 `better-sqlite3` 原生扩展的加载定向引流至 `.native-abi/` 旁路；
  * 应用桌面端正常运行与终端跑数百个单元测试完全并发隔离，**互不占用、互不干扰、永不闪退**。

## 后果与权衡

* **收益**：
  * 根治了 Electron 开发中最头疼的 Native 模块 ABI 冲突顽疾；
  * 单元测试运行极速秒启，不再有编译等待；创作者开着软件进行写作时，开发或测试完全可以同步运行；
* **代价**：在 `scripts/` 下增加了约 200 行用于维护旁路检测和模块重定向的工程胶水代码。
