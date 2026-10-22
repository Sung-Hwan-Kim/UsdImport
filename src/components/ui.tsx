"use client";

import { ChevronRight, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  disabled,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
        "disabled:pointer-events-none disabled:opacity-35",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}

export function Button({
  icon: Icon,
  children,
  variant = "secondary",
  onClick,
  className,
  title,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
        variant === "primary" && "bg-accent-strong text-white hover:bg-accent",
        variant === "secondary" && "border border-line-strong bg-raised text-fg hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {Icon && <Icon className="size-4" strokeWidth={1.75} />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md bg-bg/60 p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded px-2.5 text-[12px] font-medium transition-colors",
            value === o.value ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number | string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-1.5 px-3 text-[11px] font-semibold tracking-wide text-muted uppercase hover:text-fg"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {title}
        {count !== undefined && <span className="ml-auto font-mono text-[11px] font-normal text-faint normal-case">{count}</span>}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

export function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-6 items-baseline gap-3 py-0.5 text-[12px]">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className={cn("min-w-0 flex-1 break-words text-fg", mono && "font-mono text-[11.5px]")}>{children}</span>
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "ok"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded px-1.5 font-mono text-[10.5px] font-medium tracking-wide",
        tone === "neutral" && "bg-hover text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "ok" && "bg-ok/15 text-ok",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Small anchored panel that closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = "left",
  side = "bottom",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right" | "center";
  side?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cn(
            "absolute z-40 min-w-56 animate-fade-in rounded-lg border border-line-strong bg-raised p-1.5 shadow-2xl shadow-black/50",
            side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "left" && "left-0",
            align === "right" && "right-0",
            align === "center" && "left-1/2 -translate-x-1/2",
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  hint,
  active,
  onClick,
}: {
  children: ReactNode;
  hint?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
        active ? "bg-accent-soft text-accent" : "text-fg hover:bg-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-faint">{hint}</span>}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="block px-2.5 py-1.5">
      <span className="mb-1.5 flex justify-between text-[12px] text-muted">
        {label}
        <span className="font-mono text-fg">{format(value)}</span>
      </span>
      <input
        type="range"
        className="slider w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-fg hover:bg-hover"
    >
      {label}
      <span className={cn("relative h-4 w-7 rounded-full transition-colors", checked ? "bg-accent-strong" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-white transition-all", checked ? "left-3.5" : "left-0.5")} />
      </span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-bg px-1 font-mono text-[10.5px] text-muted">
      {children}
    </kbd>
  );
}
