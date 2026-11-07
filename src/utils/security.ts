import { antigravityEnv, isRecord } from "./util.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_API_HOST_SUFFIXES = [".googleapis.com", ".sandbox.googleapis.com"];

/** Only loopback binds are allowed so OAuth codes cannot be stolen off-machine. */
export function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")): string {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

/** Prevent token exfiltration via poisoned BASE_URL (SSRF / credential leak). */
export function assertSafeApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" || ALLOWED_API_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/**
 * One redaction policy, expressed as contexts rather than as one list of names.
 *
 * - Shapes: values Google issues have stable shapes (access tokens `ya29.`, refresh
 *   tokens `1//`, authorization codes `4/0A`, JWTs), so they are hidden wherever
 *   they appear, with or without a name.
 * - URL parameters: in a query or fragment a name is secret when its last word is a
 *   credential word (`?subscription_key=`, `#access_token=`). A value is looked
 *   inside only when it carries the syntax of a context itself: a nested query or URL,
 *   or a bare `name=value` assignment.
 * - Assignments in free text (`token=...`, `"password": "..."`): the same words,
 *   minus the ones that are ordinary prose or diagnostics ({@link PROSE_WORDS}).
 *
 * Strings a page supplies are content, not secrets, and are never passed through here.
 */
const CREDENTIAL_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "key",
  "apikey",
  "signature",
  "sig",
  "credential",
  "credentials",
  "bearer",
  "jwt",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "code",
  "state",
  "nonce",
  "verifier",
  "otp",
]);

/** Compound names whose last word alone is not a credential word. */
const CREDENTIAL_SUFFIXES = ["accesskeyid", "accesskey", "privatekey", "clientsecret"];

/**
 * Words that name credentials in a URL but are ordinary in prose and diagnostics
 * ("exit code=1", "model state=UNAVAILABLE", "session=expired"). In free text they
 * are only redacted when the value has a credential shape.
 */
const PROSE_WORDS = new Set([
  "code",
  "state",
  "nonce",
  "session",
  "sessionid",
  "sid",
  "auth",
  "key",
  "sig",
  "signature",
  "credential",
  "jwt",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a parameter or field name carries a credential. */
function isCredentialName(name: string, inProse: boolean): boolean {
  const words = nameWords(name);
  const last = words.at(-1);
  if (!last) return false;
  const credentialQualifier =
    words.length > 1 &&
    words.some((word) =>
      /^(?:oauth|amz|goog|api|private|subscription|signing|access|secret|client)$/.test(word),
    );
  if (CREDENTIAL_WORDS.has(last)) return !inProse || !PROSE_WORDS.has(last) || credentialQualifier;
  const compact = words.join("");
  return CREDENTIAL_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

/** A value long and random enough to be a credential rather than a word. */
function looksLikeCredential(value: string): boolean {
  return value.length >= 16 && /[0-9]/.test(value) && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]"],
  [/\b1\/\/?[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]"],
  [/\b4\/0A[A-Za-z0-9_-]{10,}/g, "[redacted-authorization-code]"],
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, "[redacted-client-secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
];

function decodeComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

/**
 * A query or fragment parameter. The name excludes `?`, so each separator is looked
 * at once and a URL with many separators is redacted in linear time.
 */
const URL_PARAMETER = /([?&#])([^=&#?\s]{1,256})=([^&#\s"'<>]*)/g;

function redactParameters(text: string, depth = 0): string {
  return text.replace(URL_PARAMETER, (match, separator: string, name: string, value: string) => {
    const decodedName = decodeComponent(name);
    if (decodedName === undefined) return match;
    if (isCredentialName(decodedName, false)) return `${separator}${name}=[redacted]`;
    // Look inside a value only when it carries a context's own syntax.
    const decoded = decodeComponent(value);
    if (!decoded) return match;
    const nested =
      /^[?&#]/.test(decoded) || /:\/\/[^\s]*[?#]/.test(decoded)
        ? depth >= 8 || redactParameters(decoded, depth + 1) !== decoded
        : /^[\w.-]{1,64}=\S+$/.test(decoded) &&
          isCredentialName(decoded.slice(0, decoded.indexOf("=")), false);
    return nested ? `${separator}${name}=[redacted]` : match;
  });
}

/**
 * A name followed by `:` or `=` and a value. A quoted value keeps its quotes, so a
 * JSON document stays valid JSON after redaction.
 */
const ASSIGNMENT =
  /(["']?)\b([A-Za-z][\w.-]{0,63})\1(\s*[:=]\s*)(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s"',;&}\]]+))/g;

function redactAssignments(text: string): string {
  return text.replace(
    ASSIGNMENT,
    (
      match,
      quote: string,
      name: string,
      separator: string,
      double?: string,
      single?: string,
      bare?: string,
    ) => {
      const value = double ?? single ?? bare ?? "";
      if (!value || value.startsWith("[redacted")) return match;
      const words = nameWords(name);
      const last = words.at(-1) ?? "";
      if (!isCredentialName(name, true) && !(PROSE_WORDS.has(last) && looksLikeCredential(value)))
        return match;
      const redacted =
        double !== undefined
          ? '"[redacted]"'
          : single !== undefined
            ? "'[redacted]'"
            : "[redacted]";
      return `${quote}${name}${quote}${separator}${redacted}`;
    },
  );
}

/** Redact credentials from text the extension renders: errors, diagnostics and URLs. */
export function redactSecrets(text: string): string {
  let redacted = text.replace(/\b(https?:\/\/)[^/?#\s]*@/gi, "$1[redacted]@");
  for (const [shape, replacement] of TOKEN_SHAPES) redacted = redacted.replace(shape, replacement);
  return redactAssignments(redactParameters(redacted));
}

const VALIDATION_URL_HOST = "accounts.google.com";

/** Accept only the Google account-verification host, never an arbitrary redirect. */
export function safeValidationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /\s/.test(value))
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  if (url.hostname !== VALIDATION_URL_HOST) return undefined;
  return url.toString();
}

/** Pull `validation_url` from a 403 body before message slicing can drop it. */
export function extractValidationUrl(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { details?: unknown } };
    const details = parsed.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (!isRecord(detail) || !isRecord(detail.metadata)) continue;
        const safe = safeValidationUrl(detail.metadata.validation_url);
        if (safe) return safe;
      }
    }
  } catch {
    // not JSON
  }
  const match = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/);
  return match ? safeValidationUrl(match[0].replace(/[),.;]+$/, "")) : undefined;
}

/** Keep session-bearing verification links out of doctor output and stored diagnostics. */
export function stripValidationUrls(text: string): string {
  return text
    .replace(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/g, "[redacted-validation-url]")
    .replace(
      / Open this link in a browser signed in to the same Google account to verify: \[redacted-validation-url\]/g,
      "",
    );
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email || typeof email !== "string") return undefined;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "[redacted-email]";
  const name = parts[0];
  const domain = parts[1];
  const lastChar = name.at(-1) || "";
  const maskedName = name.length > 2 ? `${name[0]}***${lastChar}` : `${name[0]}***`;
  return `${maskedName}@${domain}`;
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}
