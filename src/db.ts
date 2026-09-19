import type { Plan } from './types';

const DB_NAME = 'WeddingSeatingPlanner';
const DB_VERSION = 2;
const STORE_NAME = 'plans';
const TRASH_STORE_NAME = 'trash';

export type TrashedPlan = {
  id: string;
  deletedAt: number;
  plan: Plan;
};

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
    };
  });
}

// 旧版本数据没有 createdAt，读取时用 updatedAt 兜底
function normalizePlan(plan: Plan): Plan {
  return { ...plan, createdAt: plan.createdAt ?? plan.updatedAt };
}

export async function getAllPlans(): Promise<Plan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Plan[]).map(normalizePlan));
    req.onerror = () => reject(req.error);
  });
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const plan = req.result as Plan | undefined;
      resolve(plan ? normalizePlan(plan) : undefined);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function savePlan(plan: Plan): Promise<void> {
  const db = await openDB();
  const now = Date.now();
  const toSave = { ...plan, createdAt: plan.createdAt ?? plan.updatedAt ?? now, updatedAt: now };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(toSave);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// 删除不直接抹掉，先移入回收站，删错了还能捞回来
export async function movePlanToTrash(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TRASH_STORE_NAME], 'readwrite');
    const plansStore = tx.objectStore(STORE_NAME);
    const trashStore = tx.objectStore(TRASH_STORE_NAME);
    const getReq = plansStore.get(id);
    getReq.onsuccess = () => {
      const plan = getReq.result as Plan | undefined;
      if (!plan) return;
      const entry: TrashedPlan = { id: plan.id, deletedAt: Date.now(), plan: normalizePlan(plan) };
      trashStore.put(entry);
      plansStore.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getTrashedPlans(): Promise<TrashedPlan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE_NAME, 'readonly');
    const store = tx.objectStore(TRASH_STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as TrashedPlan[]);
    req.onerror = () => reject(req.error);
  });
}

// 从回收站恢复，保留方案原本的创建/更新时间
export async function restorePlan(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TRASH_STORE_NAME], 'readwrite');
    const plansStore = tx.objectStore(STORE_NAME);
    const trashStore = tx.objectStore(TRASH_STORE_NAME);
    const getReq = trashStore.get(id);
    getReq.onsuccess = () => {
      const entry = getReq.result as TrashedPlan | undefined;
      if (!entry) return;
      plansStore.put(normalizePlan(entry.plan));
      trashStore.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 彻底删除，无法恢复
export async function deleteTrashedPlan(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRASH_STORE_NAME, 'readwrite');
    const store = tx.objectStore(TRASH_STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
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
