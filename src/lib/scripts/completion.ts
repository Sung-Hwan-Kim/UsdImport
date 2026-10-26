import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { ISAAC_MODULES, MODULE_BY_PATH, type ApiMember, type ApiModule } from "./isaacsim";

const TYPE: Record<ApiMember["kind"], string> = { module: "namespace", class: "class", function: "function", constant: "constant" };

function memberOption(m: ApiMember, legacy?: string): Completion {
  return {
    label: m.name,
    type: TYPE[m.kind],
    detail: m.detail,
    info: [m.info, legacy && `레거시: ${legacy}`].filter(Boolean).join("\n") || undefined,
    boost: legacy ? -10 : 0,
  };
}

function moduleOption(m: ApiModule): Completion {
  return { label: m.path, type: "namespace", detail: m.legacy ? "레거시" : undefined, info: [m.info, m.legacy].filter(Boolean).join(" · "), boost: m.legacy ? -10 : 0 };
}

/** Names bound by the script's imports: alias -> module path, or alias -> "module:member". */
function importBindings(doc: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const [, path, alias] of doc.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm)) {
    // `import a.b.c` binds `a`; `a.b.c.` then resolves through the dotted path.
    if (alias) bindings.set(alias, path);
    else bindings.set(path.split(".")[0], path.split(".")[0]);
  }
  // `from x import a, b as c` on one line, or a parenthesized list across lines.
  for (const [, from, listed, inline] of doc.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n#]*))/gm)) {
    for (const part of (listed ?? inline).split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (!name) continue;
      const sub = `${from}.${name}`;
      bindings.set(alias ?? name, MODULE_BY_PATH.has(sub) ? sub : `${from}:${name}`);
    }
  }
  return bindings;
}

/**
 * Isaac Sim / OpenUSD completions: module paths after `import`/`from`, a
 * module's members after `from x import`, and `alias.` members for modules
 * the script imported (e.g. `stage_utils.` after
 * `import isaacsim.core.experimental.utils.stage as stage_utils`).
 */
export function isaacCompletions(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  const importPath = /^\s*(?:from|import)\s+([\w.]*)$/.exec(before);
  if (importPath) {
    return { from: context.pos - importPath[1].length, options: ISAAC_MODULES.map(moduleOption), validFor: /^[\w.]*$/ };
  }

  const fromImport = /^\s*from\s+([\w.]+)\s+import\s+(?:\(?[\w\s,]*,\s*)?(\w*)$/.exec(before);
  if (fromImport) {
    const target = MODULE_BY_PATH.get(fromImport[1]);
    if (!target) return null;
    const subModules = ISAAC_MODULES.filter((m) => m.path.startsWith(`${target.path}.`) && !m.path.slice(target.path.length + 1).includes("."));
    return {
      from: context.pos - fromImport[2].length,
      options: [
        ...target.members.map((m) => memberOption(m, target.legacy)),
        ...subModules.map((m) => ({ ...moduleOption(m), label: m.path.slice(target.path.length + 1) })),
      ],
      validFor: /^\w*$/,
    };
  }

  const dotted = /([A-Za-z_][\w.]*)\.(\w*)$/.exec(before);
  if (dotted) {
    const [head, ...rest] = dotted[1].split(".");
    const bound = importBindings(context.state.doc.toString()).get(head);
    if (!bound || bound.includes(":")) return null;
    const target = MODULE_BY_PATH.get([bound, ...rest].join("."));
    if (!target) return null;
    const children = ISAAC_MODULES.filter((m) => m.path.startsWith(`${target.path}.`) && !m.path.slice(target.path.length + 1).includes("."));
    return {
      from: context.pos - dotted[2].length,
      options: [
        ...target.members.map((m) => memberOption(m, target.legacy)),
        ...children.map((m) => ({ ...moduleOption(m), label: m.path.slice(target.path.length + 1) })),
      ],
      validFor: /^\w*$/,
    };
  }
  return null;
}
