import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { defaultProjectId } from "../client/client.js";
import type { AntigravityApiKey, AntigravityOAuthCredentials } from "../types/types.js";
import { refreshAntigravityToken } from "./oauth.js";

const ACCOUNTS_FILE = "antigravity-accounts.json";
const AUTH_FILE = "auth.json";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type StoredAccount = AntigravityOAuthCredentials & {
  accountId: string;
  addedAt: number;
  lastUsedAt: number;
};

type AccountsFile = {
  version: 1;
  activeAccountId?: string;
  accounts: Record<string, StoredAccount>;
};

export type AccountSummary = {
  accountId: string;
  email?: string;
  active: boolean;
  lastUsedAt: number;
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function accountsPath(): string {
  return join(agentDir(), ACCOUNTS_FILE);
}

function authPath(): string {
  return join(agentDir(), AUTH_FILE);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

function emptyStore(): AccountsFile {
  return { version: 1, accounts: {} };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<StoredAccount>;
  return typeof account.refresh === "string" && account.refresh.length > 0;
}

function normalizeStore(value: Record<string, unknown> | undefined): AccountsFile {
  if (!value || value.version !== 1 || !value.accounts || typeof value.accounts !== "object") {
    return emptyStore();
  }
  const accounts: Record<string, StoredAccount> = {};
  for (const [key, raw] of Object.entries(value.accounts as Record<string, unknown>)) {
    if (!isStoredAccount(raw)) continue;
    const accountId =
      typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId : key;
    accounts[accountId] = { ...raw, accountId };
  }
  const activeAccountId =
    typeof value.activeAccountId === "string"
      ? value.activeAccountId
      : typeof value.activeEmail === "string"
        ? value.activeEmail
        : undefined;
  return {
    version: 1,
    activeAccountId: activeAccountId && accounts[activeAccountId] ? activeAccountId : undefined,
    accounts,
  };
}

export function loadAccountStore(): AccountsFile {
  return normalizeStore(readJsonObject(accountsPath()));
}

function saveAccountStore(store: AccountsFile): void {
  writePrivateJson(accountsPath(), store);
}

function accountIdFor(credentials: OAuthCredentials): string {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  if (email) return email;
  return `account-${createHash("sha256").update(credentials.refresh).digest("hex").slice(0, 16)}`;
}

function accountFromCredentials(
  credentials: AntigravityOAuthCredentials,
  existing?: StoredAccount,
): StoredAccount {
  const now = Date.now();
  return {
    ...credentials,
    accountId: existing?.accountId || accountIdFor(credentials),
    addedAt: existing?.addedAt || now,
    lastUsedAt: now,
  };
}

function sortedAccounts(store: AccountsFile): StoredAccount[] {
  return Object.values(store.accounts).sort((a, b) => {
    if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
    return a.accountId.localeCompare(b.accountId);
  });
}

function findAccount(
  store: AccountsFile,
  credentials: OAuthCredentials,
): StoredAccount | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  return Object.values(store.accounts).find(
    (account) =>
      account.refresh === credentials.refresh ||
      (email !== undefined && account.email?.trim().toLowerCase() === email),
  );
}

function findAccountId(store: AccountsFile, selector: string): string | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return undefined;
  const entries = sortedAccounts(store);
  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= entries.length) return entries[index - 1]?.accountId;
    return undefined;
  }
  return entries.find(
    (account) =>
      account.accountId.toLowerCase() === normalized ||
      account.email?.trim().toLowerCase() === normalized,
  )?.accountId;
}

function readAuthFile(): Record<string, unknown> {
  const path = authPath();
  if (!existsSync(path)) return {};
  const parsed = readJsonObject(path);
  if (!parsed) {
    throw new Error("Refusing to overwrite unreadable Pi auth.json");
  }
  return parsed;
}

