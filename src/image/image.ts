import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { sanitizeText } from "../utils/util.js";

export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

const IMAGE_MODEL_FALLBACKS = [
  DEFAULT_IMAGE_MODEL,
  "gemini-3-pro-image",
  "gemini-3-pro-image-preview",
];
const DEFAULT_IMAGE_DIR = join(".pi", "generated-images");
const MAX_PROMPT_CHARS = 8000;

export type GeneratedImage = { data: string; mimeType: string };

export type ImageGenerateRequest = {
  project: string;
  model: string;
  request: {
    contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: GeneratedImage }> }>;
    generationConfig: {
      imageConfig: { aspectRatio: string };
      candidateCount: number;
    };
  };
  requestType: "image_gen";
  userAgent: "antigravity";
  requestId: string;
};

export type ImageCommandArgs = {
  prompt: string;
  aspectRatio?: string;
  model?: string;
  path?: string;
};

export type GenerateImageOptions = ImageCommandArgs & {
  apiKey: string;
  cwd: string;
  inputImages?: GeneratedImage[];
  signal?: AbortSignal;
};

export type GenerateImageResult = {
  images: GeneratedImage[];
  savedPaths: string[];
  text: string[];
  model: string;
};

type ImageStreamChunk = {
  error?: { message?: string };
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
      };
    }>;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
  }>;
};

function imageExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export function assertSafeImageModel(modelId: string): string {
  const id = modelId.trim();
  if (id.length === 0 || id.length > 80) {
    throw new Error("Unsupported image model id.");
  }
  if (!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)) {
    throw new Error(`Unsupported image model: ${id}`);
  }
  return id;
}

export function assertSafeAspectRatio(ratio: string): ImageAspectRatio {
  const value = ratio.trim();
  for (const allowed of IMAGE_ASPECT_RATIOS) {
    if (allowed === value) return allowed;
  }
  throw new Error(
    `Unsupported aspect ratio: ${value}. Use one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`,
  );
}

export function parseImageCommandArgs(args: string): ImageCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: ImageCommandArgs = { prompt: "" };
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];
    if ((token === "--ratio" || token === "--aspect-ratio") && next) {
      out.aspectRatio = next;
      i += 1;
      continue;
    }
    if (token === "--model" && next) {
      out.model = next;
      i += 1;
      continue;
    }
    if (token === "--path" && next) {
      out.path = next;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  out.prompt = rest.join(" ");
  return out;
}

export function resolveImageSavePath(
  cwd: string,
  requested?: string,
  mimeType = "image/png",
  index?: number,
): string {
  const ext = imageExtension(mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = index === undefined ? "" : `-${index + 1}`;
  const defaultName = `image-${stamp}${suffix}.${ext}`;
  const root = resolve(cwd);
  const target = requested?.trim()
    ? resolve(root, requested.trim())
    : resolve(root, DEFAULT_IMAGE_DIR, defaultName);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Image save path must be inside the working directory.");
  }
  if (!extname(target)) return join(target, defaultName);
  if (index === undefined) return target;
  const currentExt = extname(target);
  return `${target.slice(0, -currentExt.length)}${suffix}${currentExt}`;
}

export function buildImageGenerateRequest(
  prompt: string,
  model: string,
  projectId: string,
  aspectRatio: string,
  inputImages: GeneratedImage[] = [],
): ImageGenerateRequest {
  return {
    project: projectId,
    model,
    request: {
      contents: [
        {
          role: GeminiRole.User,
          parts: [
            { text: sanitizeText(prompt) },
            ...inputImages.map((inlineData) => ({ inlineData })),
          ],
        },
      ],
      generationConfig: {
        imageConfig: { aspectRatio },
        candidateCount: 1,
      },
    },
    requestType: AntigravityRequestType.ImageGen,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: `image_gen/${Date.now()}/${randomUUID()}/1`,
  };
}

function collectImagesFromParts(
  parts: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> | undefined,
  images: GeneratedImage[],
  text: string[],
): void {
  for (const part of parts || []) {
    if (part.text) text.push(part.text);
    if (part.inlineData?.data) {
      images.push({
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      });
    }
  }
}

