// Checks worker/.dev.vars without printing any secret, and says how to fix what is wrong.
import { existsSync, readFileSync } from "node:fs";

const FILE = new URL("../.dev.vars", import.meta.url);
const problems = [];
const ok = [];

if (!existsSync(FILE)) {
  console.log("✗ worker/.dev.vars does not exist.\n  Fix: npm run setup-local");
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
  if (vars.GEMINI_API_KEY.startsWith("AIza")) ok.push("GEMINI_API_KEY looks right");
  else problems.push("GEMINI_API_KEY does not start with AIza.");
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
console.log("\nAll good. Restart npm run local if it is running, so it picks up the file.");
