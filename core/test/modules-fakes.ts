import type { Provider } from '../api/policy-jobs.ts'
import type { StorageModule } from '../backend/modules.ts'
import type { Luoshu } from '../backend/providers/luoshu/luoshu.ts'

// A provider fake as the core modules hold the luoshu, its opening and its close doing nothing unless role says
export function luoshuModule(provider: Provider, role: Luoshu['role'] = { open() {} }): Luoshu {
  return { provider, role, close() {} }
}

// A provider fake as the core modules hold storage, opening on the data folder and clearing a space doing nothing
export function storageModule(provider: Provider): StorageModule {
  return Object.assign(provider, { open() {}, clear: async () => {} })
}
