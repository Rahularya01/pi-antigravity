export enum ThinkingEffort {
  Off = "off",
  Minimal = "minimal",
  Low = "low",
  Medium = "medium",
  High = "high",
  Xhigh = "xhigh",
}

export enum Platform {
  Macos = "MACOS",
  Windows = "WINDOWS",
  Linux = "LINUX",
}

export enum ToolChoice {
  Auto = "auto",
  None = "none",
  Any = "any",
  Required = "required",
}

export enum GeminiToolCallingMode {
  None = "NONE",
  Any = "ANY",
  Auto = "AUTO",
  Validated = "VALIDATED",
}

export enum GeminiRole {
  User = "user",
  Model = "model",
}

export enum AntigravityRequestType {
  Agent = "agent",
}

export enum AntigravityUserAgent {
  Antigravity = "antigravity",
}

export enum StopReason {
  Stop = "stop",
  Length = "length",
  ToolUse = "toolUse",
  Error = "error",
}
