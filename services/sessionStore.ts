const DB_NAME = "chatter-analyst-session-db";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const SESSION_KEY = "latest";

type SessionRecord<T> = {
  id: string;
  payload: T;
};

export type PersistSaveStatus = "ok" | "unsupported" | "quota_exceeded" | "error";

const isIndexedDbAvailable = (): boolean =>
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";

const isQuotaExceededError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const name = String((error as any).name || "");
  const message = String((error as any).message || "").toLowerCase();
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    message.includes("quota") ||
    message.includes("storage full")
  );
};

const openDatabase = async (): Promise<IDBDatabase | null> => {
  if (!isIndexedDbAvailable()) {
    return null;
  }

  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
};

export const loadPersistedSession = async <T>(): Promise<T | null> => {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(SESSION_KEY);

    request.onsuccess = () => {
      const record = request.result as SessionRecord<T> | undefined;
      resolve(record?.payload ?? null);
    };
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
};

export const savePersistedSession = async <T>(payload: T): Promise<PersistSaveStatus> => {
  const db = await openDatabase();
  if (!db) return "unsupported";

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put({
      id: SESSION_KEY,
      payload,
    } as SessionRecord<T>);

    request.onsuccess = () => {
      // no-op
    };

    request.onerror = () => {
      const error = request.error;
      if (isQuotaExceededError(error)) {
        resolve("quota_exceeded");
      } else {
        resolve("error");
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve("ok");
    };

    tx.onerror = () => {
      const error = tx.error;
      db.close();
      if (isQuotaExceededError(error)) {
        resolve("quota_exceeded");
      } else {
        resolve("error");
      }
    };

    tx.onabort = () => {
      const error = tx.error;
      db.close();
      if (isQuotaExceededError(error)) {
        resolve("quota_exceeded");
      } else {
        resolve("error");
      }
    };
  });
};

export const clearPersistedSession = async (): Promise<void> => {
  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(SESSION_KEY);

    request.onsuccess = () => {
      // no-op
    };
    request.onerror = () => {
      // no-op
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
};
