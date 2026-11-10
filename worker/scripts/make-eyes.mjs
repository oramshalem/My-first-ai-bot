// npm run eyes -- <path to merged-binary.bin>
// Builds .robot-eyes.bin: the robot's stock assets with Piko's eyes. The bridge
// sends it to the robot the next time the robot connects.
// Without a path, looks for merged-binary.bin in Downloads.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetsFromFirmware, md5, readEyeGifs, unpackAssets, withEyes } from "../bridge/eyes-assets.mjs";

const OUT = fileURLToPath(new URL("../.robot-eyes.bin", import.meta.url));

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

const firmware = process.argv[2] || findFirmware();
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
  console.log("Next: npm run local. When the robot connects it downloads the eyes and restarts once.");
} catch (err) {
  console.log(`✗ ${err.message}`);
  process.exit(1);
}
