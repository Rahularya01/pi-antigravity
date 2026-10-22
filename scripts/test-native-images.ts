import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import registerImage from "../src/features/generate-image.js";
import registerSearch from "../src/features/google-search.js";
import register from "../src/index.js";
import { ANTIGRAVITY_IMAGE_API, ANTIGRAVITY_IMAGE_MODELS, generateAntigravityImages } from "../src/image/native.js";

const model = { ...ANTIGRAVITY_IMAGE_MODELS[0]!, provider: "antigravity" };
const context = { input: [{ type: "text" as const, text: "a square" }] };
assert.equal((await generateAntigravityImages(model, context)).stopReason, "error");
assert.match((await generateAntigravityImages(model, context, { apiKey: "bad" })).errorMessage!, /Invalid Antigravity credentials/);
const abort = new AbortController();
abort.abort();
assert.equal((await generateAntigravityImages(model, context, { signal: abort.signal })).stopReason, "aborted");

let provider: any;
let imageTool: any;
const schemas: Record<string, string[]> = {};
const pi = new Proxy({}, {
  get(_target, key) {
    if (key === "registerProvider") return (_name: string, config: unknown) => { provider = config; };
    if (key === "registerTool") return (tool: any) => {
      schemas[tool.name] = Object.keys(tool.parameters.properties).sort();
      if (tool.name === "generate_image") imageTool = tool;
    };
    return () => undefined;
  },
}) as Parameters<typeof register>[0];
register(pi);
registerSearch(pi);
registerImage(pi);
assert.equal(provider.images[ANTIGRAVITY_IMAGE_API].generateImages, generateAntigravityImages);
assert.equal(provider.models.filter((m: any) => m.type === "image").length, 1);
assert.deepEqual(schemas.generate_image, ["aspectRatio", "model", "path", "prompt", "referenceImages"]);
assert.deepEqual(imageTool.parameters.required, ["prompt"]);
assert.deepEqual(schemas.google_search, ["instruction", "query", "thinking", "urls"]);

const originalFetch = globalThis.fetch;
const saved = new Map(["ANTIGRAVITY_BASE_URL", "ANTIGRAVITY_NO_KEEPALIVE"].map(k => [k, process.env[k]]));
process.env.ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
process.env.ANTIGRAVITY_NO_KEEPALIVE = "1";
const apiKey = JSON.stringify({ token: "test-token", projectId: "test-project" });
try {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, model.id);
    assert.equal(body.request.generationConfig.imageConfig.aspectRatio, "16:9");
    assert.deepEqual(body.request.contents[0].parts[1], { inlineData: { data: "AQID", mimeType: "image/png" } });
    return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [
      { text: "done" }, { inlineData: { data: "AQID", mimeType: "image/jpeg" } },
    ] } }] } }));
  }) as typeof fetch;
  const result = await generateAntigravityImages(model, { input: [
    ...context.input, { type: "image", data: "AQID", mimeType: "image/png" },
  ] }, { apiKey, metadata: { aspectRatio: "16:9" } });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.model, model.id);
  assert.deepEqual(result.output, [
    { type: "text", text: "done" }, { type: "image", data: "AQID", mimeType: "image/jpeg" },
  ]);
  assert.equal(calls, 1);
  assert.equal("savedPaths" in result, false);

  const invalid = await generateAntigravityImages(model, context, { apiKey, metadata: { aspectRatio: "99:1" } });
  assert.equal(invalid.stopReason, "error");
  assert.equal(calls, 1, "invalid ratio does not make a request");
  assert.equal((await generateAntigravityImages(model, { input: [] }, { apiKey })).stopReason, "error");

  globalThis.fetch = (async () => {
    const requestAbort = new Error("aborted");
    throw requestAbort;
  }) as typeof fetch;
  const controller = new AbortController();
  globalThis.fetch = (async () => { controller.abort(); throw new Error("aborted"); }) as typeof fetch;
  assert.equal((await generateAntigravityImages(model, context, { apiKey, signal: controller.signal })).stopReason, "aborted");

  const cwd = await mkdtemp(join(tmpdir(), "antigravity-reference-"));
  const outside = await mkdtemp(join(tmpdir(), "antigravity-outside-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const gif = Buffer.from("GIF89a");
  const webp = Buffer.from("RIFF0000WEBP");
  const toolContext = { cwd, modelRegistry: { getApiKeyForProvider: async () => apiKey } };
  const runTool = (referenceImages?: string[], signal?: AbortSignal) => imageTool.execute(
    "test", { prompt: "use these references", path: "result.png", referenceImages }, signal, undefined, toolContext,
  );
  try {
    // Content sniffing, not the filename, determines the MIME type.
    await writeFile(join(cwd, "reference image.dat"), png);
    await writeFile(join(cwd, "second.JPG"), jpeg);
    await writeFile(join(cwd, "third.gif"), gif);
    await writeFile(join(cwd, "fourth.webp"), webp);
    await writeFile(join(cwd, "not-an-image.png"), "private text, not image data");
    await writeFile(join(outside, "outside.png"), png);
    await symlink(join(outside, "outside.png"), join(cwd, "escape.png"));
    await symlink(join(cwd, "reference image.dat"), join(cwd, "inside.png"));
    let toolCalls = 0;
    let expectedImages: { data: string; mimeType: string }[] = [];
    globalThis.fetch = (async (_url, init) => {
      toolCalls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.request.contents[0].parts, [
        { text: "use these references" }, ...expectedImages.map(inlineData => ({ inlineData })),
      ]);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { data: png.toString("base64"), mimeType: "image/png" } },
      ] } }] }));
    }) as typeof fetch;
    expectedImages = [
      { data: png.toString("base64"), mimeType: "image/png" },
      { data: jpeg.toString("base64"), mimeType: "image/jpeg" },
      { data: gif.toString("base64"), mimeType: "image/gif" },
      { data: webp.toString("base64"), mimeType: "image/webp" },
    ];
    const generated = await runTool(["reference image.dat", "second.JPG", "third.gif", "fourth.webp"]);
    assert.deepEqual(generated.details.savedPaths, [join(cwd, "result.png")]);
    assert.deepEqual(await readFile(join(cwd, "result.png")), png);
    assert.equal(generated.content[1].data, png.toString("base64"));
    expectedImages = [expectedImages[0]!];
    await runTool(["inside.png"]);
    expectedImages = [];
    await runTool();
    await runTool([]);
    assert.equal(toolCalls, 4);

    await assert.rejects(runTool(["missing.png"]), /ENOENT/);
    await assert.rejects(runTool(["not-an-image.png"]), /Unsupported reference image/);
    for (const path of [relative(cwd, join(outside, "outside.png")), join(cwd, "reference image.dat"), "escape.png", "."]) {
      await assert.rejects(runTool([path]), /project-relative and inside the working directory/);
    }
    await assert.rejects(runTool(["reference image.dat"], abort.signal), /aborted/i);
    assert.equal(toolCalls, 4, "invalid references and cancellation do not send a request");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  // Refresh publishes the same image model without requiring network access.
  const refreshed = await provider.refreshModels({ allowNetwork: false });
  assert.equal(refreshed.filter((m: any) => m.type === "image").length, 1);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log("native images: registration, schemas, inputs, reference files, path guards, errors, abort, and refresh passed");
