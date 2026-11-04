import { ChatMessage } from '../shared/types';

export interface OutboxRecord {
  clientMsgId: string;
  channelId: string;
  content: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mediaMeta: ChatMessage['mediaMeta'];
  createdAt: string;
}

/**
 * Browser IndexedDB offline store with graceful in-memory fallback for restricted iframe contexts.
 */
export class BrowserSyncStore {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private readonly fallbackMessages = new Map<string, ChatMessage>();
  private readonly fallbackOutbox = new Map<string, OutboxRecord>();
  private fallbackCursor = '0';

  constructor(userId: string, deviceId: string) {
    this.dbName = `pulsewire_${userId}_${deviceId}`;
  }

  private getDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('messages')) {
            const store = db.createObjectStore('messages', { keyPath: 'clientMsgId' });
            store.createIndex('by_channel', 'channelId', { unique: false });
          }
          if (!db.objectStoreNames.contains('outbox')) {
            db.createObjectStore('outbox', { keyPath: 'clientMsgId' });
          }
          if (!db.objectStoreNames.contains('cursors')) {
            db.createObjectStore('cursors', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  public async getCursor(): Promise<string> {
    const db = await this.getDb();
    if (!db) return this.fallbackCursor;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('cursors', 'readonly');
        const req = tx.objectStore('cursors').get('cur_max_message_id');
        req.onsuccess = () => resolve(req.result?.value ?? this.fallbackCursor);
        req.onerror = () => resolve(this.fallbackCursor);
      } catch {
        resolve(this.fallbackCursor);
      }
    });
  }

  public async setCursor(cursor: string): Promise<void> {
    this.fallbackCursor = cursor;
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('cursors', 'readwrite');
        tx.objectStore('cursors').put({ key: 'cur_max_message_id', value: cursor });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async persistMessages(messages: readonly ChatMessage[]): Promise<void> {
    for (const m of messages) {
      this.fallbackMessages.set(m.clientMsgId, m);
    }
    const db = await this.getDb();
    if (!db || messages.length === 0) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        for (const m of messages) {
          store.put(m);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async enqueueOutbox(record: OutboxRecord): Promise<void> {
    this.fallbackOutbox.set(record.clientMsgId, record);
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async removeOutbox(clientMsgId: string): Promise<void> {
    this.fallbackOutbox.delete(clientMsgId);
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').delete(clientMsgId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async listOutbox(): Promise<OutboxRecord[]> {
    const db = await this.getDb();
    if (!db) return Array.from(this.fallbackOutbox.values());

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('outbox', 'readonly');
        const req = tx.objectStore('outbox').getAll();
        req.onsuccess = () => resolve((req.result as OutboxRecord[]) ?? []);
        req.onerror = () => resolve(Array.from(this.fallbackOutbox.values()));
      } catch {
        resolve(Array.from(this.fallbackOutbox.values()));
      }
    });
  }
}
