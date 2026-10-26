import { readCrate } from "./crateReader";
import { writeCrate } from "./crateWriter";
import type { SdfLayer } from "./data";
import { readUsda } from "./usdaReader";
import { writeUsda } from "./usdaWriter";

export type LayerFileFormat = "usda" | "usdc";

const textEncoder = new TextEncoder();

export function detectLayerFormat(bytes: Uint8Array): LayerFileFormat {
  return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === "PXR-USDC" ? "usdc" : "usda";
}

/** Read a .usda/.usdc/.usd layer losslessly. */
export function readLayer(bytes: Uint8Array): SdfLayer {
  if (detectLayerFormat(bytes) === "usdc") return readCrate(bytes);
  return readUsda(new TextDecoder().decode(bytes));
}

export function writeLayer(layer: SdfLayer, format: LayerFileFormat): Uint8Array {
  return format === "usda" ? textEncoder.encode(writeUsda(layer)) : writeCrate(layer);
}
