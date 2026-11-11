import { Image } from "microsandbox";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: node examples/import-image.mjs /absolute/path/to/docker-save.tar");
const loaded = await Image.load(archive);
const image = loaded[0];
if (!image?.manifestDigest) throw new Error("The imported image has no manifest digest; inspect the archive before running it.");
const pinned = `${image.reference.split("@")[0]}@${image.manifestDigest}`;
await Image.load(archive, { tag: pinned });
console.log(pinned);
