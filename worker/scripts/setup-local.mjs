// Creates .dev.vars for running the server on your own computer.
// Generates the device secrets and the logs password, and asks only for the OpenAI key.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const FILE = new URL("../.dev.vars", import.meta.url);

if (existsSync(FILE)) {
  console.log(".dev.vars already exists. Delete it first if you want to start over.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const apiKey = (await rl.question("Paste your OpenAI API key (sk-...): ")).trim();
rl.close();
if (!apiKey.startsWith("sk-")) {
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
    `OPENAI_API_KEY=${apiKey}`,
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
