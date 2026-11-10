// The eyes: building assets.bin from the stock firmware, and the bridge sending it to the robot.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { EMOTIONS, assetsFromFirmware, packAssets, readEyeGifs, unpackAssets, withEyes } from "../bridge/eyes-assets.mjs";
import { createBridge } from "../bridge/xiaozhi-bridge.mjs";

const gifs = readEyeGifs(new URL("../eyes/", import.meta.url));

// stock assets like the firmware's: a font, a speech model, twemoji faces and an index
const stockIndex = {
  version: 1,
  text_font: "font_noto_basic_16_4.bin",
  srmodels: "srmodels.bin",
  emoji_collection: [
    { name: "neutral", file: "neutral.png" },
    { name: "happy", file: "happy.png" },
  ],
  skin: { light: { text_color: "#000000", background_color: "#FFFFFF", background_image: "bg.bin" } },
};
const stockFiles = [
  { name: "font_noto_basic_16_4.bin", data: Buffer.from("font bytes \xff\x80", "latin1") },
  { name: "srmodels.bin", data: Buffer.alloc(3000, 0xab) },
  { name: "neutral.png", width: 64, height: 64, data: Buffer.from("png1") },
  { name: "happy.png", width: 64, height: 64, data: Buffer.from("png2") },
  { name: "bg.bin", data: Buffer.from("background") },
  { name: "index.json", data: Buffer.from(JSON.stringify(stockIndex)) },
];
const stock = packAssets(stockFiles);

// a merged firmware image: partition table at 0x8000, assets at 0x10000
function firmwareWith(assets) {
  const image = Buffer.alloc(0x10000 + assets.length, 0xff);
  const entry = (i, label, type, offset, size) => {
    const at = 0x8000 + i * 32;
    image.writeUInt16LE(0x50aa, at);
    image[at + 2] = type;
    image.writeUInt32LE(offset, at + 4);
    image.writeUInt32LE(size, at + 8);
    image.fill(0, at + 12, at + 28);
    image.write(label, at + 12);
  };
  entry(0, "nvs", 1, 0x9000, 0x4000);
  entry(1, "ota_0", 0, 0x20000, 0x3f0000);
  entry(2, "assets", 1, 0x10000, 0x800000); // the partition is bigger than the file, like the real one
  assets.copy(image, 0x10000);
  return image;
}

test("packing and unpacking give back the same files", () => {
  const files = unpackAssets(stock);
  assert.deepEqual(files.map((f) => f.name), stockFiles.map((f) => f.name));
  assert.deepEqual(files[1].data, stockFiles[1].data);
  assert.equal(files[2].width, 64);
  assert.deepEqual(packAssets(files), stock);
});

test("a damaged file is refused", () => {
  const bad = Buffer.from(stock);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => unpackAssets(bad), /checksum/);
});

test("the assets partition is found inside merged-binary.bin", () => {
  assert.deepEqual(assetsFromFirmware(firmwareWith(stock)).subarray(0, stock.length), stock);
  assert.throws(() => assetsFromFirmware(Buffer.alloc(0x10000)), /no assets partition/);
});

test("the eyes replace the faces and keep the font and speech model", () => {
  const out = unpackAssets(withEyes(assetsFromFirmware(firmwareWith(stock)), gifs));
  const names = out.map((f) => f.name);
  assert.ok(names.includes("font_noto_basic_16_4.bin"));
  assert.deepEqual(out.find((f) => f.name === "srmodels.bin").data, stockFiles[1].data);
  for (const old of ["neutral.png", "happy.png", "bg.bin"]) assert.ok(!names.includes(old), `${old} removed`);

  const index = JSON.parse(out.find((f) => f.name === "index.json").data);
  assert.equal(index.text_font, stockIndex.text_font);
  assert.equal(index.srmodels, stockIndex.srmodels);
  assert.equal(index.skin.light.background_color, "#07040C");
  assert.equal(index.skin.light.background_image, undefined);

  // every face name points at a GIF that is in the file, 360x360 like the screen
  const all = Object.values(EMOTIONS).flat();
  assert.equal(index.emoji_collection.length, all.length);
  for (const { name, file } of index.emoji_collection) {
    const gif = out.find((f) => f.name === file);
    assert.ok(gif, `${name} -> ${file}`);
    assert.equal(gif.data.subarray(0, 6).toString(), "GIF89a");
    assert.equal(gif.width, 360);
    assert.equal(gif.height, 360);
  }
  for (const name of ["neutral", "happy", "thinking", "speaking", "sleepy", "laughing", "sad"]) {
    assert.ok(index.emoji_collection.some((e) => e.name === name), name);
  }
});

