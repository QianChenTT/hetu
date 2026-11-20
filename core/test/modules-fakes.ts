import type { Provider } from '../api/policy-jobs.ts'
import type { StorageModule } from '../backend/modules/header.ts'
import type { CoreModules } from '../backend/modules/modules.ts'
import { buildModules } from '../backend/wire.ts'
import type { Luoshu } from '../backend/providers/luoshu/luoshu.ts'

// A provider fake as the core modules hold the luoshu, its opening and its close doing nothing unless role says
export function luoshuModule(provider: Provider, role: Luoshu['role'] = { open() {} }): Luoshu {
  return { provider, role, close() {}, calls: () => 0 }
}

// A provider fake as the core modules hold storage, opening on the data folder and clearing a space doing nothing
export function storageModule(provider: Provider): StorageModule {
  return Object.assign(provider, { open() {}, clear: async () => {} })
}

// The core modules as wireCore makes them, through its own builder: each the real one unless the test hands its own
export function realModules(options: Parameters<typeof buildModules>[0] | Omit<Parameters<typeof buildModules>[0], 'publish'>): CoreModules {
  return buildModules({ publish: () => {}, ...options })
}
