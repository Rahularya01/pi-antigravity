import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const auth = JSON.parse(readFileSync("/Users/rahularya/.pi/agent/auth.json", "utf8"));
const creds = auth.antigravity;
const oauth = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/oauth.ts").href
);
const usageMod = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/usage.ts").href
);

const refreshed = await oauth.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const apiKey = oauth.getApiKey(refreshed);
const usage = await usageMod.fetchAccountUsage(apiKey);
console.log(usageMod.formatUsageSummary(usage));
console.log("\n----\n");
console.log(usageMod.formatModelsList(usage));
