import { SpecType, parentPath, pathName, propertyPath, type SdfLayer, type SdfSpec, type SdfValue } from "./data";

/** A change the viewer made to a prim, authored into the saved root layer. */
export interface PrimEdit {
  /** Composed prim path, which is also its path in the root layer's namespace. */
  path: string;
  /** Local transform as a row-major 4x4 (USD's row-vector convention). */
  matrix?: number[];
  /** The prim ignores its parent's transform (`!resetXformStack!`). */
  resetXformStack?: boolean;
  visibility?: "inherited" | "invisible";
  /** Mesh points in the prim's local space, flat xyz (e.g. a simulated cloth). */
  points?: Float32Array;
}

/**
 * Author edits as opinions in the root layer, creating `over` specs where the
 * layer has none (the prim may come from a reference or sublayer). A
 * transform becomes a single matrix op, which replaces whatever op stack and
 * animation weaker opinions had.
 */
export function applyEdits(layer: SdfLayer, edits: PrimEdit[]): void {
  for (const edit of edits) {
    ensurePrim(layer, edit.path);
    if (edit.matrix) {
      setAttribute(layer, edit.path, "xformOp:transform", "matrix4d", { type: "matrix4d", value: edit.matrix });
      const order = edit.resetXformStack ? ["!resetXformStack!", "xformOp:transform"] : ["xformOp:transform"];
      setAttribute(layer, edit.path, "xformOpOrder", "token[]", { type: "token[]", value: order }, true);
    }
    if (edit.visibility) setAttribute(layer, edit.path, "visibility", "token", { type: "token", value: edit.visibility });
    if (edit.points) setAttribute(layer, edit.path, "points", "point3f[]", { type: "float3[]", value: edit.points });
  }
}

function ensurePrim(layer: SdfLayer, path: string): SdfSpec {
  const existing = layer.spec(path);
  if (existing) return existing;
  const parent = parentPath(path);
  const parentSpec = parent === "/" ? layer.root : ensurePrim(layer, parent);
  const spec: SdfSpec = { type: SpecType.Prim, fields: new Map([["specifier", { type: "specifier", value: "over" }]]) };
  layer.specs.set(path, spec);
  appendName(parentSpec, "primChildren", pathName(path));
  return spec;
}

function appendName(spec: SdfSpec, field: string, name: string): void {
  const list = spec.fields.get(field)?.value as string[] | undefined;
  if (list?.includes(name)) return;
  spec.fields.set(field, { type: "tokenVector", value: [...(list ?? []), name] });
}

function setAttribute(layer: SdfLayer, prim: string, name: string, typeName: string, value: SdfValue, uniform = false): void {
  const path = propertyPath(prim, name);
  let spec = layer.spec(path);
  if (!spec || spec.type !== SpecType.Attribute) {
    spec = { type: SpecType.Attribute, fields: new Map([["typeName", { type: "token", value: typeName }]]) };
    if (uniform) spec.fields.set("variability", { type: "variability", value: "uniform" });
    layer.specs.set(path, spec);
    appendName(layer.spec(prim)!, "properties", name);
  }
  spec.fields.set("default", value);
  // Samples in the same layer would win over the new default.
  spec.fields.delete("timeSamples");
}

