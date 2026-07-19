const DB_NAME = 'sharp-e2ee'
const DB_VERSION = 1

export type E2eeStore = 'keys' | 'trust' | 'messages'

let databasePromise: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of ['keys', 'trust', 'messages'] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open E2EE storage'))
    request.onblocked = () => reject(new Error('E2EE storage upgrade is blocked'))
  })
  return databasePromise
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('E2EE storage request failed'))
  })
}

export async function idbGet<T>(store: E2eeStore, key: IDBValidKey): Promise<T | undefined> {
  const db = await database()
  return result<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(key))
}

export async function idbPut<T>(store: E2eeStore, key: IDBValidKey, value: T): Promise<void> {
  const db = await database()
  await result(db.transaction(store, 'readwrite').objectStore(store).put(value, key))
}

export async function idbDelete(store: E2eeStore, key: IDBValidKey): Promise<void> {
  const db = await database()
  await result(db.transaction(store, 'readwrite').objectStore(store).delete(key))
}

export async function idbClear(store: E2eeStore): Promise<void> {
  const db = await database()
  await result(db.transaction(store, 'readwrite').objectStore(store).clear())
}

export async function idbGetAll<T>(store: E2eeStore): Promise<T[]> {
  const db = await database()
  return result<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll())
}