function writeActiveCredential(account: StoredAccount | undefined): void {
  const auth = readAuthFile();
  if (account) {
    auth.antigravity = {
      type: "oauth",
      email: account.email,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      projectId: account.projectId,
    };
  } else {
    delete auth.antigravity;
  }
  writePrivateJson(authPath(), auth);
}

function currentAuthCredentials(): AntigravityOAuthCredentials | undefined {
  const current = readJsonObject(authPath())?.antigravity;
  if (!current || typeof current !== "object") return undefined;
  const record = current as Record<string, unknown>;
  if (typeof record.refresh !== "string" || !record.refresh) return undefined;
  return {
    access: typeof record.access === "string" ? record.access : "",
    refresh: record.refresh,
    expires: typeof record.expires === "number" ? record.expires : 0,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
}

export function syncCurrentAuth(): void {
  const credentials = currentAuthCredentials();
  if (!credentials) return;
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing);
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
}

export function rememberAccount(credentials: AntigravityOAuthCredentials): StoredAccount {
  syncCurrentAuth();
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing);
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  return account;
}

export function updateRememberedAccount(
  previous: OAuthCredentials,
  credentials: AntigravityOAuthCredentials,
): void {
  const store = loadAccountStore();
  const existing = findAccount(store, previous);
  if (!existing) return;
  const account = accountFromCredentials(credentials, existing);
  delete store.accounts[existing.accountId];
  store.accounts[account.accountId] = account;
  if (store.activeAccountId === existing.accountId) {
    store.activeAccountId = account.accountId;
  }
  saveAccountStore(store);
}

export function listAccounts(): AccountSummary[] {
  syncCurrentAuth();
  const store = loadAccountStore();
  return sortedAccounts(store).map((account) => ({
    accountId: account.accountId,
    email: account.email,
    active: account.accountId === store.activeAccountId,
    lastUsedAt: account.lastUsedAt,
  }));
}

async function ensureFresh(account: StoredAccount): Promise<StoredAccount> {
  if (account.access && account.expires > Date.now() + REFRESH_SKEW_MS) return account;
  return accountFromCredentials(await refreshAntigravityToken(account), account);
}

function apiKeyFor(account: StoredAccount): AntigravityApiKey {
  const email = account.email?.trim();
  return {
    token: account.access,
    projectId: account.projectId || defaultProjectId(email || "antigravity-default"),
  };
}

export async function activateAccount(selector: string): Promise<StoredAccount> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  const existing = store.accounts[accountId];
  if (!existing) throw new Error(`Antigravity account not found: ${selector}`);
  const account = await ensureFresh(existing);
  account.lastUsedAt = Date.now();
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  writeActiveCredential(account);
  return account;
}

export async function removeAccount(selector: string): Promise<StoredAccount | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  delete store.accounts[accountId];
  let next: StoredAccount | undefined;
  if (store.activeAccountId === accountId) {
    next = sortedAccounts(store).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (next) {
      next = await ensureFresh(next);
      next.lastUsedAt = Date.now();
      store.accounts[next.accountId] = next;
    }
    store.activeAccountId = next?.accountId;
    writeActiveCredential(next);
  }
  saveAccountStore(store);
  return next;
}

/**
 * Switch to the next stored account that has not already been tried in this request.
 * Used when Antigravity returns a hard quota wall (HTTP 429).
 */
export async function failoverToNextAccount(
  triedAccessTokens: ReadonlySet<string>,
): Promise<AntigravityApiKey | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const candidates = sortedAccounts(store).filter(
    (account) => !triedAccessTokens.has(account.access),
  );
  for (const candidate of candidates) {
    try {
      const account = await ensureFresh(candidate);
      if (!account.access || triedAccessTokens.has(account.access)) continue;
      account.lastUsedAt = Date.now();
      store.accounts[account.accountId] = account;
      store.activeAccountId = account.accountId;
      saveAccountStore(store);
      writeActiveCredential(account);
      return apiKeyFor(account);
    } catch {
      // Skip accounts whose refresh token is no longer valid.
    }
  }
  return undefined;
}
