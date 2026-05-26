import { Login } from "#~/basics/login";

/**
 * Shared marketing-site top nav. Used by the homepage and /pricing (and any
 * future public marketing route) so the chrome can't drift between pages.
 */
export function SiteHeader() {
  return (
    <nav className="flex items-center justify-between px-6 py-4 lg:px-8">
      <a href="/" className="text-accent-strong font-serif text-xl font-bold">
        Euno
      </a>
      <div className="flex items-center gap-4">
        <a
          href="/pricing"
          className="text-sm font-medium text-stone-600 hover:text-stone-900"
        >
          Pricing
        </a>
        <Login className="w-auto rounded-none bg-transparent px-3 py-2 text-sm font-medium text-stone-600 shadow-none hover:bg-transparent hover:text-stone-900 focus:bg-transparent">
          Log in
        </Login>
        <a
          href="/auth?flow=signup"
          className="bg-accent-strong rounded px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
        >
          Add to Discord
        </a>
      </div>
    </nav>
  );
}
