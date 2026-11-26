import { ComponentType, lazy } from "react";

const CHUNK_RELOAD_KEY = "radar_chunk_reload_at";
const RELOAD_COOLDOWN_MS = 15000;

export function isModuleLoadError(error: unknown): boolean {
  const msg = String(
    (error as any)?.message || (error as any)?.toString?.() || error || "",
  ).toLowerCase();

  return (
    msg.includes("valid javascript mime type") ||
    msg.includes("text/html") ||
    msg.includes("failed to fetch dynamically imported module") ||
    msg.includes("importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("loading chunk") ||
    msg.includes("chunkloaderror")
  );
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await importer();
    } catch (error) {
      if (typeof window !== "undefined" && isModuleLoadError(error)) {
        try {
          const lastReloadRaw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
          const lastReload = lastReloadRaw ? Number(lastReloadRaw) : 0;
          const now = Date.now();
          if (!lastReload || now - lastReload > RELOAD_COOLDOWN_MS) {
            window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
            window.location.reload();
            return await new Promise<{ default: T }>(() => {});
          }
        } catch {
          // If sessionStorage is blocked, fall through to ErrorBoundary
        }
      }
      throw error;
    }
  });
}
