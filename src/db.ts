import type { Plan, TrashedPlan } from './types';
import { generateId } from './utils';

const DB_NAME = 'WeddingSeatingPlanner';
const DB_VERSION = 2;
const STORE_NAME = 'plans';
const TRASH_STORE_NAME = 'trashedPlans';

export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 回收站保留 30 天
const TRASH_MAX = 50; // 回收站最多保留 50 份，超出时先彻底删除最早删除的

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRASH_STORE_NAME)) {
        db.createObjectStore(TRASH_STORE_NAME, { keyPath: 'id' });
      }
      // v1 -> v2：老数据没有 createdAt，用 updatedAt 兜底补一份
      if (e.oldVersion < 2) {
        const store = req.transaction!.objectStore(STORE_NAME);
        const all = store.getAll();
        all.onsuccess = () => {
          for (const raw of all.result as Plan[]) {
            if (typeof raw.createdAt !== 'number') {
              raw.createdAt = raw.updatedAt;
              store.put(raw);
            }
          }
        };
      }
    };
  });
}

// 除创建/更新时间外的方案内容，用来判断本次保存是否真的改过
function planContentEqual(a: Plan, b: Plan): boolean {
  return (
    a.name === b.name &&
    JSON.stringify(a.tables) === JSON.stringify(b.tables) &&
    JSON.stringify(a.guests) === JSON.stringify(b.guests) &&
    JSON.stringify(a.rules) === JSON.stringify(b.rules)
  );
}

export async function getAllPlans(): Promise<Plan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Plan[]).map(normalizeTimestamps));
    req.onerror = () => reject(req.error);
  });
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () =>
      resolve(req.result ? normalizeTimestamps(req.result as Plan) : undefined);
    req.onerror = () => reject(req.error);
  });
}

function normalizeTimestamps(p: Plan): Plan {
  return {
    ...p,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : p.updatedAt,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : p.createdAt,
  };
}

export async function savePlan(plan: Plan): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(plan.id);
    getReq.onsuccess = () => {
      const existing = getReq.result as Plan | undefined;
      const now = Date.now();
      const toSave: Plan = existing
        ? {
            ...plan,
            createdAt:
              typeof existing.createdAt === 'number'
                ? existing.createdAt
                : plan.createdAt ?? existing.updatedAt ?? now,
            // 内容没变化（如页面加载触发的自动保存）不刷新“最后改动时间”
            updatedAt: planContentEqual(normalizeTimestamps(existing), plan)
              ? existing.updatedAt
              : now,
          }
        : { ...plan, createdAt: plan.createdAt ?? now, updatedAt: plan.updatedAt ?? now };
      store.put(toSave);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 软删除：方案移入回收站，之后还能从本地捞回来
export async function movePlanToTrash(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TRASH_STORE_NAME], 'readwrite');
    const planStore = tx.objectStore(STORE_NAME);
    const trashStore = tx.objectStore(TRASH_STORE_NAME);

    const getReq = planStore.get(id);
    getReq.onsuccess = () => {
      const plan = getReq.result as Plan | undefined;
      if (!plan) return;
      const trashed: TrashedPlan = { ...normalizeTimestamps(plan), deletedAt: Date.now() };
      trashStore.put(trashed);
      planStore.delete(id);

      // 顺手清理：超过 30 天的、以及超出数量上限的最早记录一并彻底删除
      const allReq = trashStore.getAll();
      allReq.onsuccess = () => {
        const items = (allReq.result as TrashedPlan[])
          .slice()
          .sort((a, b) => a.deletedAt - b.deletedAt);
        const cutoff = Date.now() - TRASH_TTL_MS;
        const expired = items.filter((p) => p.deletedAt < cutoff);
        const overflowCount = Math.max(0, items.length - expired.length - TRASH_MAX);
        expired.push(...items.filter((p) => p.deletedAt >= cutoff).slice(0, overflowCount));
        for (const p of expired) trashStore.delete(p.id);
      };
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllTrashed(): Promise<TrashedPlan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE_NAME, 'readonly');
    const req = tx.objectStore(TRASH_STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve((req.result as TrashedPlan[]).sort((a, b) => b.deletedAt - a.deletedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function restoreTrashedPlan(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TRASH_STORE_NAME], 'readwrite');
    const planStore = tx.objectStore(STORE_NAME);
    const trashStore = tx.objectStore(TRASH_STORE_NAME);

    const getReq = trashStore.get(id);
    getReq.onsuccess = () => {
      const trashed = getReq.result as TrashedPlan | undefined;
      if (!trashed) return;
      const { deletedAt, ...plan } = trashed;
      void deletedAt;
      const putExisting = () => planStore.put(plan);
      // 极端情况下 id 与现有方案撞了，换新 id 再恢复
      const dupReq = planStore.get(plan.id);
      dupReq.onsuccess = () => {
        if (dupReq.result) {
          plan.id = generateId();
        }
        putExisting();
        trashStore.delete(id);
      };
      dupReq.onerror = () => reject(dupReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function purgeTrashedPlan(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE_NAME, 'readwrite');
    tx.objectStore(TRASH_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function emptyTrash(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE_NAME, 'readwrite');
    tx.objectStore(TRASH_STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function setRecentPlanId(id: string) {
  try {
    localStorage.setItem('recentPlanId', id);
  } catch {}
}

export function getRecentPlanId(): string | null {
  try {
    return localStorage.getItem('recentPlanId');
  } catch {
    return null;
  }
}
