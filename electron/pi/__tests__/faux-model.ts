import type { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import type { PiChatModel } from '../pi-models'

type FauxProvider = ReturnType<typeof fauxProvider>

/**
 * pi-ai's faux provider types its model as `Model<string>` because the test
 * double accepts any API name, while the app streams through the concrete
 * `PiChatModel` union. The faux model only ever reaches pi-ai's own stream
 * function, so the narrowing is sound; keep the cast in one place instead of
 * widening the production runtime type back to a bare `string` API.
 */
export function fauxChatModel(faux: FauxProvider): PiChatModel {
  return faux.getModel() as unknown as PiChatModel
}
