import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import { Badge } from '../../ui/Badge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  document.documentElement.classList.remove('paper', 'light', 'galaxy', 'dark')
})

describe('readable warning copy', () => {
  // 默认（light）皮肤 2026-09-18 起改为纯白冷灰调色板：警示 / 成功 / 错误文字
  // 取新的一套高对比值（6.9:1 / 7.1:1 / 6.5:1），paper 仍是墨色一套。
  it.each([
    ['light', 'rgb(133, 77, 14)'],
    ['paper', 'rgb(122, 84, 20)'],
    ['galaxy', 'rgb(251, 191, 36)'],
    ['dark', 'rgb(204, 167, 0)'],
  ])('renders warning badge copy with readable %s theme text', async (theme, expectedText) => {
    container = document.createElement('div')
    container.className = theme
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Badge variant="warning">需要处理</Badge>))

    expect(getComputedStyle(container.querySelector('span')!).color).toBe(expectedText)
  })

  it.each([
    ['light', 'rgb(23, 32, 51)'],
    ['paper', 'rgb(34, 29, 23)'],
    ['galaxy', 'rgb(245, 250, 255)'],
    ['dark', 'rgb(250, 250, 250)'],
  ])('maps %s image-skin warning copy to its high-contrast text semantic', async (theme, expectedText) => {
    container = document.createElement('div')
    container.className = theme
    container.dataset.theme = theme
    container.dataset.skinReadability = 'high-contrast'
    container.classList.add('app-skin-root')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Badge variant="warning">需要处理</Badge>))

    expect(getComputedStyle(container.querySelector('span')!).color).toBe(expectedText)
  })

  it.each([
    ['light', 'rgb(22, 101, 52)', 'rgb(185, 28, 28)'],
    ['paper', 'rgb(56, 96, 66)', 'rgb(143, 48, 32)'],
    ['galaxy', 'rgb(74, 222, 128)', 'rgb(251, 113, 133)'],
    ['dark', 'rgb(137, 209, 133)', 'rgb(255, 138, 138)'],
  ])('renders success and error badge information with readable %s theme semantics', async (theme, successText, errorText) => {
    container = document.createElement('div')
    container.className = theme
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<><Badge variant="success">Success</Badge><Badge variant="error">Error</Badge></>))

    const badges = container.querySelectorAll('span')
    expect(getComputedStyle(badges[0]).color).toBe(successText)
    expect(getComputedStyle(badges[1]).color).toBe(errorText)
  })
})