// --- the bridge hands the eyes to the robot over MCP, then the robot downloads them
const dir = mkdtempSync(join(tmpdir(), "eyes-"));
const pairingFile = join(dir, "robot.json");
const eyesFile = join(dir, "robot-eyes.bin");
const eyes = withEyes(stock, gifs);
writeFileSync(eyesFile, eyes);
const worker = http.createServer((req, res) => res.writeHead(500).end());
worker.listen(0, "127.0.0.1");
await once(worker, "listening");
const logLines = [];
const bridge = createBridge({
  workerUrl: `http://127.0.0.1:${worker.address().port}`,
  deviceId: "robot-1",
  deviceSecret: "s",
  pairingFile,
  eyesFile,
  log: (l) => logLines.push(l),
});
bridge.listen(0, "127.0.0.1");
await once(bridge, "listening");
const base = `127.0.0.1:${bridge.address().port}`;
after(() => {
  bridge.close();
  worker.close();
});

async function connectRobot() {
  const ota = await (await fetch(`http://${base}/xiaozhi/ota/`, { method: "POST", headers: { "Device-Id": "aa:bb" } })).json();
  const robot = new WebSocket(ota.websocket.url, { headers: { Authorization: `Bearer ${ota.websocket.token}`, "Device-Id": "aa:bb" } });
  await once(robot, "open");
  const messages = [];
  robot.on("message", (data, isBinary) => !isBinary && messages.push(JSON.parse(data.toString())));
  robot.send(JSON.stringify({ type: "hello", version: 1, transport: "websocket", features: { mcp: true } }));
  return { robot, messages };
}

const waitFor = async (pred) => {
  const end = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("new eyes: the robot gets the download address, then a restart, then downloads them once", async () => {
  const { robot, messages } = await connectRobot();
  await waitFor(() => messages.some((m) => m.type === "mcp"));
  const setUrl = messages.find((m) => m.type === "mcp").payload;
  assert.equal(setUrl.method, "tools/call");
  assert.equal(setUrl.params.name, "self.assets.set_download_url");
  assert.equal(setUrl.params.arguments.url, `http://${base}/xiaozhi/assets.bin`);

  robot.send(JSON.stringify({ type: "mcp", payload: { jsonrpc: "2.0", id: setUrl.id, result: { content: [{ type: "text", text: "true" }], isError: false } } }));
  await waitFor(() => messages.filter((m) => m.type === "mcp").length === 2);
  assert.equal(messages.filter((m) => m.type === "mcp")[1].payload.params.name, "self.reboot");
  robot.close();

  // the robot restarts and downloads
  const res = await fetch(`http://${base}/xiaozhi/assets.bin`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), eyes);
  await waitFor(() => JSON.parse(readFileSync(pairingFile, "utf8")).eyes);

  // next connection: no more eyes, straight to the conversation
  const again = await connectRobot();
  await waitFor(() => again.messages.some((m) => m.type === "hello"));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!again.messages.some((m) => m.type === "mcp"));
  again.robot.close();
});

test("if the robot never downloads, it is asked at most twice", async () => {
  writeFileSync(eyesFile, withEyes(stock, { ...gifs, happy: gifs.neutral })); // different eyes
  for (let i = 0; i < 3; i++) {
    const { robot, messages } = await connectRobot();
    await waitFor(() => messages.some((m) => m.type === "hello"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(messages.some((m) => m.type === "mcp"), i < 2, `connection ${i + 1}`);
    robot.close();
  }
});
