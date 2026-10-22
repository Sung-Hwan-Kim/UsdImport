/** Three stacked layers: a nod to USD's layer stack. */
export default function Logo({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" fill="currentColor" />
      <path d="m3 12 9 5 9-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" opacity="0.7" />
      <path d="m3 16 9 5 9-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" opacity="0.4" />
    </svg>
  );
}
