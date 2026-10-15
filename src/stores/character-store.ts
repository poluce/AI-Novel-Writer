import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectSessionContext } from '../shared/project-session-context'
import {
  isActiveProjectSession,
  matchActiveProjectSession,
} from '../services/active-project'
import type {
  CharacterData,
  CharacterStateData,
} from '../shared/contracts/character'
import { normalizeCharacterRole } from '../shared/character-role'
import {
  characterCardFromRosterEntry,
  characterRosterEntriesFromCards,
} from '../services/character-roster-client'
import { randomUUID } from '../utils/id'
import { useEditorDraftLedgerStore } from './editor-draft-ledger-store'
import {
  CHARACTER_DRAFT_TAB,
  composeEditorDraftTabWriter,
  discardProjectEditorDraft,
  getProjectEditorDraft,
  mergeNamedRecordDraftWithRemote,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  settleProjectEditorSave,
  type ProjectEditorDraftLedger,
} from './project-editor-draft-ledger'
import {
  getCharacterDraftRenames,
  mergeCharacterDraftWithRemote,
  rebuildCharacterRenamesAfterSave,
  setCharacterDraftRenames,
  updateCharacterRename,
} from './character-rename-ledger'

export type CharacterCurrentState = CharacterStateData
export type CharacterCard = CharacterData
type CharacterDraftLedger = ProjectEditorDraftLedger<CharacterCard[]>

export const EMPTY_CARD: CharacterCard = {
  name: '', role: 'supporting', gender: '', age: '',
  appearance: '', personality: '', background: '', abilities: '',
  motivation: '', relationships: '', arc: '', notes: '',
}

export const EMPTY_STATE: CharacterCurrentState = {
  location: '', powerLevel: '', physicalState: '', mentalState: '',
  keyItems: '', recentEvents: '', updatedAtChapter: 0,
}

function textField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : ''
}

function normalizeCharacterState(value: unknown): CharacterCurrentState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  const rawProvenance = state.provenance
  const provenance = rawProvenance && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance)
    ? rawProvenance as CharacterCurrentState['provenance']
    : undefined
  const updatedAtChapter = Number.isInteger(state.updatedAtChapter) && Number(state.updatedAtChapter) >= 0
    ? Number(state.updatedAtChapter)
    : 0
  return {
    location: textField(state, 'location'),
    powerLevel: textField(state, 'powerLevel'),
    physicalState: textField(state, 'physicalState'),
    mentalState: textField(state, 'mentalState'),
    keyItems: textField(state, 'keyItems'),
    recentEvents: textField(state, 'recentEvents'),
    updatedAtChapter,
    ...(provenance ? { provenance } : {}),
  }
}

function normalizeCharacterCards(value: unknown): CharacterCard[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (
      !candidate
      || typeof candidate !== 'object'
      || typeof (candidate as { name?: unknown }).name !== 'string'
    ) return []
    const card = candidate as Record<string, unknown>
    const currentState = normalizeCharacterState(card.currentState)
    const normalizedCard = {
      ...card,
      name: card.name as string,
      role: normalizeCharacterRole(card.role),
      gender: textField(card, 'gender'),
      age: textField(card, 'age'),
      appearance: textField(card, 'appearance'),
      personality: textField(card, 'personality'),
      background: textField(card, 'background'),
      abilities: textField(card, 'abilities'),
      motivation: textField(card, 'motivation'),
      relationships: textField(card, 'relationships'),
      arc: textField(card, 'arc'),
      notes: textField(card, 'notes'),
    } as CharacterCard
    if (currentState) normalizedCard.currentState = currentState
    else delete normalizedCard.currentState
    return [normalizedCard]
  })
}

function readCharacterDraftLedger(projectKey: string): CharacterDraftLedger {
  const ledger = parseProjectEditorDraftLedger<unknown>(
    useEditorDraftLedgerStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
  )
  const projects = ledger.projects.map((project) => {
    if (project.projectKey !== projectKey) return project
    return {
      ...project,
      baseValue: normalizeCharacterCards(project.baseValue),
      draftValue: normalizeCharacterCards(project.draftValue),
    }
  })
  // The ledger is heterogeneous on disk. Only the requested project is ever
  // read through the typed editor helpers; foreign payloads stay opaque and
  // are carried through byte-for-byte at the value level.
  return { version: 1, projects } as CharacterDraftLedger
}

