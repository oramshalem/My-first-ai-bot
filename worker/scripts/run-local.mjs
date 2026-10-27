// Starts the token server (wrangler dev) and the robot bridge together.
// Ctrl+C stops both.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const bridge = fileURLToPath(new URL("../bridge/xiaozhi-bridge.mjs", import.meta.url));

const children = [
  spawn(process.execPath, [wranglerBin, "dev", "--ip", "0.0.0.0", "--port", "8787"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [bridge], { cwd: root, stdio: "inherit" }),
];

// The address the robot needs: this computer on the home network.
const lanIps = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);
console.log("\nRobot setup page, field OTA (advanced):");
for (const ip of lanIps.length ? lanIps : ["<this computer's IP>"]) console.log(`  http://${ip}:8788/xiaozhi/ota/`);
console.log("");

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) console.log(`\nA process stopped (code ${code}), stopping the other one too.`);
    stop();
    process.exitCode = code ?? 0;
  });
}
