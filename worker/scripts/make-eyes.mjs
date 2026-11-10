// npm run eyes -- <path to merged-binary.bin>
// Builds .robot-eyes.bin: the robot's stock assets with Piko's eyes, and prints
// the address to flash it at with ESP Tool. Without a path, looks for
// merged-binary.bin in Downloads.
//
// With --wifi, the bridge sends the file to the robot at the start of the next
// conversation instead, over MCP. Without it, the bridge is told the robot
// already has these eyes, so it does not send them again.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetsFromFirmware, md5, readEyeGifs, unpackAssets, withEyes } from "../bridge/eyes-assets.mjs";

const OUT = fileURLToPath(new URL("../.robot-eyes.bin", import.meta.url));
const PAIRING = fileURLToPath(new URL("../.robot.json", import.meta.url));
const args = process.argv.slice(2);
const overWifi = args.includes("--wifi");

function findFirmware() {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.name === "merged-binary.bin") found.push(p);
    }
  };
  walk(join(homedir(), "Downloads"), 3);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const firmware = args.find((a) => !a.startsWith("--")) || findFirmware();
if (!firmware || !existsSync(firmware)) {
  console.log("Could not find merged-binary.bin. Run again with its path, for example:");
  console.log('  npm run eyes -- "C:\\Users\\User\\Downloads\\v2.5.2_waveshare-esp32-s3-touch-lcd-1.85c\\merged-binary.bin"');
  process.exit(1);
}

try {
  const stock = assetsFromFirmware(readFileSync(firmware));
  const gifs = readEyeGifs(new URL("../eyes/", import.meta.url));
  const out = withEyes(stock, gifs);
  unpackAssets(out); // read it back once, so a broken file never reaches the robot
  writeFileSync(OUT, out);
  console.log(`Firmware: ${firmware}`);
  console.log(`✓ Made .robot-eyes.bin (${Math.round(out.length / 1024)} KB, ${md5(out).slice(0, 8)})`);
  if (overWifi) {
    console.log("Next: npm run local. At the start of the next conversation the robot downloads the eyes and restarts once.");
  } else {
    if (existsSync(PAIRING)) {
      const pairing = JSON.parse(readFileSync(PAIRING, "utf8"));
      writeFileSync(PAIRING, JSON.stringify({ ...pairing, eyes: md5(out) }, null, 2));
    }
    console.log("");
    console.log("Flash it with ESP Tool (https://espressif.github.io/esptool-js/):");
    console.log(`  Flash Address: 0x${stock.flashAddress.toString(16)}`);
    console.log(`  File:          ${OUT}`);
    console.log("Only this one file. Do not tick Erase all.");
  }
} catch (err) {
  console.log(`✗ ${err.message}`);
  process.exit(1);
}
