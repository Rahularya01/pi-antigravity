import type { AssistantImages, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_MODEL, generateAntigravityImageContent } from "./image.js";
import { safeError } from "../utils/security.js";

export const ANTIGRAVITY_IMAGE_API = "antigravity-images";
export const ANTIGRAVITY_IMAGE_MODELS = [
  {
    type: "image" as const,
    id: DEFAULT_IMAGE_MODEL,
    name: "Gemini 3.1 Flash Image",
    api: ANTIGRAVITY_IMAGE_API,
    input: ["text", "image"] as ("text" | "image")[],
    output: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

type ImageModelIdentity = { id: string; api: string; provider: string };

/** Implements Pi's in-memory image API using the existing Antigravity credentials and transport. */
export async function generateAntigravityImages(
  model: ImageModelIdentity,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const identity = { api: model.api, provider: model.provider, model: model.id };
  try {
    if (options?.signal?.aborted) throw new Error("Request was aborted");
    if (!options?.apiKey)
      throw new Error("No Antigravity credentials. Run /login antigravity first.");
    const ratio = options.metadata?.aspectRatio;
    if (ratio !== undefined && typeof ratio !== "string")
      throw new Error("aspectRatio must be a string.");
    const result = await generateAntigravityImageContent({
      apiKey: options.apiKey,
      model: model.id,
      signal: options.signal,
      aspectRatio: ratio,
      prompt: context.input
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n\n"),
      inputImages: context.input
        .filter((item) => item.type === "image")
        .map((item) => ({
          data: item.data,
          mimeType: item.mimeType,
        })),
    });
    return {
      ...identity,
      model: result.model,
      stopReason: "stop",
      timestamp: Date.now(),
      output: [
        ...result.text.map((text) => ({ type: "text" as const, text })),
        ...result.images.map((image) => ({ type: "image" as const, ...image })),
      ],
    };
  } catch (error) {
    return {
      ...identity,
      output: [],
      timestamp: Date.now(),
      stopReason: options?.signal?.aborted ? "aborted" : "error",
      errorMessage: safeError(error),
    };
  }
}
