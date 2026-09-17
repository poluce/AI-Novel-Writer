import { describe, expect, it } from 'vitest'

import { SETTINGS_SECTIONS } from '../SettingsModal'

describe('settings appearance navigation seam', () => {
  it('exposes Appearance alongside the existing settings areas', () => {
    const appearance = SETTINGS_SECTIONS.find((section) => section.id === 'appearance')

    expect(appearance).toMatchObject({
      id: 'appearance',
      label: '外观',
      labelEn: 'Appearance',
    })
  })

  it('exposes Presets alongside the existing settings areas', () => {
    const presets = SETTINGS_SECTIONS.find((section) => section.id === 'presets')

    expect(presets).toMatchObject({
      id: 'presets',
      label: '预设',
      labelEn: 'Presets',
    })
  })
})
