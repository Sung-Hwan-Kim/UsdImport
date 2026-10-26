"use client";

import { diagnosticCount } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Crosshair, FilePlus, FolderOpen, Maximize2, Minimize2, Save, SaveAll, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { stagePathOf } from "@/lib/scene";
import { scriptExtensions } from "@/lib/scripts/editor";
import { forgetHandle, pickScripts, saveScript } from "@/lib/scripts/files";
import { isDirty, useScripts, type ScriptDoc } from "@/lib/scripts/store";
import { SCRIPT_TEMPLATES, type ScriptTemplate } from "@/lib/scripts/templates";
import { useViewer } from "@/lib/store";
import { cn, IconButton, MenuItem, Popover } from "./ui";

interface Status {
  line: number;
  col: number;
  errors: number;
}

const MIN_HEIGHT = 140;

function uniqueName(name: string, docs: ScriptDoc[]): string {
  if (!docs.some((d) => d.name === name)) return name;
  const [, stem, ext] = /^(.*?)(\.[^.]*)?$/.exec(name)!;
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}${ext ?? ""}`;
    if (!docs.some((d) => d.name === candidate)) return candidate;
  }
}

function newFromTemplate(template: ScriptTemplate): void {
  const { stage, selected } = useViewer.getState();
  const { docs, addDoc } = useScripts.getState();
  const content = template.build({ stageName: stage?.name, primPath: selected ? stagePathOf(selected) : undefined });
  // A new script has nothing on disk yet, so anything in it is unsaved.
  addDoc(uniqueName(template.fileName, docs), content, "");
}

function TemplateMenu({ side = "bottom" }: { side?: "top" | "bottom" }) {
  return (
    <Popover side={side} trigger={({ toggle, open }) => <IconButton icon={FilePlus} label="새 스크립트 (템플릿)" active={open} onClick={toggle} />}>
      {(close) => (
        <div className="w-72">
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">새 스크립트</div>
          {SCRIPT_TEMPLATES.map((t) => (
            <MenuItem
              key={t.id}
              hint={t.hint}
              onClick={() => {
                close();
                newFromTemplate(t);
              }}
            >
              {t.title}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function EmptyEditor() {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-bg p-6">
      <div className="w-full max-w-md text-center">
        <div className="text-[14px] font-medium text-fg">Isaac Sim Python 스크립트</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          .py 파일을 열거나 화면에 끌어다 놓으세요. 템플릿으로 새로 시작할 수도 있습니다.
        </p>
        <button
          type="button"
          onClick={() => void pickScripts()}
          className="mt-4 inline-flex h-8 items-center gap-2 rounded-md bg-accent-strong px-3 text-[13px] font-medium text-white hover:bg-accent"
        >
          <FolderOpen className="size-4" strokeWidth={1.75} />
          스크립트 열기
        </button>
        <div className="mt-5 grid gap-1 text-left">
          {SCRIPT_TEMPLATES.filter((t) => t.id !== "empty").map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => newFromTemplate(t)}
              className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-[12.5px] hover:border-line-strong hover:bg-hover"
            >
              <span className="text-fg">{t.title}</span>
              <span className="text-[11px] text-faint">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Editor dock for Isaac Sim Python scripts: tabs, templates, open/save
 * (in place where the browser allows), Isaac Sim / OpenUSD completion and
 * Python syntax checking. Each tab keeps its own CodeMirror state, so undo
 * history and cursor survive switching tabs.
 */
export default function ScriptEditor() {
  const docs = useScripts((s) => s.docs);
  const activeId = useScripts((s) => s.activeId);
  const height = useScripts((s) => s.height);
  const maximized = useScripts((s) => s.maximized);
  const selected = useViewer((s) => s.selected);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef<string | null>(null);
  const noticeTimer = useRef(0);
  const [status, setStatus] = useState<Status>({ line: 1, col: 1, errors: 0 });
  const [notice, setNotice] = useState<string | null>(null);

  const showNotice = (text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2500);
  };

  const save = async (id: string, as = false) => {
    try {
      const result = await saveScript(id, { as });
      const name = useScripts.getState().docs.find((d) => d.id === id)?.name;
      if (result === "saved") showNotice(`${name} 저장됨`);
      else if (result === "downloaded") showNotice(`${name} 다운로드됨 (이 브라우저는 파일에 직접 저장할 수 없습니다)`);
    } catch (e) {
      showNotice(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const createState = (id: string, content: string) =>
    EditorState.create({
      doc: content,
      extensions: scriptExtensions({
        onSave: () => void save(id),
        onChange: (state, docChanged) => {
          if (docChanged) useScripts.getState().setContent(id, state.doc.toString());
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          const next = { line: line.number, col: head - line.from + 1, errors: diagnosticCount(state) };
          setStatus((prev) => (prev.line === next.line && prev.col === next.col && prev.errors === next.errors ? prev : next));
        },
      }),
    });

  useEffect(() => {
    const v = new EditorView({ parent: host.current! });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
      shown.current = null;
    };
  }, []);

  // Show the active tab, parking the previous tab's state (undo history, cursor) for later.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (shown.current && shown.current !== activeId) states.current.set(shown.current, v.state);
    const doc = useScripts.getState().docs.find((d) => d.id === activeId);
    if (!doc || shown.current === doc.id) return;
    let state = states.current.get(doc.id);
    if (!state || state.doc.toString() !== doc.content) state = createState(doc.id, doc.content);
    v.setState(state);
    shown.current = doc.id;
    v.focus();
    // createState only closes over stable setters and store accessors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const closeTab = (doc: ScriptDoc) => {
    if (isDirty(doc) && !window.confirm(`${doc.name}에 저장하지 않은 변경 사항이 있습니다. 닫을까요?`)) return;
    states.current.delete(doc.id);
    if (shown.current === doc.id) shown.current = null;
    forgetHandle(doc.id);
    useScripts.getState().closeDoc(doc.id);
  };

  const insertPrimPath = () => {
    const v = view.current;
    if (!v || !selected || !shown.current) return;
    v.dispatch(v.state.replaceSelection(`"${stagePathOf(selected)}"`));
    v.focus();
  };

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startHeight = height;
    const available = e.currentTarget.parentElement?.parentElement?.clientHeight ?? window.innerHeight;
    const move = (ev: PointerEvent) => {
      const next = Math.min(Math.max(startHeight + startY - ev.clientY, MIN_HEIGHT), available - 80);
      useScripts.getState().setHeight(Math.round(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const active = docs.find((d) => d.id === activeId) ?? null;
  const { setActive, setOpen, setMaximized } = useScripts.getState();

  return (
    <section
      className={cn("flex flex-col border-t border-line bg-panel", maximized ? "absolute inset-0 z-20" : "relative shrink-0")}
      // Leave the viewport some room on short screens, whatever height was dragged to.
      style={maximized ? undefined : { height, maxHeight: "70%" }}
      aria-label="스크립트 에디터"
    >
      {!maximized && (
        <div
          onPointerDown={onResizeStart}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-accent/30"
          title="끌어서 높이 조절"
        />
      )}
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1">
        <div className="scroll-thin flex min-w-0 flex-1 items-stretch self-stretch overflow-x-auto">
          {docs.map((d) => (
            <div
              key={d.id}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 border-r border-line pr-1 pl-3 text-[12.5px]",
                d.id === activeId ? "bg-bg text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <button type="button" onClick={() => setActive(d.id)} className="max-w-48 truncate py-1.5" title={d.name}>
                {d.name}
              </button>
              <span className={cn("size-1.5 shrink-0 rounded-full", isDirty(d) ? "bg-warn" : "bg-transparent")} title={isDirty(d) ? "저장 안 됨" : undefined} />
              <button
                type="button"
                onClick={() => closeTab(d)}
                aria-label={`${d.name} 닫기`}
                className="rounded p-0.5 text-faint opacity-60 group-hover:opacity-100 hover:bg-line-strong hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <TemplateMenu />
        <IconButton icon={FolderOpen} label="스크립트 열기 (.py)" onClick={() => void pickScripts()} />
        <IconButton icon={Save} label="저장" shortcut="Ctrl+S" disabled={!active} onClick={() => active && void save(active.id)} />
        <IconButton icon={SaveAll} label="다른 이름으로 저장" disabled={!active} onClick={() => active && void save(active.id, true)} className="max-sm:hidden" />
        <IconButton
          icon={Crosshair}
          label={selected ? `선택한 프림 경로 삽입 (${stagePathOf(selected)})` : "선택한 프림 경로 삽입 (뷰어에서 프림을 선택하세요)"}
          disabled={!active || !selected}
          onClick={insertPrimPath}
        />
        <div className="mx-0.5 h-5 w-px bg-line" />
        <IconButton icon={maximized ? Minimize2 : Maximize2} label={maximized ? "원래 크기" : "최대화"} onClick={() => setMaximized(!maximized)} />
        <IconButton icon={X} label="에디터 닫기" shortcut="E" onClick={() => setOpen(false)} />
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {!active && <EmptyEditor />}
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-3 font-mono text-[11px] text-faint">
        {active && (
          <>
            <span>
              줄 {status.line}, 열 {status.col}
            </span>
            {status.errors > 0 && <span className="text-danger">문법 오류 {status.errors}</span>}
          </>
        )}
        {notice && <span className="truncate font-sans text-ok">{notice}</span>}
        <span className="ml-auto whitespace-nowrap">Python · Isaac Sim 6.x</span>
      </footer>
    </section>
  );
}
