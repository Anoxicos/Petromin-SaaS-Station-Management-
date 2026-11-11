import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const operations = readFileSync(join(root, "src/ui/operations.html"), "utf8");
const admin = readFileSync(join(root, "src/ui/platform-admin.html"), "utf8");
const french = readFileSync(join(root, "src/ui/french.js"), "utf8");
const css = readFileSync(join(root, "src/ui/operations.css"), "utf8");

const ids = [...operations.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "operations page must not contain duplicate IDs");

const nav = operations.match(/<nav class="day-steps"[\s\S]*?<\/nav>/)?.[0];
assert.ok(nav, "daily workflow must have visible step navigation");
const targets = [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
assert.equal(targets.length, 4, "daily workflow must expose its four ordered steps");
for (const target of targets) assert.ok(ids.includes(target), `step target #${target} must exist`);
for (const [label, target] of [
  ["Meter readings", "meterReadings"],
  ["Cash, card and tank dips", "cashAndDips"],
  ["Reconciliation", "cashReconciliation"],
  ["Review and close", "reviewAndClose"],
]) assert.ok(nav.includes(`href="#${target}"`) && nav.includes(` ${label}</a>`), `step navigation must include ${label}`);

assert.match(admin, /<div class="onboarding-guide" role="note">/, "client onboarding must explain prerequisites");
assert.match(admin, /href="\/login\?returnTo=%2Fapp" target="_blank" rel="noopener"/, "station sign-in must open safely in another tab");
assert.match(admin, /does not create an Auth0 login/i, "onboarding must distinguish linking from Auth0 user creation");
for (const text of ["Station-day steps", "Meter readings", "Reconciliation", "Review and close", "Before you start"]) {
  assert.ok(french.includes(`"${text}"`), `French UI dictionary must include ${text}`);
}
assert.match(css, /\.day-steps a:focus-visible/, "step links must show keyboard focus");
assert.match(css, /@media\(max-width:760px\).*day-steps/s, "step navigation must support narrow screens");

console.log("PASS daily workflow navigation targets, accessibility styles, French labels, and owner sign-in guidance");
