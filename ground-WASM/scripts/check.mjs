// Verifies this folder's build receipts: every recorded source still has its
// hash, and every binary has its recorded size and hash, fits the size limit
// and validates. It does not run the core; the parity checks do that.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(readFileSync(path.join(root, "toolchain.lock.json")));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const receipts = ["build-metadata.json", "shared-build-metadata.json"].filter(file => existsSync(path.join(root, file)));
if (!receipts.length) throw new Error(`No build receipt in ${root}`);
for (const receipt of receipts) {
  const metadata = JSON.parse(readFileSync(path.join(root, receipt)));
  if (metadata.schema !== 1) throw new Error(`Unsupported receipt schema: ${receipt}`);
  for (const [file, digest] of Object.entries(metadata.inputs)) {
    if (hash(readFileSync(path.join(root, file))) !== digest) throw new Error(`Source changed since ${receipt}: ${file}; rebuild`);
  }
  for (const [file, output] of Object.entries(metadata.outputs)) {
    const bytes = readFileSync(path.join(root, file));
    if (bytes.length !== output.bytes || hash(bytes) !== output.sha256 || bytes.length > lock.maximumBinaryBytes || !WebAssembly.validate(bytes)) {
      throw new Error(`Binary differs from ${receipt}: ${file}`);
    }
  }
}
console.log(`${path.basename(root)}: source and binary receipts, size and Node validation pass; parity, browser, performance and power qualification are separate`);
