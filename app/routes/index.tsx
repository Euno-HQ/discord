import { redirect } from "react-router";

import { Login } from "#~/basics/login";
import { getUser } from "#~/models/session.server";

import type { Route } from "./+types/index";

export const loader = async ({ request }: Route.LoaderArgs) => {
  const user = await getUser(request);

  if (user) {
    throw redirect("/app");
  }

  return null;
};

function StandardBadge() {
  return (
    <span className="bg-accent-subtle text-accent ml-2 inline-flex items-center rounded px-2 py-0.5 text-xs font-medium tracking-wide uppercase">
      Standard
    </span>
  );
}

export default function Index() {
  return (
    <div className="bg-surface-light min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 lg:px-8">
        <span className="text-accent-strong font-serif text-xl font-bold">
          Euno
        </span>
        <div className="flex items-center gap-4">
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

      {/* Hero */}
      {/*
        Headline A/B: Variant B "Moderation, decided together." ships as the
        live control. Variant A "Stop making the call alone." is the designated
        A/B challenger (see notes/2026-05-12_1_page-copy-homepage-hero.md). No
        experiment infrastructure exists yet — swap the <h1> to run the
        challenger once PostHog experiments are wired up.
      */}
      <section className="px-6 py-20 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            For mod teams of 3+
          </p>
          <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-stone-900 lg:text-5xl">
            Moderation, decided together.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-stone-600">
            Escalation votes, anonymous reports, and shared tickets — so the
            hard calls in your server get decided together, not dumped on
            whoever was online.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href="/auth?flow=signup"
              className="bg-accent-strong rounded px-6 py-3 text-base font-medium text-white hover:bg-amber-700"
            >
              Start your free 90-day trial
            </a>
            <a
              href="#comparison"
              className="text-base font-medium text-stone-600 hover:text-stone-900"
            >
              See how a team uses it
            </a>
          </div>
          <p className="mx-auto mt-6 max-w-xl text-sm text-stone-500">
            No credit card. Five-minute setup. $100/year after trial — one
            price, no tiers.
          </p>
          <p className="mt-10 text-sm text-stone-400">
            Built by people who've moderated Discord servers since they were
            called guilds.
          </p>
        </div>
      </section>

      {/* Problem statement */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="font-serif text-3xl font-bold text-stone-900">
            Discord moderation is stateless. Euno gives it memory.
          </h2>
          <div className="mt-8 space-y-6 text-stone-700">
            <p>
              Discord tells you what happened just now. It doesn't tell you what
              happened last month with the same user.
            </p>
            <p>
              When your mod team is 5 people, context gets lost. One mod's
              warning is invisible to another. A problem user's history lives in
              people's heads, not in the tools.
            </p>
            <p>
              Euno creates a persistent thread for every user — reports, tracked
              messages, mod actions, and deletion logs accumulate over time. Any
              moderator can pull up the full picture with a single command.
            </p>
          </div>
        </div>
      </section>

      {/* Core loop */}
      <section id="features" className="px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Report &rarr; Track &rarr; Escalate &rarr; Resolve
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                Report
              </h3>
              <p className="mt-2 text-stone-700">
                Community members report messages anonymously with a
                right-click. No public callouts, no fear of retaliation. Reports
                land in a private per-user mod thread.
              </p>
            </div>
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                Track
              </h3>
              <p className="mt-2 text-stone-700">
                Moderators build a paper trail by tracking messages in context.
                Every tracked message, deletion, kick, ban, and timeout is
                recorded with who did it and why.
              </p>
            </div>
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                Escalate
              </h3>
              <p className="mt-2 text-stone-700">
                When the right call isn't obvious, escalate to a team vote.
                Quorum-based voting with graduated responses — from a warning to
                a ban — so no single moderator acts alone on hard calls.
              </p>
            </div>
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                Resolve
              </h3>
              <p className="mt-2 text-stone-700">
                Pull up any user's full history with /modreport. Report count
                trends, action breakdowns, top channels, which staff reported
                them. Make informed decisions, not gut calls.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Supporting features */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Plus everything you'd expect
          </h2>
          <div className="mt-12 grid gap-x-8 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Content spam detection
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Keyword matching, zalgo detection, mass ping blocking, and
                honeypot channels. Graduated responses from logging to softban.
                Works immediately.
              </p>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Deletion logging
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Deleted messages are captured and attributed automatically. See
                what was said after someone tries to cover their tracks.
              </p>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Velocity spam detection
                <StandardBadge />
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Cross-channel duplicate detection, channel hopping, rapid-fire
                messaging. Catches coordinated raids, not just individual
                spammers.
              </p>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Tickets
                <StandardBadge />
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Button-click ticket system. Members fill a form, a private
                thread is created, your team gets pinged.
              </p>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Reactji forwarding
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Set an emoji + threshold. Messages that hit it get forwarded to
                a highlights channel.
              </p>
            </div>
            <div>
              <h3 className="font-serif font-semibold text-stone-900">
                Force ban
              </h3>
              <p className="mt-1 text-sm text-stone-600">
                Ban users who already left the server. No more escaped alts.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Federation roadmap tease */}
      <section className="px-6 py-16 lg:py-24">
        <div className="border-accent-strong mx-auto max-w-3xl rounded border-l-4 bg-amber-50 p-8">
          <h2 className="font-serif text-2xl font-bold text-stone-900">
            Coming soon: Server Federation
          </h2>
          <p className="mt-4 text-stone-700">
            We're building cross-community collaboration for moderation teams.
            Share news of enforcement decisions with allied communities — not
            automatic ban lists, but real coordination between mod teams that
            trust each other. Get in early and help shape what this looks like.
          </p>
          <a
            href="/auth?flow=signup"
            className="bg-accent-strong mt-6 inline-block rounded px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-700"
          >
            Join now
          </a>
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Pricing
          </h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {/* Free */}
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Free
              </h3>
              <p className="mt-2">
                <span className="text-4xl font-bold text-stone-900">$0</span>
              </p>
              <p className="mt-1 text-sm text-stone-500">
                See what's happening
              </p>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Basic reporting (staff tracking, non-anonymous)</li>
                <li>
                  Content-based spam detection (keyword matching, zalgo, mass
                  pings)
                </li>
                <li>Deletion logging</li>
                <li>Mod action recording</li>
                <li>Honeypot channels</li>
                <li>Reactji forwarding</li>
                <li>Force ban</li>
              </ul>
              <a
                href="/auth?flow=signup"
                className="mt-8 block rounded border border-stone-300 px-4 py-2 text-center text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Add to Discord
              </a>
            </div>

            {/* Standard */}
            <div className="border-accent-strong rounded border-2 bg-white p-6 shadow-lg">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Standard
              </h3>
              <p className="mt-2">
                <span className="text-4xl font-bold text-stone-900">$100</span>
                <span className="text-base font-medium text-stone-500">
                  /year
                </span>
              </p>
              <p className="mt-1 text-sm text-stone-500">Act on it as a team</p>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Everything in Free</li>
                <li>Anonymous community reports</li>
                <li>Escalation voting</li>
                <li>Ticket system</li>
                <li>
                  Velocity-based spam detection (cross-channel dupes, channel
                  hopping, rapid-fire)
                </li>
                <li>/modreport user analytics</li>
              </ul>
              <p className="text-accent-strong mt-4 text-xs font-medium">
                90-day free trial
              </p>
              <a
                href="/auth?flow=signup"
                className="bg-accent-strong mt-4 block rounded px-4 py-2 text-center text-sm font-medium text-white hover:bg-amber-700"
              >
                Start free trial
              </a>
            </div>

            {/* Custom */}
            <div className="rounded border border-stone-300 bg-white p-6">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Custom
              </h3>
              <p className="mt-2 text-lg font-semibold text-stone-900">
                Contact us
              </p>
              <p className="mt-1 text-sm text-stone-500">&nbsp;</p>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Everything in Standard</li>
                <li>Dedicated bot instance</li>
                <li>Stable release channel</li>
                <li>Support SLA</li>
                <li>Priority feature requests</li>
              </ul>
              <a
                href="mailto:support@euno.reactiflux.com?subject=Custom%20Euno%20Plan"
                className="mt-8 block rounded border border-stone-300 px-4 py-2 text-center text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Contact Sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-300 bg-stone-200 px-6 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-sm text-stone-500 sm:flex-row sm:justify-between">
          <div className="flex gap-6">
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
    </div>
  );
}
