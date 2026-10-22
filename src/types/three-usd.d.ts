// three ships the USD parsers/composer without type declarations; these cover
// the public entry points plus the internals the viewer extends.

declare module "three/examples/jsm/loaders/usd/USDCParser.js" {
  export interface USDSpec {
    specType: number;
    fields: Record<string, unknown>;
  }

  export interface USDLayerData {
    specsByPath: Record<string, USDSpec>;
  }

  export interface CrateBinaryReader {
    seek(offset: number): void;
    tell(): number;
    readUint8(): number;
    readUint32(): number;
    readUint64(): number;
    readInt64(): number;
    readFloat64(): number;
  }

  export interface CrateValueRep {
    readonly typeEnum: number;
    getInlinedValue(): number;
  }

  export class USDCParser {
    parseData(buffer: ArrayBuffer): USDLayerData;
    protected buffer: ArrayBuffer;
    protected sections: Record<string, { start: number; size: number }>;
    protected reader: CrateBinaryReader;
    protected tokens: string[];
    protected strings: number[];
    protected paths: string[];
    protected version: { major: number; minor: number; patch: number };
    protected _readPaths(): void;
    protected _readScalarValue(type: number): unknown;
    protected _readInlinedValue(valueRep: CrateValueRep): unknown;
  }
}

declare module "three/examples/jsm/loaders/usd/USDAParser.js" {
  import type { USDLayerData } from "three/examples/jsm/loaders/usd/USDCParser.js";

  export class USDAParser {
    parseData(text: string): USDLayerData;
  }
}

declare module "three/examples/jsm/loaders/usd/USDComposer.js" {
  import type { Group, LoadingManager, Material, Mesh, Object3D, Texture } from "three";
  import type { USDLayerData, USDSpec } from "three/examples/jsm/loaders/usd/USDCParser.js";

  export class USDComposer {
    constructor(manager?: LoadingManager | null);
    manager: LoadingManager | null;
    textureCache: Record<string, Texture>;
    texturePromises: Promise<void>[];
    specsByPath: Record<string, USDSpec>;
    assets: Record<string, unknown>;
    basePath: string;
    externalVariantSelections: Record<string, string>;

    compose(
      parsedData: USDLayerData,
      assets?: Record<string, unknown>,
      variantSelections?: Record<string, string>,
      basePath?: string,
    ): Group;

    protected _buildHierarchy(parent: Object3D, parentPath: string): void;
    protected _resolveReference(refValue: string, localVariants?: Record<string, string>): Group | null;
    protected _resolveFilePath(refPath: string): string;
    protected _getReferences(spec: USDSpec): string[];
    protected _getVariantPaths(parentPath: string): string[];
    protected _getAttributes(path: string): Record<string, unknown>;
    protected _getGeomSubsets(meshPath: string): { name: string; indices: ArrayLike<number>; materialPath: string | null }[];
    protected _findSingleMesh(group: Object3D): Mesh | null;
    protected _hasNonIdentityTransform(obj: Object3D): boolean;
    protected _loadTexture(filePath: string, textureAttrs: unknown, transformAttrs: unknown): Texture | null;
    protected _applyMaterial(material: Material, materialPath: string): void;
    protected _getMaterialPath(meshPath: string, fields: Record<string, unknown>): string | null;
    protected _buildMaterial(meshPath: string, fields: Record<string, unknown>): Material;
  }
}
