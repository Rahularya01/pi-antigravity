import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { defaultProjectId, loadCodeAssist } from "../client/client.js";
import { escapeHtml, antigravityEnv } from "../utils/util.js";
import { resolveCallbackHost, redactSecrets } from "../utils/security.js";
import type { AntigravityOAuthCredentials, CallbackServer } from "../types/types.js";

export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/**
 * Default OAuth client is Google's public Antigravity desktop client (not a private app secret).
 * Prefer ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET when you manage your own OAuth app.
 */
export const CLIENT_ID =
  antigravityEnv("CLIENT_ID") ||
  Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
      "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64",
  ).toString("utf8");
export const CLIENT_SECRET =
  antigravityEnv("CLIENT_SECRET") ||
  Buffer.from("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");

export const CALLBACK_HOST = resolveCallbackHost();

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8"): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text: string): string {
  const redacted = redactSecrets(text).trim();
  try {
    const parsed = JSON.parse(redacted) as {
      error?: string;
      error_description?: string;
    };
    const parts = [parsed.error, parsed.error_description].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  } catch {
    // not JSON
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function getUserEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    const server = createServer((req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, oauthCallbackHeaders("text/plain; charset=utf-8"));
        res.end("Method Not Allowed");
        return;
      }

      const url = new URL(req.url || "", REDIRECT_URI);
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404, oauthCallbackHeaders());
        res.end("Antigravity OAuth callback route not found.");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        const safe = escapeHtml(error.slice(0, 200));
        res.writeHead(400, oauthCallbackHeaders());
        res.end(`Antigravity authentication failed: ${safe}`);
        finish(() => rejectCode(new Error(`OAuth error: ${error.slice(0, 200)}`)));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, oauthCallbackHeaders());
        res.end("Antigravity authentication failed: missing code or state.");
        finish(() => rejectCode(new Error("Missing code or state in OAuth callback")));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, oauthCallbackHeaders());
        res.end("Antigravity authentication failed: invalid state.");
        finish(() => rejectCode(new Error("OAuth state mismatch")));
        return;
      }

      res.writeHead(200, oauthCallbackHeaders());
      res.end("Antigravity authentication complete. You can close this window and return to Pi.");
      finish(() => resolveCode({ code, state }));
    });

    server.on("error", reject);
    server.listen(51121, CALLBACK_HOST, () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
        server.close();
      }, OAUTH_CALLBACK_TIMEOUT_MS);
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

function credentialProjectId(credentials: OAuthCredentials): string | undefined {
  const projectId = (credentials as AntigravityOAuthCredentials).projectId;
  return typeof projectId === "string" ? projectId : undefined;
}

function credentialEmail(credentials: OAuthCredentials): string | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email;
  return typeof email === "string" ? email : undefined;
}

export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<AntigravityOAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  // State must be independent of the PKCE verifier so a leaked callback URL
  // cannot also disclose the code_verifier needed to mint tokens.
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  try {
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    callbacks.onAuth({
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete Google sign-in. Pi will capture the local callback.",
    });

    const { code, state: returnedState } = await waitForCode();
    if (returnedState !== state) throw new Error("OAuth state mismatch");

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
      );
    }
    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!tokenData.refresh_token) {
      throw new Error(
        "No refresh token received. Re-run /login antigravity and allow offline access.",
      );
    }

    const [email, discoveredProject] = await Promise.all([
      getUserEmail(tokenData.access_token),
      loadCodeAssist(tokenData.access_token),
    ]);
    return {
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
      email,
    };
  } finally {
    server.close();
  }
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
): Promise<AntigravityOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  const discoveredProject = await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      discoveredProject ||
      credentialProjectId(credentials) ||
      defaultProjectId(email || "antigravity-default"),
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

export type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
