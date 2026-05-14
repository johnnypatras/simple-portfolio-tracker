import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// localStorage polyfill — vitest's jsdom env doesn't always wire up Storage,
// and we don't want test behavior to depend on Node's experimental --localstorage-file.
// Components that read/write localStorage need this to behave deterministically.
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  } satisfies Storage;
}

const storage = makeStorage();
if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", { value: storage, writable: true, configurable: true });
}
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, writable: true, configurable: true });
}

afterEach(() => {
  cleanup();
});
