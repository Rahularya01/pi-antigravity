import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-antigravity-accounts-"));

const {
  activateAccount,
  failoverToNextAccount,
  listAccounts,
  loadAccountStore,
  rememberAccount,
  removeAccount,
  updateRememberedAccount,
} = await import("../src/auth/accounts.ts");

const account = (email: string, refresh: string) => ({
  email,
  access: `access-${email}`,
  refresh,
  expires: Date.now() + 10 * 60_000,
  projectId: `project-${email}`,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testStoresAndSwitchesAccounts(): Promise<void> {
  rememberAccount(account("a@example.com", "refresh-a"));
  rememberAccount(account("b@example.com", "refresh-b"));

  assert(
    JSON.stringify(listAccounts().map((entry) => entry.email)) ===
      JSON.stringify(["a@example.com", "b@example.com"]),
    "accounts were not stored in insertion order",
  );
  assert(
    listAccounts().find((entry) => entry.email === "b@example.com")?.active,
    "newly remembered account was not activated",
  );

  await activateAccount("a@example.com");
  const store = loadAccountStore();
  assert(store.activeAccountId === "a@example.com", "account was not activated");
  assert(
    JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8")).antigravity
      .email === "a@example.com",
    "auth.json was not updated",
  );
}

function testKeepsRotatedRefreshTokens(): void {
  updateRememberedAccount(
    account("a@example.com", "refresh-a"),
    account("a@example.com", "refresh-a2"),
  );
  assert(
    loadAccountStore().accounts["a@example.com"]?.refresh === "refresh-a2",
    "rotated refresh token was not persisted",
  );
}

async function testNumericSelectorIgnoresDigitEmails(): Promise<void> {
  rememberAccount(account("1@example.com", "refresh-1"));
  const switched = await activateAccount("1@example.com");
  assert(switched.email === "1@example.com", "digit-prefixed email was treated as an index");
  const byIndex = await activateAccount("1");
  assert(byIndex.email === "a@example.com", "index 1 did not select the first stored account");
}

async function testPreservesOtherAuthProviders(): Promise<void> {
  const authPath = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      antigravity: {
        type: "oauth",
        email: "a@example.com",
        access: "access-a@example.com",
        refresh: "refresh-a2",
        expires: Date.now() + 10 * 60_000,
        projectId: "project-a@example.com",
      },
      other: { type: "api", key: "keep-me" },
    }),
  );
  await activateAccount("b@example.com");
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
    other?: { key?: string };
    antigravity?: { email?: string };
  };
  assert(auth.other?.key === "keep-me", "other auth providers were overwritten");
  assert(auth.antigravity?.email === "b@example.com", "antigravity credential was not switched");
}

async function testQuotaFailoverSkipsTriedTokens(): Promise<void> {
  const next = await failoverToNextAccount(new Set(["access-b@example.com"]));
  assert(next?.token !== "access-b@example.com", "failover reused the exhausted account");
  assert(next?.token, "failover did not return another account");
}

async function testRemovesAccount(): Promise<void> {
  await removeAccount("a@example.com");
  const remaining = listAccounts();
  assert(
    remaining.every((entry) => entry.email !== "a@example.com"),
    "account was not removed",
  );
  assert(remaining.length >= 1, "no accounts remained after removal");
  assert(
    remaining.some((entry) => entry.active),
    "a remaining account was not activated",
  );
  assert(
    (statSync(join(process.env.PI_CODING_AGENT_DIR!, "antigravity-accounts.json")).mode & 0o777) ===
      0o600,
    "account store permissions are not owner-only",
  );
}

await testStoresAndSwitchesAccounts();
testKeepsRotatedRefreshTokens();
await testNumericSelectorIgnoresDigitEmails();
await testPreservesOtherAuthProviders();
await testQuotaFailoverSkipsTriedTokens();
await testRemovesAccount();
console.log("accounts tests: ok");
