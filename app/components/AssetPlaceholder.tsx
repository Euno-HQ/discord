interface AssetPlaceholderProps {
  kind: "recording" | "screenshot";
  /** One line describing what the real asset will show. */
  caption: string;
  className?: string;
}

/**
 * Stand-in for a marketing screenshot or screen recording that hasn't been
 * produced yet. Renders a labeled, dashed box. When the real asset lands,
 * replace the <AssetPlaceholder> with an <img>/<video> of the same size — the
 * surrounding layout doesn't change.
 */
export function AssetPlaceholder({
  kind,
  caption,
  className = "",
}: AssetPlaceholderProps) {
  const label = kind === "recording" ? "Recording" : "Screenshot";
  return (
    <div
      className={`flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-stone-300 bg-stone-50 p-6 text-center ${className}`}
    >
      <span className="text-xs font-bold tracking-wide text-stone-400 uppercase">
        {label}
      </span>
      {kind === "recording" && (
        <span aria-hidden="true" className="text-3xl leading-none text-stone-300">
          ▶
        </span>
      )}
      <span className="text-sm text-stone-500">{caption}</span>
    </div>
  );
}
