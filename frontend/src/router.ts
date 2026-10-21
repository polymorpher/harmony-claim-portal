import { useSyncExternalStore, type MouseEvent } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => normalizePath(window.location.pathname),
    () => "/",
  );
}

export function useSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
}

/** Client-side navigation, which keeps WalletConnect and Ledger sessions that a reload would drop. */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

/** onClick for an <a href>: plain left clicks navigate in place, modified clicks keep browser behaviour. */
export function onNavigate(path: string) {
  return (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };
}
