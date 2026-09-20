import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-antigravity-accounts-"));

const {
  activateAccount,
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
    JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8")).antigravity.email ===
      "a@example.com",
    "auth.json was not updated",
  );
}

function testKeepsRotatedRefreshTokens(): void {
  updateRememberedAccount(account("a@example.com", "refresh-a"), account("a@example.com", "refresh-a2"));
  assert(
    loadAccountStore().accounts["a@example.com"]?.refresh === "refresh-a2",
    "rotated refresh token was not persisted",
  );
}

function testRemovesAccount(): void {
  removeAccount("a@example.com");
  const remaining = listAccounts();
  assert(remaining.length === 1, "account was not removed");
  assert(remaining[0]?.email === "b@example.com", "wrong account remained");
  assert(remaining[0]?.active, "remaining account was not activated");
  assert(
    (statSync(join(process.env.PI_CODING_AGENT_DIR!, "antigravity-accounts.json")).mode & 0o777) === 0o600,
    "account store permissions are not owner-only",
  );
}

await testStoresAndSwitchesAccounts();
testKeepsRotatedRefreshTokens();
testRemovesAccount();
console.log("accounts tests: ok");
