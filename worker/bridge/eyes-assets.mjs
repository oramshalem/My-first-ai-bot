// Builds an assets.bin for the robot with Piko's eyes in place of the stock emoji.
//
// xiaozhi keeps its fonts, speech models and faces in a flash partition called
// "assets". Its layout (scripts/spiffs_assets/spiffs_assets_gen.py and main/assets.cc
// in github.com/78/xiaozhi-esp32):
//
//   u32 file count, u32 checksum, u32 length of everything after these 12 bytes
//   per file: name (32 bytes, NUL padded), u32 size, u32 offset, u16 width, u16 height
//   per file: "ZZ" then the file's bytes, at the offset given in the table
//
// The checksum is the byte sum of everything after the 12 byte header, masked to 16 bits.
//
// We start from the assets inside the firmware the robot was flashed with, so the
// fonts and speech models stay exactly as they were, and only swap the faces and
// the screen colors.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const NAME_LEN = 32;
const ENTRY_LEN = NAME_LEN + 12;

// Every emotion name the firmware or a xiaozhi server may ask for, mapped to one of
// our GIFs. A name missing from the list would fall back to a small stock emoji.
export const EMOTIONS = {
  neutral: ["neutral", "relaxed", "cool", "confident", "sad", "angry", "crying", "surprised", "shocked", "listening"],
  happy: ["happy", "laughing", "funny", "loving", "winking", "delicious", "kissy", "silly"],
  thinking: ["thinking", "confused", "embarrassed"],
  speaking: ["speaking"],
  sleepy: ["sleepy"],
};

// The screen behind the eyes, and the color of the status text over them.
const SKIN = { text_color: "#FFFFFF", background_color: "#07040C" };

export function unpackAssets(buf) {
  if (buf.length < 12) throw new Error("assets data is too short");
  const count = buf.readUInt32LE(0);
  const checksum = buf.readUInt32LE(4);
  const length = buf.readUInt32LE(8);
  if (count === 0 || count > 10000 || length + 12 > buf.length) throw new Error("this is not a xiaozhi assets partition");
  const body = buf.subarray(12, 12 + length);
  if (byteSum(body) !== checksum) throw new Error("assets checksum does not match, the file may be damaged");
  const dataStart = count * ENTRY_LEN;
  const files = [];
  for (let i = 0; i < count; i++) {
    const e = body.subarray(i * ENTRY_LEN, (i + 1) * ENTRY_LEN);
    const name = e.subarray(0, NAME_LEN).toString("utf8").replace(/\0.*$/s, "");
    const size = e.readUInt32LE(NAME_LEN);
    const offset = e.readUInt32LE(NAME_LEN + 4);
    const at = dataStart + offset;
    if (body[at] !== 0x5a || body[at + 1] !== 0x5a) throw new Error(`asset ${name} has a bad marker`);
    files.push({
      name,
      width: e.readUInt16LE(NAME_LEN + 8),
      height: e.readUInt16LE(NAME_LEN + 10),
      data: body.subarray(at + 2, at + 2 + size),
    });
  }
  return files;
}

export function packAssets(files) {
  const table = Buffer.alloc(files.length * ENTRY_LEN);
  const chunks = [];
  let offset = 0;
  files.forEach((f, i) => {
    const name = Buffer.from(f.name, "utf8");
    if (name.length >= NAME_LEN) throw new Error(`asset name too long: ${f.name}`);
    const e = table.subarray(i * ENTRY_LEN);
    name.copy(e);
    e.writeUInt32LE(f.data.length, NAME_LEN);
    e.writeUInt32LE(offset, NAME_LEN + 4);
    e.writeUInt16LE(f.width ?? 0, NAME_LEN + 8);
    e.writeUInt16LE(f.height ?? 0, NAME_LEN + 10);
    chunks.push(Buffer.from([0x5a, 0x5a]), f.data);
    offset += 2 + f.data.length;
  });
  const body = Buffer.concat([table, ...chunks]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(files.length, 0);
  header.writeUInt32LE(byteSum(body), 4);
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}

// Finds the "assets" partition in a merged firmware image (partition table at 0x8000).
export function assetsFromFirmware(image) {
  for (let at = 0x8000; at + 32 <= Math.min(image.length, 0x9000); at += 32) {
    if (image.readUInt16LE(at) !== 0x50aa) break;
    const offset = image.readUInt32LE(at + 4);
    const size = image.readUInt32LE(at + 8);
    const label = image.subarray(at + 12, at + 28).toString("utf8").replace(/\0.*$/s, "");
    if (label === "assets") {
      if (offset >= image.length) throw new Error("the firmware file ends before the assets partition");
      return image.subarray(offset, Math.min(offset + size, image.length));
    }
  }
  throw new Error("no assets partition in this firmware file. Is it merged-binary.bin?");
}

// gifs: { neutral: Buffer, happy: Buffer, ... } for every key of EMOTIONS
export function withEyes(stockAssets, gifs) {
  const files = unpackAssets(stockAssets);
  const indexFile = files.find((f) => f.name === "index.json");
  if (!indexFile) throw new Error("the stock assets have no index.json");
  const index = JSON.parse(indexFile.data.toString("utf8"));

  // drop the stock faces and any old skin images; keep fonts, models and everything else
  const drop = new Set();
  for (const e of index.emoji_collection ?? []) if (e.file) drop.add(e.file);
  for (const theme of Object.values(index.skin ?? {})) if (theme?.background_image) drop.add(theme.background_image);
  const kept = files.filter((f) => f.name !== "index.json" && !drop.has(f.name));

  const eyes = Object.keys(EMOTIONS).map((key) => {
    const data = gifs[key];
    if (!data) throw new Error(`missing ${key}.gif`);
    return { name: `eyes_${key}.gif`, width: data.readUInt16LE(6), height: data.readUInt16LE(8), data };
  });
  index.emoji_collection = Object.entries(EMOTIONS).flatMap(([key, names]) =>
    names.map((name) => ({ name, file: `eyes_${key}.gif` })),
  );
  index.skin = { light: { ...SKIN }, dark: { ...SKIN } };

  const newIndex = { name: "index.json", width: 0, height: 0, data: Buffer.from(JSON.stringify(index)) };
  return packAssets([...kept, ...eyes, newIndex]);
}

export function readEyeGifs(dir) {
  const gifs = {};
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(\w+)\.gif$/);
    if (m) gifs[m[1]] = readFileSync(new URL(file, dir));
  }
  return gifs;
}

export const md5 = (buf) => createHash("md5").update(buf).digest("hex");

function byteSum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum & 0xffff;
}
