import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python, pythonLanguage } from "@codemirror/lang-python";
import {
  bracketMatching,
  ensureSyntaxTree,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { linter, lintGutter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { isaacCompletions } from "./completion";

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--color-bg)", color: "var(--color-fg)", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--color-accent)", padding: "6px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgb(91 157 255 / 0.28)",
    },
    ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 0.035)" },
    ".cm-selectionMatch": { backgroundColor: "rgb(91 157 255 / 0.16)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgb(91 157 255 / 0.22)", outline: "none" },
    ".cm-gutters": { backgroundColor: "var(--color-panel)", color: "var(--color-faint)", borderRight: "1px solid var(--color-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--color-raised)", color: "var(--color-fg)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--color-raised)", border: "1px solid var(--color-line-strong)", color: "var(--color-muted)" },
    ".cm-tooltip": { backgroundColor: "var(--color-raised)", border: "1px solid var(--color-line-strong)", borderRadius: "6px", color: "var(--color-fg)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12.5px", maxHeight: "16em" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--color-accent-soft)", color: "var(--color-fg)" },
    ".cm-completionDetail": { color: "var(--color-faint)", fontStyle: "normal", marginLeft: "0.75em" },
    ".cm-completionMatchedText": { color: "var(--color-accent)", textDecoration: "none" },
    ".cm-completionInfo": { padding: "6px 9px", fontFamily: "var(--font-sans)", fontSize: "12px", whiteSpace: "pre-line" },
    ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-fg)", borderTop: "1px solid var(--color-line)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-line)" },
    ".cm-search input, .cm-search button": { fontSize: "12px" },
    ".cm-textfield": { backgroundColor: "var(--color-bg)", border: "1px solid var(--color-line-strong)", borderRadius: "4px", color: "var(--color-fg)" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--color-raised)", border: "1px solid var(--color-line-strong)", borderRadius: "4px", color: "var(--color-fg)" },
    ".cm-searchMatch": { backgroundColor: "rgb(242 184 75 / 0.25)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(242 184 75 / 0.5)" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--color-danger)" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--color-danger)", textUnderlineOffset: "3px" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c792ea" },
  { tag: [t.string, t.special(t.string)], color: "#a6d189" },
  { tag: [t.number, t.bool, t.null], color: "#f2b84b" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#5c6575", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: "#82aaff" },
  { tag: [t.className, t.definition(t.className), t.typeName], color: "#ffcb6b" },
  { tag: [t.self, t.special(t.variableName)], color: "#f78c6c" },
  { tag: [t.propertyName], color: "#b8c4d6" },
  { tag: [t.meta, t.annotation], color: "#89ddff" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#8b94a4" },
  { tag: t.invalid, color: "var(--color-danger)" },
]);

/** Parse errors from the Python grammar, so typos show up before the script reaches Isaac Sim. */
const syntaxErrors = linter(
  (view) => {
    const { state } = view;
    const tree = ensureSyntaxTree(state, state.doc.length, 200);
    if (!tree) return [];
    const diagnostics: Diagnostic[] = [];
    tree.iterate({
      enter: (node) => {
        if (!node.type.isError) return;
        const from = Math.min(node.from, state.doc.length);
        diagnostics.push({ from, to: Math.min(Math.max(node.to, from + 1), state.doc.length), severity: "error", message: "Python 문법 오류" });
      },
    });
    return diagnostics;
  },
  { delay: 400 },
);

/** Everything a script tab's EditorState needs; `onSave` runs on Ctrl/Cmd+S, `onRun` on Ctrl/Cmd+Enter (as in Isaac Sim's Script Editor). */
export function scriptExtensions({
  onSave,
  onRun,
  onChange,
}: {
  onSave: () => void;
  onRun: () => void;
  onChange: (state: EditorState, docChanged: boolean) => void;
}): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    lintGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    python(),
    pythonLanguage.data.of({ autocomplete: isaacCompletions }),
    syntaxHighlighting(highlight),
    syntaxErrors,
    theme,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSave();
          return true;
        },
      },
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: () => {
          onRun();
          return true;
        },
      },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    // Every update, so lint results (which arrive as effects) reach the status bar too.
    EditorView.updateListener.of((update) => onChange(update.state, update.docChanged)),
  ];
}
