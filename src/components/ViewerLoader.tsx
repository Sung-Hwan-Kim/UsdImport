"use client";

import dynamic from "next/dynamic";

// WebGL, File APIs and the USD parsers are browser-only.
const ViewerApp = dynamic(() => import("./ViewerApp"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-bg text-sm text-muted">
      <span className="mr-3 inline-block size-4 animate-spin-slow rounded-full border-2 border-line-strong border-t-accent" />
      뷰어를 준비하는 중…
    </div>
  ),
});

export default function ViewerLoader() {
  return <ViewerApp />;
}
