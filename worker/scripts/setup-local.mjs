// Creates .dev.vars for running the server on your own computer.
// Generates the device secrets and the logs password, and asks only for the API keys.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const FILE = new URL("../.dev.vars", import.meta.url);

if (existsSync(FILE)) {
  console.log(".dev.vars already exists. Delete it first if you want to start over.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  process.stdout.write(question);
  const { value } = await lines.next();
  return (value ?? "").trim();
}
const geminiKey = await ask("Paste your Gemini API key from aistudio.google.com (starts with AQ. or AIza): ");
const openaiKey = await ask("OpenAI API key (optional, press Enter to skip): ");
rl.close();
// AI Studio used to issue AIza... keys and now issues AQ. keys. Both work.
if (!geminiKey || /\s/.test(geminiKey)) {
  console.log("The Gemini key is empty or has spaces in it. Nothing was written.");
  process.exit(1);
}
if (!/^(AQ\.|AIza)/.test(geminiKey)) {
  console.log("Note: this key does not start with AQ. or AIza. Saving it anyway; if Google rejects it, the reason will show on the logs screen.");
}
if (openaiKey && !openaiKey.startsWith("sk-")) {
  console.log("That does not look like an OpenAI key. Nothing was written.");
  process.exit(1);
}

const secret = () => randomBytes(18).toString("base64url");
const browserSecret = secret();
const robotSecret = secret();
const adminPassword = secret();

writeFileSync(
  FILE,
  [
    `GEMINI_API_KEY=${geminiKey}`,
    ...(openaiKey ? [`OPENAI_API_KEY=${openaiKey}`] : []),
    `DEVICE_KEYS=${JSON.stringify({ "browser-test": browserSecret, "robot-1": robotSecret })}`,
    `ADMIN_PASSWORD=${adminPassword}`,
    "",
  ].join("\n"),
);

console.log(`
Saved worker/.dev.vars (it is in .gitignore and never goes to GitHub).
Keep these in your password manager:

  Test page    device id: browser-test   secret: ${browserSecret}
  Robot        device id: robot-1        secret: ${robotSecret}
  Logs screen  password:  ${adminPassword}

Next: npm run local, then open http://localhost:8787
`);