function persistCharacterDraftLedger(ledger: CharacterDraftLedger): void {
  persistProjectEditorDraftLedger(composeEditorDraftTabWriter(), CHARACTER_DRAFT_TAB, ledger)
}

function currentCharacterProjectSession(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): ProjectSessionContext | null {
  return matchActiveProjectSession(expectedProjectPath, expectedProjectSession)
}

function isCharacterProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return isActiveProjectSession(projectSession)
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function removeFirstCharacterNamed(
  characters: readonly CharacterCard[],
  name: string,
): CharacterCard[] {
  const targetIndex = characters.findIndex(character => character.name === name)
  if (targetIndex < 0) return [...characters]
  return characters.filter((_, index) => index !== targetIndex)
}

function resolveSelectedName(
  cards: readonly CharacterCard[],
  selectedName: string | null,
): string | null {
  if (selectedName !== null && cards.some(card => card.name === selectedName)) {
    return selectedName
  }
  return cards[0]?.name ?? null
}

function canMutateMountedRoster(
  state: {
    dataProjectSession: ProjectSessionContext | null
    loadingProjectSession: ProjectSessionContext | null
    lastError: string | null
  },
  projectSession: ProjectSessionContext,
): boolean {
  return sameProjectSessionContext(state.dataProjectSession, projectSession)
    && state.loadingProjectSession === null
    && state.lastError === null
}

interface SessionOperation<T> {
  projectSession: ProjectSessionContext
  promise: Promise<T>
  kind: 'save' | 'rename' | 'delete'
}

let characterSaveInFlight: SessionOperation<void> | null = null
let characterIdentityMutationInFlight: SessionOperation<unknown> | null = null
let characterLoadSequence = 0

function isIdentityMutationInFlight(projectSession: ProjectSessionContext): boolean {
  return characterIdentityMutationInFlight !== null
    && sameProjectSessionContext(characterIdentityMutationInFlight.projectSession, projectSession)
}

function isStaleCharacterLoad(
  projectSession: ProjectSessionContext,
  requestSequence: number,
): boolean {
  return !isCharacterProjectSessionCurrent(projectSession)
    || requestSequence !== characterLoadSequence
}

interface CharacterState {
  characters: CharacterCard[]
  selectedName: string | null
  saving: boolean
  identityBusy: boolean
  loaded: boolean
  /** 当前 characters 数组实际归属的项目；为空时禁止任何角色写操作。 */
  dataProjectKey: string | null
  /** Exact lease whose character data is currently mounted. */
  dataProjectSession: ProjectSessionContext | null
  /** 当前角色卡来自的 roster revision；所有保存都必须带回这一乐观并发令牌。 */
  rosterRevision: number | null
  loadingProjectKey: string | null
  loadingProjectSession: ProjectSessionContext | null
  lastError: string | null

