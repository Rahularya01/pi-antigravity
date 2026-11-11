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
    antigravityEnv("USE_CREDITS") ??
    antigravityEnv("USE_G1_CREDITS") ??
    process.env.USE_G1_CREDITS;
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
  } catch {}

  // 3. Antigravity CLI / IDE settings (~/.gemini/antigravity-cli/settings.json)
  try {
    if (existsSync(AGY_SETTINGS_FILE)) {
      const agyData = JSON.parse(readFileSync(AGY_SETTINGS_FILE, "utf8")) as Record<string, unknown>;
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
  } catch {}

  return {
    enabled: false,
    source: "default",
    detail: "Default (disabled; enable with /antigravity.credits on)",
  };
}

export function isCreditsEnabled(): boolean {
  return getCreditsStatus().enabled;
}

export function setCreditsEnabled(enabled: boolean): void {
  // 1. Update ~/.pi/agent/settings.json
  const piSettingsPath = getPiSettingsPath();
  try {
    let piData: Record<string, unknown> = {};
    if (existsSync(piSettingsPath)) {
      try {
        piData = JSON.parse(readFileSync(piSettingsPath, "utf8")) as Record<string, unknown>;
      } catch {
        piData = {};
      }
    }
    piData.useG1Credits = enabled;
    writeFileSync(piSettingsPath, `${JSON.stringify(piData, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new Error(`Failed to update ${piSettingsPath}: ${error}`);
  }

  // 2. Also keep ~/.gemini/antigravity-cli/settings.json in sync so agy and the IDE match
  try {
    let agyData: Record<string, unknown> = {};
    if (existsSync(AGY_SETTINGS_FILE)) {
      try {
        agyData = JSON.parse(readFileSync(AGY_SETTINGS_FILE, "utf8")) as Record<string, unknown>;
      } catch {
        agyData = {};
      }
    }
    agyData.useG1Credits = enabled;
    writeFileSync(AGY_SETTINGS_FILE, `${JSON.stringify(agyData, null, 2)}\n`, "utf8");
  } catch {}
}
