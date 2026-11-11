import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { antigravityEnv, isRecord } from "./util.js";

const AGY_SETTINGS_FILE = join(homedir(), ".gemini", "antigravity-cli", "settings.json");

function getPiSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

export type CreditsStatus = {
  enabled: boolean;
  source: "env" | "pi_settings" | "antigravity_settings" | "default";
  detail: string;
};

/**
 * Check whether credit overages are explicitly configured via env or settings.
 */
export function getCreditsStatus(): CreditsStatus {
  // 1. Environment variable check
  const envVal =
    antigravityEnv("USE_CREDITS") ?? antigravityEnv("USE_G1_CREDITS") ?? process.env.USE_G1_CREDITS;
  if (envVal !== undefined) {
    const trimmed = envVal.trim().toLowerCase();
    const isTrue = ["1", "true", "yes", "on", "enable", "enabled"].includes(trimmed);
    const isFalse = ["0", "false", "no", "off", "disable", "disabled"].includes(trimmed);
    if (isTrue || isFalse) {
      return {
        enabled: isTrue,
        source: "env",
        detail: `Environment variable (ANTIGRAVITY_USE_CREDITS=${envVal})`,
      };
    }
  }

  // 2. Pi settings (~/.pi/agent/settings.json)
  const piSettingsPath = getPiSettingsPath();
  try {
    if (existsSync(piSettingsPath)) {
      const parsed = JSON.parse(readFileSync(piSettingsPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.useG1Credits === "boolean") {
        return {
          enabled: parsed.useG1Credits,
          source: "pi_settings",
          detail: `~/.pi/agent/settings.json (useG1Credits: ${parsed.useG1Credits})`,
        };
      }
      if (typeof parsed.useCredits === "boolean") {
        return {
          enabled: parsed.useCredits,
          source: "pi_settings",
          detail: `~/.pi/agent/settings.json (useCredits: ${parsed.useCredits})`,
        };
      }
      if (isRecord(parsed.antigravity)) {
        if (typeof parsed.antigravity.useCredits === "boolean") {
          return {
            enabled: parsed.antigravity.useCredits,
            source: "pi_settings",
            detail: `~/.pi/agent/settings.json (antigravity.useCredits: ${parsed.antigravity.useCredits})`,
          };
        }
        if (typeof parsed.antigravity.useG1Credits === "boolean") {
          return {
            enabled: parsed.antigravity.useG1Credits,
            source: "pi_settings",
            detail: `~/.pi/agent/settings.json (antigravity.useG1Credits: ${parsed.antigravity.useG1Credits})`,
          };
        }
      }
    }
  } catch {
    // Unreadable Pi settings leave credit overages disabled.
  }

  // 3. Antigravity CLI / IDE settings (~/.gemini/antigravity-cli/settings.json)
  try {
    if (existsSync(AGY_SETTINGS_FILE)) {
      const agyData = JSON.parse(readFileSync(AGY_SETTINGS_FILE, "utf8")) as Record<
        string,
        unknown
      >;
      if (agyData.useG1Credits === true || agyData.useAiCredits === true) {
        return {
          enabled: true,
          source: "antigravity_settings",
          detail: `~/.gemini/antigravity-cli/settings.json (useG1Credits: true)`,
        };
      }
      if (agyData.useG1Credits === false || agyData.useAiCredits === false) {
        return {
          enabled: false,
          source: "antigravity_settings",
          detail: `~/.gemini/antigravity-cli/settings.json (useG1Credits: false)`,
        };
      }
    }
  } catch {
    // Unreadable CLI settings leave credit overages disabled.
  }

  return {
    enabled: false,
    source: "default",
    detail: "Default (disabled; enable with /antigravity.credits on)",
  };
}

export function isCreditsEnabled(): boolean {
  return getCreditsStatus().enabled;
}

function readSettingsObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed;
}

export function setCreditsEnabled(enabled: boolean): void {
  // Update Pi's settings only. A parse failure must not replace the file with `{ useG1Credits }`.
  const piSettingsPath = getPiSettingsPath();
  try {
    const piData = existsSync(piSettingsPath) ? readSettingsObject(piSettingsPath) : {};
    piData.useG1Credits = enabled;
    writeFileSync(piSettingsPath, `${JSON.stringify(piData, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update ${piSettingsPath}: ${message}`, { cause: error });
  }

  // Keep the official CLI flag in sync only when that file already exists and parses.
  // Never create it, and never overwrite it after a parse error.
  if (!existsSync(AGY_SETTINGS_FILE)) return;
  try {
    const agyData = readSettingsObject(AGY_SETTINGS_FILE);
    agyData.useG1Credits = enabled;
    writeFileSync(AGY_SETTINGS_FILE, `${JSON.stringify(agyData, null, 2)}\n`, "utf8");
  } catch {
    // Leave the CLI file untouched.
  }
}
