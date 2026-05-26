/**
 * Shared marketing-site footer. Used by the homepage and /pricing (and any
 * future public marketing route) so links and attribution stay in sync.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-stone-300 bg-stone-200 px-6 py-8">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-sm text-stone-500 sm:flex-row sm:justify-between">
        <div className="flex gap-6">
          <a href="/pricing" className="hover:text-stone-700">
            Pricing
          </a>
          <a href="/terms" className="hover:text-stone-700">
            Terms
          </a>
          <a href="/privacy" className="hover:text-stone-700">
            Privacy
          </a>
          <a
            href="mailto:support@euno.reactiflux.com"
            className="hover:text-stone-700"
          >
            Support
          </a>
        </div>
        <p>Built by the team behind Reactiflux.</p>
      </div>
    </footer>
  );
}
