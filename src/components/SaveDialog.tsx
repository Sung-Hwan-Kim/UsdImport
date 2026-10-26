"use client";

import { Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveAs } from "@/lib/fileAccess";
import { encodeStageInBrowser, encodeStageOnServer, probeServer, savedFileName, type SaveFormat } from "@/lib/usd/saveStage";
import { UnsupportedUsdError } from "@/lib/usd/sdf/data";
import { collectStageEdits } from "@/lib/usd/stageEdits";
import { useViewer } from "@/lib/store";
import { cn, IconButton, Segmented } from "./ui";

const FORMATS: { value: SaveFormat; label: string; title: string }[] = [
  { value: "usda", label: "USDA", title: "텍스트" },
  { value: "usdc", label: "USDC", title: "바이너리 (Crate)" },
  { value: "usd", label: "USD", title: "바이너리 (Crate), .usd 확장자" },
];

type Method = "browser" | "server";
type ServerState = "checking" | "online" | "offline";

function initialFormat(rootPath: string): SaveFormat {
  const ext = /\.([^./]+)$/.exec(rootPath)?.[1]?.toLowerCase();
  return ext === "usda" || ext === "usdc" || ext === "usd" ? ext : "usda";
}

/**
 * Save the open stage's root layer with what the viewer changed authored into
 * it (simulated poses, cloth shapes, shown/hidden prims), as USDA or USDC.
 * Converts in the browser, or through OpenUSD on the local server when it runs.
 */
function SaveDialogBody({ onClose }: { onClose: () => void }) {
  const stage = useViewer((s) => s.stage)!;
  const session = useViewer((s) => s.session);
  const serverUrl = useViewer((s) => s.settings.newtonUrl);
  const [format, setFormat] = useState<SaveFormat>(() => initialFormat(stage.rootPath));
  const [name, setName] = useState(() => savedFileName(stage, initialFormat(stage.rootPath)));
  const [server, setServer] = useState<ServerState>("checking");
  const [method, setMethod] = useState<Method>("browser");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const summary = useMemo(() => collectStageEdits(stage), [stage]);
  const usdz = stage.rootFormat === "usdz";
  const hasExternalLayers = stage.layers.size > 1;

  useEffect(() => {
    let cancelled = false;
    void probeServer(serverUrl).then((online) => {
      if (cancelled) return;
      setServer(online ? "online" : "offline");
      // OpenUSD itself is the safest writer when it is available.
      if (online) setMethod("server");
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const chooseFormat = (next: SaveFormat) => {
    setFormat(next);
    setName((n) => n.replace(/\.(usda|usdc|usd)$/i, "") + `.${next}`);
  };

  const save = async () => {
    if (!session) return;
    setBusy(true);
    setMessage(null);
    try {
      // Collect again: the simulation may have moved on since the dialog opened.
      const { edits } = collectStageEdits(stage);
      const bytes =
        method === "server"
          ? await encodeStageOnServer(serverUrl, stage, session.source, session.rootPath, format, edits)
          : await encodeStageInBrowser(stage, session.source, format, edits);
      const fileName = /\.(usda|usdc|usd)$/i.test(name) ? name : `${name}.${format}`;
      const result = await saveAs(fileName, bytes, [{ description: "USD 레이어", accept: { "application/octet-stream": [".usd", ".usda", ".usdc"] } }], "application/octet-stream");
      if (result) setMessage({ tone: "ok", text: `${result.name} ${result.downloaded ? "다운로드됨" : "저장됨"} (${(bytes.length / 1024).toFixed(1)} KB)` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const hint = e instanceof UnsupportedUsdError && server === "online" ? " OpenUSD 서버로 저장해 보세요." : "";
      setMessage({ tone: "error", text: text + hint });
    } finally {
      setBusy(false);
    }
  };

  const changes = [
    summary.poses && `물리 결과 포즈 ${summary.poses}개`,
    summary.cloths && `천 모양 ${summary.cloths}개`,
    summary.visibility && `표시/숨김 ${summary.visibility}개`,
  ].filter(Boolean);

  return (
    <div className="w-[min(440px,calc(100vw-24px))] rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60">
      <header className="flex items-center gap-2 border-b border-line py-2.5 pr-2 pl-4">
        <Save className="size-4 text-accent" strokeWidth={1.75} />
        <h2 className="flex-1 text-[14px] font-semibold">스테이지 저장</h2>
        <IconButton icon={X} label="닫기" onClick={onClose} />
      </header>
      <div className="space-y-4 px-4 py-4 text-[12.5px]">
        {usdz ? (
          <p className="text-warn">USDZ 패키지는 아직 저장할 수 없습니다. 패키지 안의 USD 파일을 직접 열어 저장하세요.</p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block text-muted">파일 이름</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                className="h-8 w-full rounded-md border border-line-strong bg-bg px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
              />
            </label>
            <div>
              <span className="mb-1.5 block text-muted">형식</span>
              <Segmented value={format} options={FORMATS} onChange={chooseFormat} />
            </div>
            <div>
              <span className="mb-1.5 block text-muted">반영할 변경 사항</span>
              <p className="text-fg">{changes.length ? changes.join(" · ") : "없음 — 원본 내용을 선택한 형식으로 저장합니다"}</p>
            </div>
            <div>
              <span className="mb-1.5 block text-muted">변환</span>
              <div className="space-y-1.5">
                {(
                  [
                    ["browser", "브라우저에서 변환", "USDA/USDC를 직접 읽고 써서 원본 데이터를 그대로 유지합니다"],
                    [
                      "server",
                      "OpenUSD 서버",
                      server === "checking" ? "연결 확인 중…" : server === "online" ? `${serverUrl} 연결됨` : "꺼져 있음 — npm run newton 으로 켤 수 있습니다",
                    ],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label key={value} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2", method === value ? "border-accent bg-accent-soft" : "border-line hover:bg-hover", value === "server" && server !== "online" && "pointer-events-none opacity-50")}>
                    <input type="radio" name="save-method" checked={method === value} onChange={() => setMethod(value)} className="mt-0.5 accent-[var(--color-accent)]" />
                    <span>
                      <span className="block text-fg">{label}</span>
                      <span className="block text-[11.5px] text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {hasExternalLayers && (
              <p className="text-[11.5px] leading-relaxed text-faint">참조·서브레이어는 원본 기준 상대 경로 그대로 저장됩니다. 원본 파일과 같은 폴더에 저장하세요.</p>
            )}
          </>
        )}
        {message && <p className={cn("break-all", message.tone === "ok" ? "text-ok" : "text-danger")}>{message.text}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">
          닫기
        </button>
        <button
          type="button"
          disabled={usdz || busy || !session}
          onClick={() => void save()}
          className="h-8 rounded-md bg-accent-strong px-4 text-[13px] font-medium text-white hover:bg-accent disabled:opacity-40"
        >
          {busy ? "저장 중…" : "저장"}
        </button>
      </footer>
    </div>
  );
}

export default function SaveDialog() {
  const open = useViewer((s) => s.saveDialog);
  const setSaveDialog = useViewer((s) => s.setSaveDialog);
  const close = () => setSaveDialog(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSaveDialog(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setSaveDialog]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <SaveDialogBody onClose={close} />
    </div>
  );
}
