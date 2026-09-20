import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { AntigravityOAuthCredentials } from "../types/types.js";
import { refreshAntigravityToken } from "./oauth.js";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const ACCOUNTS_PATH = join(AGENT_DIR, "antigravity-accounts.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");

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

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
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

function normalizeStore(value: AccountsFile | undefined): AccountsFile {
  if (!value || value.version !== 1 || !value.accounts || typeof value.accounts !== "object") {
    return emptyStore();
  }
  const accounts = Object.fromEntries(
    Object.entries(value.accounts).map(([key, account]) => [
      account.accountId || key,
      { ...account, accountId: account.accountId || key },
    ]),
  );
  return {
    version: 1,
    activeAccountId:
      value.activeAccountId || (value as AccountsFile & { activeEmail?: string }).activeEmail,
    accounts,
  };
}

export function loadAccountStore(): AccountsFile {
  return normalizeStore(readJson<AccountsFile>(ACCOUNTS_PATH));
}

function saveAccountStore(store: AccountsFile): void {
  writePrivateJson(ACCOUNTS_PATH, store);
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

function findAccount(
  store: AccountsFile,
  credentials: OAuthCredentials,
): StoredAccount | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  return Object.values(store.accounts).find(
    (account) =>
      account.refresh === credentials.refresh ||
      (email && account.email?.trim().toLowerCase() === email),
  );
}

function findAccountId(store: AccountsFile, selector: string): string | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return undefined;
  const entries = Object.values(store.accounts);
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
    return entries[numeric - 1]?.accountId;
  }
  return entries.find(
    (account) =>
      account.accountId.toLowerCase() === normalized ||
      account.email?.toLowerCase() === normalized ||
      account.email?.toLowerCase().startsWith(normalized),
  )?.accountId;
}

function writeActiveCredential(account: StoredAccount | undefined): void {
  const auth = readJson<Record<string, unknown>>(AUTH_PATH) || {};
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
  writePrivateJson(AUTH_PATH, auth);
}

export function syncCurrentAuth(): void {
  const current = readJson<Record<string, unknown>>(AUTH_PATH)?.antigravity as
    Partial<AntigravityOAuthCredentials> | undefined;
  if (!current?.refresh || typeof current.refresh !== "string") return;

  const store = loadAccountStore();
  const credentials: AntigravityOAuthCredentials = {
    access: typeof current.access === "string" ? current.access : "",
    refresh: current.refresh,
    expires: typeof current.expires === "number" ? current.expires : 0,
    projectId: typeof current.projectId === "string" ? current.projectId : undefined,
    email: typeof current.email === "string" ? current.email : undefined,
  };
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
  return Object.values(store.accounts).map((account) => ({
    accountId: account.accountId,
    email: account.email,
    active: account.accountId === store.activeAccountId,
    lastUsedAt: account.lastUsedAt,
  }));
}

export async function activateAccount(selector: string): Promise<StoredAccount> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  let account = store.accounts[accountId];
  if (!account) throw new Error(`Antigravity account not found: ${selector}`);
  if (!account.access || account.expires <= Date.now() + 5 * 60 * 1000) {
    account = accountFromCredentials(await refreshAntigravityToken(account), account);
    store.accounts[accountId] = account;
  }
  account.lastUsedAt = Date.now();
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  writeActiveCredential(account);
  return account;
}

export function removeAccount(selector: string): void {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  delete store.accounts[accountId];
  if (store.activeAccountId === accountId) {
    const next = Object.values(store.accounts).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    store.activeAccountId = next?.accountId;
    writeActiveCredential(next);
  }
  saveAccountStore(store);
}