  load: (projectPath?: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
  beginProjectLoad: (projectPath: string) => void
  reset: () => void
  setSelectedName: (name: string | null) => void
  addCharacter: () => void
  deleteCharacter: (
    name: string,
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<boolean>
  clearAllCharacters: (
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<boolean>
  renameCharacter: (name: string, newName: string) => boolean
  discardDraft: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => void
  updateField: <K extends Exclude<keyof CharacterCard, 'name'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => void
  saveAll: (
    projectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
    operationKind?: 'delete',
  ) => Promise<void>
  loadCharacters: (projectPath: string, expectedProjectSession?: ProjectSessionContext) => Promise<void>
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  selectedName: null,
  saving: false,
  identityBusy: false,
  loaded: false,
  dataProjectKey: null,
  dataProjectSession: null,
  rosterRevision: null,
  loadingProjectKey: null,
  loadingProjectSession: null,
  lastError: null,

  load: async (projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession) return
    const requestedProjectKey = projectSession.projectPath
    const requestSequence = ++characterLoadSequence
    if (!sameProjectSessionContext(get().dataProjectSession, projectSession)) {
      set({
        characters: [],
        selectedName: null,
        loaded: false,
        dataProjectKey: null,
        dataProjectSession: null,
        rosterRevision: null,
        loadingProjectKey: requestedProjectKey,
        loadingProjectSession: projectSession,
        lastError: null,
      })
    } else {
      set({
        loadingProjectKey: requestedProjectKey,
        loadingProjectSession: projectSession,
        lastError: null,
      })
    }
    const pendingIdentityMutation = characterIdentityMutationInFlight
    if (
      pendingIdentityMutation
      && sameProjectSessionContext(pendingIdentityMutation.projectSession, projectSession)
    ) {
      try {
        await pendingIdentityMutation.promise
      } catch {
        // 身份操作失败不应永久阻断后续项目加载。
      }
      if (isStaleCharacterLoad(projectSession, requestSequence)) return
    }
    try {
      const roster = await ipc.invokeWithProjectSession(
        projectSession,
        'db:character-roster-read',
        requestedProjectKey,
      )
      if (isStaleCharacterLoad(projectSession, requestSequence)) return

      const draftLedger = readCharacterDraftLedger(requestedProjectKey)
      const cards = normalizeCharacterCards(roster.entries.map(characterCardFromRosterEntry))
      const renames = getCharacterDraftRenames(draftLedger, requestedProjectKey)
      const restored = rebaseProjectEditorDraft(
        draftLedger,
        requestedProjectKey,
        cards,
        function mergeDraft(base, draft, remote) {
          if (renames.length > 0) {
            return mergeCharacterDraftWithRemote(base, draft, remote, renames)
          }
          return mergeNamedRecordDraftWithRemote(base, draft, remote)
        },
      )
      if (getProjectEditorDraft(draftLedger, requestedProjectKey)) {
        persistCharacterDraftLedger(restored.ledger)
      }
      if (isStaleCharacterLoad(projectSession, requestSequence)) return
      const visibleCards = normalizeCharacterCards(restored.value)
      const { selectedName } = get()
      set({
        characters: visibleCards,
        loaded: true,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        rosterRevision: roster.revision,
        loadingProjectKey: null,
        loadingProjectSession: null,
        lastError: null,
        selectedName: resolveSelectedName(visibleCards, selectedName),
      })
    } catch (error) {
      if (isStaleCharacterLoad(projectSession, requestSequence)) return
      set({
        characters: [],
        selectedName: null,
        loaded: false,
        dataProjectKey: requestedProjectKey,
        dataProjectSession: projectSession,
        rosterRevision: null,
        loadingProjectKey: null,
        loadingProjectSession: null,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  },

  loadCharacters: async (projectPath, expectedProjectSession) => {
    await get().load(projectPath, expectedProjectSession)
  },

  beginProjectLoad: (projectPath) => {
    characterLoadSequence += 1
    set({
      characters: [],
      selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      rosterRevision: null,
      loadingProjectKey: projectPath,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  reset: () => {
    characterLoadSequence += 1
    set({
      characters: [],
      selectedName: null,
      saving: false,
      identityBusy: false,
      loaded: false,
      dataProjectKey: null,
      dataProjectSession: null,
      rosterRevision: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
      lastError: null,
    })
  },

  setSelectedName: (name) => {
    const projectSession = currentCharacterProjectSession()
    const state = get()
    if (!projectSession || !canMutateMountedRoster(state, projectSession)) return
    set({ selectedName: name })
  },

  addCharacter: () => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession || isIdentityMutationInFlight(projectSession)) return
    const projectKey = projectSession.projectPath
    const state = get()
    if (!canMutateMountedRoster(state, projectSession)) return
    const before = state.characters
    const newCard: CharacterCard = {
      ...EMPTY_CARD,
      name: `新角色_${Math.random().toString(36).slice(2, 6)}`,
    }
    const characters = [...before, newCard]
    set({ characters, selectedName: newCard.name })
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(projectKey),
      projectKey,
      before,
      characters,
    ))
  },

  deleteCharacter: (name, projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession || isIdentityMutationInFlight(projectSession)) {
      return Promise.resolve(false)
    }
    const projectKey = projectSession.projectPath
    const state = get()
    if (!canMutateMountedRoster(state, projectSession)) return Promise.resolve(false)
    const { characters, selectedName } = state
    if (!characters.some(card => card.name === name)) return Promise.resolve(false)
    const ledger = readCharacterDraftLedger(projectKey)
    const remaining = removeFirstCharacterNamed(characters, name)
    const renames = getCharacterDraftRenames(ledger, projectKey)
    const pendingRename = renames.find(rename => rename.newName === name)
    const nextRenames = pendingRename
      ? renames.filter(rename => rename !== pendingRename)
      : renames
    set({
      characters: remaining,
      selectedName: resolveSelectedName(remaining, selectedName),
    })
    let nextLedger = recordProjectEditorEdit(ledger, projectKey, characters, remaining)
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, nextRenames)
    persistCharacterDraftLedger(nextLedger)

    // 删除同样是完整手工名单保存：由 roster seam 在一次事务中清理关系、
    // 蓝图引用、投影、revision 与 receipt。失败时草稿仍在本地可重试。
    return get().saveAll(projectKey, projectSession, 'delete')
      .then(() => isCharacterProjectSessionCurrent(projectSession))
      .catch(() => false)
  },

  clearAllCharacters: (projectPath, expectedProjectSession) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    if (!projectSession || isIdentityMutationInFlight(projectSession)) {
      return Promise.resolve(false)
    }
    const projectKey = projectSession.projectPath
    const state = get()
    if (!canMutateMountedRoster(state, projectSession)) return Promise.resolve(false)
    const characters = state.characters
    if (characters.length === 0) return Promise.resolve(true)

    const ledger = readCharacterDraftLedger(projectKey)
    set({ characters: [], selectedName: null })
    let nextLedger = recordProjectEditorEdit(ledger, projectKey, characters, [])
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, [])
    persistCharacterDraftLedger(nextLedger)

    // 空名单仍通过既有 roster 原子提交；主进程据此同步删除角色、关系和投影。
    return get().saveAll(projectKey, projectSession, 'delete')
      .then(() => isCharacterProjectSessionCurrent(projectSession))
      .catch(() => false)
  },

