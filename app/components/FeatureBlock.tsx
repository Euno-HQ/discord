import { AssetPlaceholder } from "./AssetPlaceholder";

interface FeatureBlockProps {
  id?: string;
  title: string;
  /** e.g. "Team" — omitted for free features. */
  badge?: string;
  /** Why the feature matters (1–2 sentences). */
  why: string;
  /** How it works, in order. Rendered as a numbered list. */
  steps: string[];
  asset: { kind: "recording" | "screenshot"; caption: string };
  /** Flip text/asset sides so consecutive blocks alternate. */
  reverse?: boolean;
}

/**
 * A "deep" feature block: why + numbered how-steps on one side, a placeholder
 * asset on the other. Pass `reverse` on every other block to alternate sides.
 */
export function FeatureBlock({
  id,
  title,
  badge,
  why,
  steps,
  asset,
  reverse = false,
}: FeatureBlockProps) {
  return (
    <div id={id} className="grid items-center gap-8 md:grid-cols-2">
      <div className={reverse ? "md:order-2" : undefined}>
        <h3 className="font-serif text-2xl font-bold text-stone-900">
          {title}
          {badge && (
            <span className="bg-accent-subtle text-accent ml-2 inline-flex items-center rounded px-2 py-0.5 align-middle text-xs font-medium tracking-wide uppercase">
              {badge}
            </span>
          )}
        </h3>
        <p className="mt-3 text-stone-700">{why}</p>
        <ol className="mt-5 space-y-3">
          {steps.map((step) => (
            <li key={step} className="flex gap-3 text-sm text-stone-600">
              <span className="bg-accent-strong flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold text-white">
                {steps.indexOf(step) + 1}
              </span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
      </div>
      <AssetPlaceholder
        kind={asset.kind}
        caption={asset.caption}
        className={reverse ? "md:order-1" : undefined}
      />
    </div>
  );
}
