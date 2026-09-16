/**
 * Version the persisted prose-count contract so existing cached counts can be
 * migrated instead of mixing algorithms inside one project.
 */
export const DRAFT_UNIT_ALGORITHM_VERSION = 3

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/gu
const UNICODE_WORD_PATTERN = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}[\p{L}\p{M}]*)*/gu
const WHITESPACE_OR_PUNCTUATION_OR_SYMBOL_PATTERN = /[\s\p{P}\p{S}]/gu

/**
 * Count the visible prose unit used by chapter targets, storage, and UI.
 *
 * - Every Han code point counts as one, including non-BMP extensions.
 * - Words in any Unicode script count as one, so accented Latin text is not
 *   split into an ASCII word plus one or more stray characters.
 * - Digits and other non-word visible code points retain the historical
 *   per-code-point behavior.
 * - Whitespace, punctuation, and symbols (including emoji) do not count.
 */
export function countDraftUnits(text: string): number {
  const normalized = text.normalize('NFC')
  const hanCharacters = normalized.match(HAN_CHARACTER_PATTERN)?.length ?? 0
  const withoutHan = normalized.replace(HAN_CHARACTER_PATTERN, ' ')
  const words = withoutHan.match(UNICODE_WORD_PATTERN)?.length ?? 0
  const otherVisibleCodePoints = [...withoutHan
    .replace(UNICODE_WORD_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_OR_SYMBOL_PATTERN, '')]
    .length
  return hanCharacters + words + otherVisibleCodePoints
}
