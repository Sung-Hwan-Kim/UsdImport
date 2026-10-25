// Copies the PhysX wasm next to the app so the browser can fetch it from
// /physx/ (bundlers do not reliably follow the package's import.meta.url).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const source = new URL("../node_modules/physx-js-webidl/physx-js-webidl.wasm", import.meta.url);
const targetDir = new URL("../public/physx/", import.meta.url);

if (!existsSync(source)) {
  console.warn("[copy-physx-wasm] physx-js-webidl is not installed; skipping.");
} else {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, new URL("physx-js-webidl.wasm", targetDir));
}
