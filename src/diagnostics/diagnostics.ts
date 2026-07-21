import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../utils/security.js";

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  error?: string;
  projectId?: string;
  resolvedRuntimeModel?: string;
  availableModels?: string;
  matchedModelDebug?: string;
};

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();

/** Last completed request snapshot for `/antigravity.doctor`. */
let lastSnapshot: DiagnosticsSnapshot = {};

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

/** Run work with an isolated diagnostics bag; commits it to `lastSnapshot` when done. */
export async function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

/** Read endpoint from the active request bag (or last snapshot outside a request). */
export function getCurrentEndpoint(): string | undefined {
  return currentBag().endpoint;
}

export function getCurrentMatchedModelDebug(): string | undefined {
  return currentBag().matchedModelDebug;
}

export function getCurrentAvailableModels(): string | undefined {
  return currentBag().availableModels;
}

export function setLastStatus(status: number | undefined): void {
  currentBag().status = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  currentBag().endpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  currentBag().error = error === undefined ? undefined : redactSecrets(error).slice(0, 800);
}
export function setLastProjectId(projectId: string | undefined): void {
  currentBag().projectId = projectId;
}
export function setLastResolvedRuntimeModel(model: string | undefined): void {
  currentBag().resolvedRuntimeModel = model;
}
export function setLastAvailableModels(models: string | undefined): void {
  currentBag().availableModels = models;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  currentBag().matchedModelDebug =
    debug === undefined ? undefined : redactSecrets(debug).slice(0, 1200);
}

/** Test helper: reset last snapshot between cases. */
export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
}
