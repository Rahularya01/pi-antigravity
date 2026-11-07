import { deepStrictEqual, rejects } from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeImage,
  DEFAULT_IMAGE_MODEL,
  requestImageResponse,
  parseImageResponse,
  assertSafeAspectRatio,
  assertSafeImageModel,
  buildImageGenerateRequest,
  collectImagesFromSse,
  parseImageCommandArgs,
  resolveImageSavePath,
} from "../src/image/index.js";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(`FAILED: ${message}`);
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body);
}

async function main() {
  const parsed = parseImageCommandArgs("--ratio 16:9 --model gemini-3-pro-image a sunset over mountains");
  assert(parsed.prompt === "a sunset over mountains", "prompt parsed");
  assert(parsed.aspectRatio === "16:9", "ratio parsed");
  assert(parsed.model === "gemini-3-pro-image", "model parsed");

  const withPath = parseImageCommandArgs("--path out/cat.png --ratio 1:1 a cat");
  assert(withPath.path === "out/cat.png", "path parsed");
  assert(withPath.prompt === "a cat", "prompt after flags");

  assert(parseImageCommandArgs("").prompt === "", "empty args");
  assert(assertSafeImageModel("gemini-3-pro-image") === "gemini-3-pro-image", "allow gemini image model");
  assert(assertSafeImageModel("imagen-3.0-generate-002") === "imagen-3.0-generate-002", "allow imagen");
  try {
    assertSafeImageModel("claude-opus-4-6");
    fail("expected unsafe model to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported image model/.test(error.message), "reject chat model");
  }
  try {
    assertSafeImageModel("https://evil.example/x");
    fail("expected url model to throw");
  } catch {
    // expected
  }

  assert(assertSafeAspectRatio("16:9") === "16:9", "allow 16:9");
  try {
    assertSafeAspectRatio("99:1");
    fail("expected bad ratio to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported aspect ratio/.test(error.message), "reject ratio");
  }

  const req = buildImageGenerateRequest("a lighthouse", "gemini-3-pro-image", "proj-1", "16:9");
  assert(req.model === "gemini-3-pro-image", "request model");
  assert(req.project === "proj-1", "request project");
  assert(req.request.generationConfig.imageConfig.aspectRatio === "16:9", "aspect ratio");
  assert(req.request.contents[0]?.parts[0]?.text === "a lighthouse", "prompt text");
  assert(DEFAULT_IMAGE_MODEL === "gemini-3.1-flash-image", "default image model");
  assert(req.requestType === "image_gen", "image request type");
  assert(/^image_gen\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/1$/.test(req.requestId), "image request id");
  assert(!("systemInstruction" in req.request), "no image system instruction");

  for (const status of [200, 400, 403, 429, 500, 503]) {
    const calls: string[] = [];
    const direct = new Response("note", { status });
    const result = await requestImageResponse("https://example.test", {}, async (url) => {
      calls.push(url);
      return direct;
    });
    deepStrictEqual(calls, ["https://example.test/v1internal:generateContent"]);
    assert(result.response === direct && !result.streaming, "no SSE retry except 404");
  }
  const missing = new Response("not found", { status: 404 });
  const calls: string[] = [];
  const streamed = await requestImageResponse("https://example.test", {}, async (url) => {
    calls.push(url);
    return calls.length === 1 ? missing : new Response("data: [DONE]\\n");
  });
  assert(missing.bodyUsed, "404 body consumed");
  assert(streamed.streaming, "404 enables SSE");
  deepStrictEqual(calls, [
    "https://example.test/v1internal:generateContent",
    "https://example.test/v1internal:streamGenerateContent?alt=sse",
  ]);
  await rejects(requestImageResponse("https://example.test", {}, async () => {
    throw new Error("aborted");
  }), /aborted/);
  const candidate = { content: { parts: [
    { text: "note" }, { inlineData: { mimeType: "image/jpeg", data: "AQID" } },
  ] } };
  const expected = { images: [{ mimeType: "image/jpeg", data: "AQID" }], text: ["note"] };
  deepStrictEqual(parseImageResponse({ candidates: [candidate] }), expected);
  deepStrictEqual(parseImageResponse({ response: { candidates: [candidate] } }), expected);
  deepStrictEqual(parseImageResponse({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }),
    { images: [], text: ["no image"] });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const body =
    sse({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }) +
    sse({
      response: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }],
      },
    }) +
    "data: [DONE]\n";
  const parsedSse = await collectImagesFromSse(responseFromChunks([body.slice(0, 40), body.slice(40)]));
  assert(parsedSse.images.length === 1, "one image");
  assert(parsedSse.images[0]?.mimeType === "image/png", "png mime");
  assert(parsedSse.images[0]?.data === png, "png data");
  assert(parsedSse.text.join("") === "ok", "sse text");

  const tmp = await mkdtemp(join(tmpdir(), "pi-antigravity-image-"));
  try {
    const external = await mkdtemp(join(tmpdir(), "pi-image-outside-"));
    try {
      await writeFile(join(external, "secret"), "unchanged");
      await symlink(external, join(tmp, "escape"));
      await rejects(writeImage(join(tmp, "escape/secret"), { data: png, mimeType: "image/png" }, tmp), /symlinks/);
      await symlink(join(external, "secret"), join(tmp, "link.png"));
      await rejects(writeImage(join(tmp, "link.png"), { data: png, mimeType: "image/png" }, tmp));
      assert(await readFile(join(external, "secret"), "utf8") === "unchanged", "outside file unchanged");
    } finally { await rm(external, { recursive: true, force: true }); }
    const saved = resolveImageSavePath(tmp, "out/cat.png");
    assert(saved === join(tmp, "out/cat.png"), `save path ${saved}`);
    const dirSaved = resolveImageSavePath(tmp, "images", "image/jpeg", 0);
    assert(dirSaved.endsWith("-1.jpg"), `dir save ${dirSaved}`);
    assert(dirSaved.startsWith(join(tmp, "images")), "dir stays in cwd");
    try {
      resolveImageSavePath(tmp, "../escape.png");
      fail("expected path traversal to throw");
    } catch (error) {
      assert(
        error instanceof Error && /inside the working directory/.test(error.message),
        "reject traversal",
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log("image gen: command parsing, model/path guards, request shape, and SSE parse passed");
}

void main();
