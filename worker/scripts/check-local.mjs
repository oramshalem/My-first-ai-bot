// Checks worker/.dev.vars without printing any secret, and says how to fix what is wrong.
// With --link (used by `npm run local`) it also prints a link that fills in the test page.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = new URL("../.dev.vars", import.meta.url);
const problems = [];
const ok = [];

const path = fileURLToPath(FILE);
console.log("Checking " + path);
if (!existsSync(FILE)) {
  // Notepad and Explorer often add .txt or drop the leading dot.
  const near = readdirSync(new URL("..", import.meta.url)).filter((f) => /dev.?vars/i.test(f));
  console.log("✗ This file does not exist, so the server has no keys or device secrets.");
  if (near.length) console.log(`  Found a similar file instead: ${near.join(", ")}. The name must be exactly .dev.vars`);
  console.log("  Fix: npm run setup-local (in this same folder), then npm run local");
  process.exit(1);
}

const raw = readFileSync(FILE);
if (raw[0] === 0xff && raw[1] === 0xfe) {
  problems.push("The file is saved as UTF-16 (this happens with `echo ... > .dev.vars` in PowerShell). Wrangler cannot read it.");
} else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  problems.push("The file starts with a UTF-8 BOM, so the first line is not read correctly.");
}

const text = raw.toString("utf8").replace(/^﻿/, "");
const vars = {};
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=(.*)$/);
  if (m) vars[m[1]] = m[2].trim();
}

if (!vars.DEVICE_KEYS) {
  problems.push("DEVICE_KEYS is missing.");
} else {
  if (/[“”„]/.test(vars.DEVICE_KEYS)) problems.push("DEVICE_KEYS contains curly quotes (“ ”). JSON needs plain quotes (\").");
  try {
    const devices = JSON.parse(vars.DEVICE_KEYS);
    const ids = Object.keys(devices);
    if (!ids.length || ids.some((id) => typeof devices[id] !== "string" || !devices[id])) {
      problems.push("DEVICE_KEYS must look like {\"browser-test\":\"<secret>\",\"robot-1\":\"<secret>\"}.");
    } else {
      ok.push(`DEVICE_KEYS is valid JSON with devices: ${ids.join(", ")}`);
      if (!ids.includes("browser-test")) problems.push("There is no \"browser-test\" device, so the test page cannot log in.");
    }
  } catch (err) {
    problems.push(`DEVICE_KEYS is not valid JSON (${err.message}).`);
  }
}

if (!vars.GEMINI_API_KEY) problems.push("GEMINI_API_KEY is missing, and Gemini is the default provider.");
if (vars.GEMINI_API_KEY) {
  if (/^(AQ\.|AIza)/.test(vars.GEMINI_API_KEY)) ok.push("GEMINI_API_KEY looks right");
  else ok.push("GEMINI_API_KEY is set (unusual prefix, Google will tell if it is wrong)");
}
if (vars.OPENAI_API_KEY) ok.push("OPENAI_API_KEY is set");
if (vars.ADMIN_PASSWORD) ok.push("ADMIN_PASSWORD is set");
else problems.push("ADMIN_PASSWORD is missing, so the logs screen will not open.");

for (const line of ok) console.log("✓ " + line);
for (const line of problems) console.log("✗ " + line);

if (problems.length) {
  console.log("\nFix: delete worker/.dev.vars, run npm run setup-local, then restart npm run local.");
  process.exit(1);
}
if (process.argv.includes("--link")) {
  const secret = JSON.parse(vars.DEVICE_KEYS)["browser-test"];
  console.log(`\nTest page (Ctrl+click): http://localhost:8787/#device=browser-test&secret=${encodeURIComponent(secret)}`);
  console.log("Logs screen:            http://localhost:8787/logs\n");
} else {
  console.log("\nAll good. Restart npm run local if it is running, so it picks up the file.");
}
