export interface OfflineActivityQueueItem {
  id: string;
  kioskName: string;
  checkerName: string;
  items: any[];
  queuedAt: number;
  retryCount: number;
  lastError?: string;
}

const OFFLINE_QUEUE_KEY = "radar_offline_activity_queue_v1";
const HOME_DRAFT_KEY = "radar_home_unsaved_drafts_v1";
export const OFFLINE_QUEUE_EVENT = "radar-offline-queue-changed";

function notifyQueueChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT));
  }
}

export function getOfflineActivityQueue(): OfflineActivityQueueItem[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOfflineActivityQueue(list: OfflineActivityQueueItem[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list));
    }
  } catch {
    // ignore storage quota errors
  }
  notifyQueueChanged();
}

export function enqueueOfflineActivity(params: {
  kioskName: string;
  checkerName: string;
  items: any[];
  lastError?: string;
}): OfflineActivityQueueItem {
  const existing = getOfflineActivityQueue();
  const cleanKiosk = String(params.kioskName || "").trim().toLowerCase();
  const cleanChecker = String(params.checkerName || "").trim().toLowerCase();

  // Coalesce latest snapshot for the same kiosk + checker so repeated offline saves stay clean
  const filtered = existing.filter(
    (entry) =>
      !(
        String(entry.kioskName || "").trim().toLowerCase() === cleanKiosk &&
        String(entry.checkerName || "").trim().toLowerCase() === cleanChecker
      ),
  );

  const item: OfflineActivityQueueItem = {
    id: `off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    kioskName: params.kioskName,
    checkerName: params.checkerName,
    items: params.items,
    queuedAt: Date.now(),
    retryCount: 0,
    lastError: params.lastError,
  };

  filtered.push(item);
  writeOfflineActivityQueue(filtered);
  return item;
}

export function removeOfflineActivityById(id: string): void {
  const existing = getOfflineActivityQueue();
  const next = existing.filter((item) => item.id !== id);
  writeOfflineActivityQueue(next);
}

export function markOfflineActivityRetry(id: string, errMsg?: string): void {
  const existing = getOfflineActivityQueue();
  const next = existing.map((item) =>
    item.id === id
      ? {
          ...item,
          retryCount: (item.retryCount || 0) + 1,
          lastError: errMsg || item.lastError,
        }
      : item,
  );
  writeOfflineActivityQueue(next);
}

export function saveHomeUnsavedDrafts(items: any[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const dirty = (items || []).filter(
      (i) =>
        i &&
        (i.isNew ||
          i.isEdited ||
          (i.condition && i.condition !== "tetap") ||
          String(i.user || "").trim().toLowerCase() !==
            String(i.originalUser || "").trim().toLowerCase()),
    );
    if (dirty.length === 0) {
      localStorage.removeItem(HOME_DRAFT_KEY);
    } else {
      localStorage.setItem(HOME_DRAFT_KEY, JSON.stringify(dirty));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function loadHomeUnsavedDrafts(): any[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(HOME_DRAFT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearHomeUnsavedDraftsForKiosk(kioskName?: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!kioskName) {
      localStorage.removeItem(HOME_DRAFT_KEY);
      return;
    }
    const target = String(kioskName).trim().toLowerCase();
    const current = loadHomeUnsavedDrafts();
    const remaining = current.filter(
      (item) => String(item?.kiosk || "").trim().toLowerCase() !== target,
    );
    if (remaining.length === 0) {
      localStorage.removeItem(HOME_DRAFT_KEY);
    } else {
      localStorage.setItem(HOME_DRAFT_KEY, JSON.stringify(remaining));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function isLikelyNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || "").toLowerCase();
  const code = String((err as any)?.code || "").toLowerCase();
  return (
    (typeof navigator !== "undefined" && !navigator.onLine) ||
    code.includes("unavailable") ||
    code.includes("deadline-exceeded") ||
    msg.includes("offline") ||
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("unavailable") ||
    msg.includes("aborted")
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage = "Request timed out due to weak signal",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
