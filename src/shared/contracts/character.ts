import type { CharacterRole } from '../character-role'
import type { CharacterRosterCharacterState } from '../character-roster'

export type CharacterStateData = CharacterRosterCharacterState

export interface CharacterData {
  name: string
  role: CharacterRole
  gender: string
  age: string
  appearance: string
  personality: string
  background: string
  abilities: string
  motivation: string
  relationships: string
  arc: string
  notes: string
  currentState?: CharacterStateData
}

export interface CharacterRenameData {
  originalName: string
  newName: string
}