  renameCharacter: (name, newName) => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession || isIdentityMutationInFlight(projectSession)) return false
    const projectKey = projectSession.projectPath
    const state = get()
    if (!canMutateMountedRoster(state, projectSession)) return false
    const before = state.characters
    const targetIndex = before.findIndex(character => character.name === name)
    if (targetIndex < 0) return false
    if (before.some((character, index) => index !== targetIndex && character.name === newName)) {
      return false
    }

    const ledger = readCharacterDraftLedger(projectKey)
    const existing = getProjectEditorDraft(ledger, projectKey)
    const renames = getCharacterDraftRenames(ledger, projectKey)
    const persistedNames = new Set((existing?.baseValue ?? before).map(character => character.name))
    const nextRenames = updateCharacterRename(renames, name, newName, persistedNames)
    const characters = before.map((character, index) => (
      index === targetIndex ? { ...character, name: newName } : character
    ))
    set({
      characters,
      selectedName: state.selectedName === name ? newName : state.selectedName,
    })

    let nextLedger = recordProjectEditorEdit(ledger, projectKey, before, characters)
    nextLedger = setCharacterDraftRenames(nextLedger, projectKey, nextRenames)
    persistCharacterDraftLedger(nextLedger)
    return true
  },

  discardDraft: (projectPath, expectedProjectSession) => {
    const ledger = readCharacterDraftLedger(projectPath)
    const projectDraft = getProjectEditorDraft(ledger, projectPath)
    if (!projectDraft) return
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    const state = get()

    if (projectSession && !canMutateMountedRoster(state, projectSession)) return
    if (projectSession && sameProjectSessionContext(state.dataProjectSession, projectSession)) {
      const restored = projectDraft.baseValue
      const selectedRename = getCharacterDraftRenames(ledger, projectPath)
        .find(rename => rename.newName === state.selectedName)
      set({
        characters: restored,
        selectedName: resolveSelectedName(restored, selectedRename?.originalName ?? state.selectedName),
      })
    }

    persistCharacterDraftLedger(discardProjectEditorDraft(ledger, projectPath))
  },

  updateField: (name, key, value) => {
    const projectSession = currentCharacterProjectSession()
    if (!projectSession) return
    const projectKey = projectSession.projectPath
    const state = get()
    if (
      !sameProjectSessionContext(state.dataProjectSession, projectSession)
      || state.lastError !== null
    ) return
    const before = state.characters
    const characters = before.map(card => (
      card.name === name ? { ...card, [key]: value } : card
    ))
    set({ characters })
    persistCharacterDraftLedger(recordProjectEditorEdit(
      readCharacterDraftLedger(projectKey),
      projectKey,
      before,
      characters,
    ))
  },

  saveAll: (projectPath, expectedProjectSession, operationKind) => {
    const projectSession = currentCharacterProjectSession(projectPath, expectedProjectSession)
    const projectKey = projectSession?.projectPath
    const state = get()
    if (
      !projectSession
      || !projectKey
      || !canMutateMountedRoster(state, projectSession)
      || state.rosterRevision === null
    ) {
      return Promise.reject(new Error('角色数据仍在切换项目，已拒绝跨项目保存'))
    }
    const activeSession: ProjectSessionContext = projectSession
    const activeProjectKey: string = projectKey
    if (
      characterSaveInFlight
      && sameProjectSessionContext(characterSaveInFlight.projectSession, activeSession)
    ) {
      if (characterSaveInFlight.kind === 'delete') {
        return Promise.reject(new Error('角色身份操作正在进行（删除中），请等待完成后再保存'))
      }
      return characterSaveInFlight.promise
    }
    if (isIdentityMutationInFlight(activeSession)) {
      return Promise.reject(new Error('角色身份操作正在进行，请稍后再保存'))
    }
    set({ saving: true, identityBusy: true })
    const { characters } = get()
    const expectedRevision = get().rosterRevision
    if (expectedRevision === null) {
      return Promise.reject(new Error('角色名单尚未完成安全读取，已拒绝保存'))
    }
    const committedRevision = expectedRevision
    const saveLedger = readCharacterDraftLedger(activeProjectKey)
    const renames = getCharacterDraftRenames(saveLedger, activeProjectKey)
    const savedCharacters = characters.map(character => ({
      ...character,
      name: character.name.trim(),
    }))
    const savedRenames = renames.map(rename => ({
      originalName: rename.originalName,
      newName: rename.newName.trim(),
    }))
    let saveKind: SessionOperation<void>['kind'] = 'save'
    if (operationKind) saveKind = operationKind
    else if (savedRenames.length > 0) saveKind = 'rename'

    async function save(): Promise<void> {
      // 角色主键改名、删除、蓝图结构化引用、角色图谱、revision 和 receipt
      // 都由主进程 roster seam 在同一事务内完成。
      const result = await ipc.invokeWithProjectSession(
        activeSession,
        'db:character-roster-commit',
        {
          operationId: `manual-character-save-${randomUUID()}`,
          expectedRevision: committedRevision,
          schemaVersion: 1,
          intent: 'manual_edit',
          entries: characterRosterEntriesFromCards(savedCharacters),
          ...(savedRenames.length > 0 ? { renames: savedRenames } : {}),
        },
        activeProjectKey,
      )
      if (!result.success || !result.receipt) {
        throw new Error(result.error ?? '角色卡保存失败')
      }
      if (!isCharacterProjectSessionCurrent(activeSession)) return
      const savedRosterCards = result.receipt.snapshot.entries.map(characterCardFromRosterEntry)
      const ledger = readCharacterDraftLedger(activeProjectKey)
      const currentProjectDraft = getProjectEditorDraft(ledger, activeProjectKey)
      const projectSaveInputStillCurrent = (
        !currentProjectDraft || valuesMatch(currentProjectDraft.draftValue, characters)
      )
      const currentValue = projectSaveInputStillCurrent
        ? savedRosterCards
        : currentProjectDraft.draftValue
      const remainingRenames = rebuildCharacterRenamesAfterSave(
        savedRosterCards,
        currentValue,
        savedRenames,
        getCharacterDraftRenames(ledger, activeProjectKey),
      )
      let settledLedger = settleProjectEditorSave(
        ledger,
        activeProjectKey,
        savedRosterCards,
        currentValue,
      )
      settledLedger = setCharacterDraftRenames(settledLedger, activeProjectKey, remainingRenames)
      if (!isCharacterProjectSessionCurrent(activeSession)) return
      persistCharacterDraftLedger(settledLedger)

      if (
        projectSaveInputStillCurrent
        && valuesMatch(get().characters, characters)
      ) {
        set({
          characters: savedRosterCards,
          rosterRevision: result.receipt.revision,
        })
      } else if (isCharacterProjectSessionCurrent(activeSession)) {
        set({ rosterRevision: result.receipt.revision })
      }
    }
    const trackedSave = save().finally(() => {
      if (characterSaveInFlight?.promise === trackedSave) {
        characterSaveInFlight = null
      }
      if (characterIdentityMutationInFlight?.promise === trackedSave) {
        characterIdentityMutationInFlight = null
      }
      if (isCharacterProjectSessionCurrent(activeSession)) {
        set({ saving: false, identityBusy: false })
      }
    })
    characterSaveInFlight = { projectSession: activeSession, promise: trackedSave, kind: saveKind }
    characterIdentityMutationInFlight = { projectSession: activeSession, promise: trackedSave, kind: saveKind }
    return trackedSave
  },
}))