export async function collectImagesFromSse(
  response: Response,
  signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; text: string[] }> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) continue;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        let chunk: ImageStreamChunk;
        try {
          chunk = JSON.parse(json) as ImageStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new Error(chunk.error.message);
        const responseData = chunk.response || chunk;
        for (const candidate of responseData.candidates || []) {
          collectImagesFromParts(candidate.content?.parts, images, text);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { images, text };
}

/** Uses the direct image endpoint; only a 404 enables the legacy SSE endpoint. */
export async function requestImageResponse(
  endpoint: string,
  init: RequestInit,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = antigravityFetch,
): Promise<{ response: Response; streaming: boolean }> {
  const response = await fetcher(`${endpoint}/v1internal:generateContent`, init);
  if (response.status !== 404) return { response, streaming: false };
  await response.text();
  return {
    response: await fetcher(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, init),
    streaming: true,
  };
}

/** Extracts images and notes from wrapped or unwrapped direct responses. */
export function parseImageResponse(chunk: ImageStreamChunk): {
  images: GeneratedImage[];
  text: string[];
} {
  if (chunk.error?.message) throw new Error(chunk.error.message);
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const candidate of (chunk.response || chunk).candidates || []) {
    collectImagesFromParts(candidate.content?.parts, images, text);
  }
  return { images, text };
}

async function writeImage(filePath: string, image: GeneratedImage): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(image.data, "base64"));
  return filePath;
}

/** Generates in-memory content shared by the native API and file-saving wrapper. */
export async function generateAntigravityImageContent(
  options: Omit<GenerateImageOptions, "cwd" | "path">,
): Promise<Omit<GenerateImageResult, "savedPaths">> {
  const prompt = options.prompt.trim();
  if (!prompt && !options.inputImages?.length)
    throw new Error("Image prompt or input image is required.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Image prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  const aspectRatio = assertSafeAspectRatio(options.aspectRatio || "1:1");
  const preferred = assertSafeImageModel(options.model || DEFAULT_IMAGE_MODEL);
  const models = [preferred, ...IMAGE_MODEL_FALLBACKS.filter((id) => id !== preferred)];
  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);

  let lastError = "no endpoint available";
  for (const model of models) {
    const body = JSON.stringify(
      buildImageGenerateRequest(prompt, model, creds.projectId, aspectRatio, options.inputImages),
    );
    for (const endpoint of endpointCandidates()) {
      if (options.signal?.aborted) throw new Error("Request was aborted");
      try {
        const { response, streaming } = await requestImageResponse(endpoint, {
          method: "POST",
          headers,
          body,
          signal: options.signal,
        });
        if (!response.ok) {
          lastError = jsonOrTextError(await response.text()).slice(0, 400);
          if (response.status === 404 || [403, 429, 500, 502, 503, 504].includes(response.status)) {
            continue;
          }
          throw new Error(
            `Antigravity image request failed (${response.status}): ${safeError(lastError)}`,
          );
        }
        const parsed = streaming
          ? await collectImagesFromSse(response, options.signal)
          : parseImageResponse((await response.json()) as ImageStreamChunk);
        if (!parsed.images.length) {
          lastError = parsed.text.join(" ").trim() || "No image data returned.";
          continue;
        }
        return { images: parsed.images, text: parsed.text, model };
      } catch (error) {
        lastError = safeError(error);
        if (options.signal?.aborted) {
          throw new Error("Request was aborted", { cause: error });
        }
      }
    }
  }
  throw new Error(`Antigravity image generation failed: ${safeError(lastError)}`);
}

/** Saves generated images for the existing tool and slash command. */
export async function generateAntigravityImage(
  options: GenerateImageOptions,
): Promise<GenerateImageResult> {
  const result = await generateAntigravityImageContent(options);
  const savedPaths: string[] = [];
  for (const [index, image] of result.images.entries()) {
    savedPaths.push(
      await writeImage(
        resolveImageSavePath(
          options.cwd,
          options.path,
          image.mimeType,
          result.images.length > 1 ? index : undefined,
        ),
        image,
      ),
    );
  }
  return { ...result, savedPaths };
}
