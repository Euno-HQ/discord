import { redirect } from "react-router";

import { SiteFooter } from "#~/components/SiteFooter";
import { SiteHeader } from "#~/components/SiteHeader";
import { getUser } from "#~/models/session.server";

import type { Route } from "./+types/index";

export const loader = async ({ request }: Route.LoaderArgs) => {
  const user = await getUser(request);

  if (user) {
    throw redirect("/app");
  }

  return null;
};

export const meta: Route.MetaFunction = () => [
  { title: "Euno — Moderation, decided together" },
  {
    name: "description",
    content:
      "The Discord moderation bot for mod teams of 3+. Mod tracking and anonymous reports are free; escalation voting and shared ticketing are $100 a year.",
  },
  { tagName: "link", rel: "canonical", href: "https://euno.reactiflux.com/" },
  { property: "og:url", content: "https://euno.reactiflux.com/" },
  { property: "og:title", content: "Euno — Moderation, decided together" },
  {
    property: "og:description",
    content:
      "Anonymous reports and mod tracking, free. Escalation voting and shared ticketing for $100 a year.",
  },
];

export default function Index() {
  return (
    <div className="bg-surface-light min-h-screen">
      <SiteHeader />

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
              Add Euno — free
            </a>
            <a
              href="#comparison"
              className="text-base font-medium text-stone-600 hover:text-stone-900"
            >
              See how a team uses it
            </a>
          </div>
          <p className="mx-auto mt-6 max-w-xl text-sm text-stone-500">
            Free for mod tracking and anonymous reports — no card, no time
            limit. Escalation voting and shared tickets are $100 a year.
          </p>
          <p className="mt-10 text-sm text-stone-400">
            Built by people who've moderated Discord servers since they were
            called guilds.
          </p>
        </div>
      </section>

      {/* Comparison — team-decisions framing, not a feature checklist */}
      <section
        id="comparison"
        className="border-t border-stone-200 px-6 py-16 lg:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <p className="text-accent-strong text-center text-sm font-medium tracking-wide uppercase">
            A different starting assumption
          </p>
          <h2 className="mt-3 text-center font-serif text-3xl font-bold text-stone-900">
            Moderation isn't a solo sport.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-center text-lg text-stone-600">
            MEE6 and Carl-bot are built on a quiet assumption — that one mod,
            acting alone, is the unit of moderation. Euno is built on a
            different one.
          </p>

          <div className="mt-12 space-y-10">
            {/* Moment 1 */}
            <div>
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                When a mod hits &ldquo;ban&rdquo; on a tough call
              </h3>
              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
                    Most mod bots
                  </p>
                  <p className="mt-2 text-stone-600">
                    The action lands instantly and lives in an audit log. If
                    another mod would&apos;ve called it differently, that
                    conversation happens after the fact, if it happens at all.
                  </p>
                </div>
                <div>
                  <p className="text-accent-strong text-xs font-medium tracking-wide uppercase">
                    Euno
                  </p>
                  <p className="mt-2 text-stone-700">
                    The mod can escalate the call to a vote before it lands. The
                    decision gets logged as the team&apos;s, not one
                    person&apos;s — and the user who was banned can&apos;t pin
                    it on &ldquo;that one mod.&rdquo;
                  </p>
                </div>
              </div>
            </div>

            {/* Moment 2 */}
            <div>
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                When a community member wants to report another member
              </h3>
              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
                    Most mod bots
                  </p>
                  <p className="mt-2 text-stone-600">
                    The report drops into a channel. Whichever mod sees it first
                    usually acts on it alone.
                  </p>
                </div>
                <div>
                  <p className="text-accent-strong text-xs font-medium tracking-wide uppercase">
                    Euno
                  </p>
                  <p className="mt-2 text-stone-700">
                    The report goes to the whole mod team, anonymously. The
                    reporter isn&apos;t exposed, and the response is coordinated
                    instead of racing the first available mod.
                  </p>
                </div>
              </div>
            </div>

            {/* Moment 3 */}
            <div>
              <h3 className="font-serif text-lg font-semibold text-stone-900">
                When the mod team doesn&apos;t agree on a call
              </h3>
              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
                    Most mod bots
                  </p>
                  <p className="mt-2 text-stone-600">
                    Last action wins. The disagreement migrates to #mod-chat and
                    stays there until someone gives up or burns out.
                  </p>
                </div>
                <div>
                  <p className="text-accent-strong text-xs font-medium tracking-wide uppercase">
                    Euno
                  </p>
                  <p className="mt-2 text-stone-700">
                    A vote resolves it. The outcome belongs to the team, the
                    reasoning is captured, and the next similar case has a
                    precedent instead of a grudge.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-12 max-w-2xl text-center text-stone-700">
            When every hard call is one mod&apos;s call, mods burn out and
            communities get whiplash. Shared decisions are what keep a mod team
            — and a community — together over years, not months.
          </p>

          <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-stone-500">
            MEE6 and Carl-bot are excellent bots — they&apos;re built for
            servers where one mod can reasonably make every call. Euno is built
            for teams where that stopped being true a long time ago.
          </p>

          {/*
            TODO: when /case-studies/reactiflux ships, add the spec's primary
            CTA "See how Reactiflux runs it →". Omitted now to avoid a dead
            link while the case study is deferred pending sourced quotes.
          */}
          <div className="mt-8 flex justify-center">
            <a
              href="/features"
              className="text-base font-medium text-stone-600 hover:text-stone-900"
            >
              What&apos;s in Euno →
            </a>
          </div>
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

      {/* Pricing — free tier + paid "Team" upgrade; full details + FAQ on /pricing */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Free to run. $100 a year to decide together.
          </h2>
          <p className="mt-4 text-center text-stone-600">
            Mod tracking and anonymous reports are free for any server. The
            team-decision features are the paid tier.
          </p>
          <div className="mt-10 grid items-start gap-8 md:grid-cols-2">
            {/* Free */}
            <div className="rounded border border-stone-300 bg-white p-8">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Free
              </h3>
              <p className="mt-2">
                <span className="text-4xl font-bold text-stone-900">$0</span>
              </p>
              <p className="mt-1 text-sm text-stone-500">
                For any server, no time limit
              </p>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Anonymous community reports</li>
                <li>Per-user mod tracking &amp; action history</li>
                <li>Content spam detection &amp; honeypot channels</li>
                <li>Deletion logging</li>
                <li>Standard moderation commands</li>
              </ul>
              <a
                href="/auth?flow=signup"
                className="mt-8 block rounded border border-stone-300 px-4 py-2 text-center text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Add Euno free
              </a>
            </div>

            {/* Team (paid) */}
            <div className="border-accent-strong rounded border-2 bg-white p-8 shadow-lg">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Team
              </h3>
              <p className="mt-2">
                <span className="text-4xl font-bold text-stone-900">$100</span>
                <span className="text-base font-medium text-stone-500">
                  {" "}
                  / year
                </span>
              </p>
              <p className="mt-1 text-sm text-stone-500">
                Everything in Free, plus team decisions
              </p>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Escalation voting</li>
                <li>Shared ticketing</li>
                <li>/modreport analytics</li>
                <li>Velocity &amp; raid spam detection</li>
                <li>Data export &amp; extended history</li>
              </ul>
              <a
                href="/auth?flow=signup"
                className="bg-accent-strong mt-8 block rounded px-4 py-2 text-center text-sm font-medium text-white hover:bg-amber-700"
              >
                Start free, upgrade anytime
              </a>
            </div>
          </div>
          <p className="mt-8 text-center">
            <a
              href="/pricing"
              className="text-sm font-medium text-stone-600 hover:text-stone-900"
            >
              See full pricing &amp; FAQ →
            </a>
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
