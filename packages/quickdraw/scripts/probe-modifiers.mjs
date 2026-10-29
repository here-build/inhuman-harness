// Run in the affected terminal: node packages/quickdraw/scripts/probe-modifiers.mjs
import { createTtySession } from "../dist/runtime/tty.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this directly in the affected iTerm terminal.");
  process.exit(1);
}

const write = (text) => process.stdout.write(text);
const originalRaw = process.stdin.isRaw;
const results = [];
let current;
let inScreen = false;
const tty = createTtySession();
function restore() {
  if (inScreen) {
    write(tty.exitBytes());
    inScreen = false;
  }
}
process.on("exit", () => {
  restore();
  process.stdin.setRawMode(originalRaw ?? false);
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const bytes = chunk.toString("utf8");
  current?.bytes.push(bytes);
  write(`${JSON.stringify(bytes)}\r\n`);
});

for (const [name, setup] of [
  ["Current app setup", tty.enterBytes()],
  ["Kitty only", "\u001B[?1049h\u001B[>11u\u001B[=11;1u"],
  ["modifyOtherKeys first, Kitty last", "\u001B[?1049h\u001B[>4;2m\u001B[>11u\u001B[=11;1u"],
]) {
  current = { name, bytes: [] };
  results.push(current);
  inScreen = true;
  write(setup);
  write(`\u001B[2J\u001B[H${name}\r\nFor 8 seconds: press/release Ctrl, then Cmd, then type a.\r\n`);
  // A supporting terminal replies CSI ? flags u; this is also captured.
  write("\u001B[?u");
  await new Promise((resolve) => setTimeout(resolve, 8000));
  restore();
}
process.stdin.setRawMode(originalRaw ?? false);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
