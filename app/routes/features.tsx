import type { MetaFunction } from "react-router";

import { FeatureBlock } from "#~/components/FeatureBlock";
import { SiteFooter } from "#~/components/SiteFooter";
import { SiteHeader } from "#~/components/SiteHeader";

export const meta: MetaFunction = () => [
  { title: "Features – Euno" },
  {
    name: "description",
    content:
      "Everything Euno does: anonymous reporting, shared user history, team escalation voting, ticketing, and spam & raid defense for Discord mod teams.",
  },
  {
    tagName: "link",
    rel: "canonical",
    href: "https://euno.reactiflux.com/features",
  },
  { property: "og:url", content: "https://euno.reactiflux.com/features" },
  { property: "og:title", content: "Features – Euno" },
  {
    property: "og:description",
    content:
      "Anonymous reporting and shared history, free. Team escalation voting, ticketing, and raid defense for mod teams of 3+.",
  },
];

/** A small supporting feature listed under a category's deep block. */
function CompactItem({
  name,
  badge,
  children,
}: {
  name: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="font-serif font-semibold text-stone-900">
        {name}
        {badge && (
          <span className="bg-accent-subtle text-accent ml-2 inline-flex items-center rounded px-2 py-0.5 align-middle text-xs font-medium tracking-wide uppercase">
            {badge}
          </span>
        )}
      </h4>
      <p className="mt-1 text-sm text-stone-600">{children}</p>
    </div>
  );
}

/** One step in the lens-A orientation strip. */
function FlowStep({
  href,
  step,
  label,
}: {
  href: string;
  step: string;
  label: string;
}) {
  return (
    <a
      href={href}
      className="flex-1 rounded border border-stone-300 bg-white p-4 transition hover:border-stone-400"
    >
      <span className="text-accent-strong text-xs font-medium tracking-wide uppercase">
        {step}
      </span>
      <p className="mt-1 text-sm text-stone-700">{label}</p>
    </a>
  );
}

export default function Features() {
  return (
    <div className="bg-surface-light min-h-screen">
      <SiteHeader />

      {/* Hero */}
      <section className="px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-stone-900 lg:text-5xl">
            Everything Euno does
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-stone-600">
            A full toolkit for mod teams — anonymous reporting and shared user
            history free for every server, team decisions and raid defense when
            you need them. Here's the whole range.
          </p>
          <div className="mt-10">
            <a
              href="/auth?flow=signup"
              className="bg-accent-strong rounded px-6 py-3 text-base font-medium text-white hover:bg-amber-700"
            >
              Add Euno — free
            </a>
          </div>
        </div>
      </section>

      {/* Lens A — orientation strip */}
      <section className="border-t border-stone-200 px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-center text-sm font-medium tracking-wide text-stone-500 uppercase">
            How a case moves through Euno
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <FlowStep
              href="#reporting"
              step="Report"
              label="A member flags a problem — anonymously."
            />
            <FlowStep
              href="#tracking"
              step="Track"
              label="Mods build a shared history on every user."
            />
            <FlowStep
              href="#team-decisions"
              step="Escalate"
              label="Hard calls go to a team vote."
            />
            <FlowStep
              href="#tracking"
              step="Resolve"
              label="Decide with the full picture, on the record."
            />
          </div>
        </div>
      </section>

      {/* Lens B — category sections */}

      {/* Reporting & anonymity */}
      <section id="reporting" className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-5xl">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            Reporting &amp; anonymity
          </p>
          <div className="mt-8">
            <FeatureBlock
              title="Anonymous reporting"
              why="Members report a bad message with a right-click — no public callout, no fear of retaliation. The report lands in a private mod thread, and the reporter stays anonymous to everyone, including your mods."
              steps={[
                "A member right-clicks a message → Apps → Report",
                "Euno files it in the offending user's private mod thread",
                "Your team responds together — the reporter is never named",
              ]}
              asset={{
                kind: "recording",
                caption: "A member files an anonymous report from the right-click menu",
              }}
            />
          </div>
        </div>
      </section>

      {/* Tracking & user history */}
      <section
        id="tracking"
        className="bg-surface-light-alt px-6 py-16 lg:py-20"
      >
        <div className="mx-auto max-w-5xl">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            Tracking &amp; user history
          </p>
          <div className="mt-8">
            <FeatureBlock
              reverse
              title="A shared history on every user"
              why="Discord tells you what happened just now. Euno remembers. Every report, tracked message, deletion, and mod action collects in one private per-user thread, so any mod can see the whole story — not just the last twenty minutes."
              steps={[
                "Track any message with a right-click to open a user's thread",
                "Reports, deletions, kicks, bans, and timeouts log automatically",
                "Any mod opens the thread to see the full history",
              ]}
              asset={{
                kind: "screenshot",
                caption:
                  "A user's history thread: tracked messages, deletions, and past actions",
              }}
            />
          </div>
          <div className="mt-12 grid gap-x-8 gap-y-8 md:grid-cols-2">
            <CompactItem name="/modreport analytics" badge="Team">
              One command pulls a user's full picture — report-count trends, who
              reported them, action history, and channel breakdowns.
            </CompactItem>
            <CompactItem name="Deletion logging">
              Deleted messages are captured and attributed automatically — see
              what was said after someone tries to cover their tracks.
            </CompactItem>
            <CompactItem name="Force-ban">
              Ban a user who already left the server, so alts can't slip back in.
            </CompactItem>
            <CompactItem name="Purge recent messages">
              Clear a user's last hour through seven days of messages in one
              action.
            </CompactItem>
            <CompactItem name="Extended history" badge="Team">
              Keep and search moderation history beyond the free 30-day window.
            </CompactItem>
          </div>
        </div>
      </section>

      {/* Team decisions */}
      <section id="team-decisions" className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-5xl">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            Team decisions
          </p>
          <div className="mt-8 space-y-16">
            <FeatureBlock
              title="Escalation voting"
              badge="Team"
              why="When a call is hard or controversial, route it to the whole team instead of carrying it alone. The outcome belongs to the team, with every vote recorded — so no user can pin a ban on 'that one mod.'"
              steps={[
                "A mod hits Escalate in the user's thread",
                "The team votes — first to quorum wins, or switch to majority mid-vote",
                "Euno applies the outcome and logs who voted for what",
              ]}
              asset={{
                kind: "recording",
                caption: "A mod escalates a ban, the team votes, Euno resolves it",
              }}
            />
            <FeatureBlock
              reverse
              title="Shared ticketing"
              badge="Team"
              why="Appeals, DMs, and follow-ups stop living in one mod's inbox. A button opens a private thread the whole team can see, claim, and hand off — so nothing falls through when a shift ends."
              steps={[
                "A member clicks your ticket button and fills a short form",
                "Euno opens a private thread and pings the team",
                "Any mod picks it up; the whole conversation stays in one place",
              ]}
              asset={{
                kind: "recording",
                caption: "A member opens a ticket; it lands in a shared mod thread",
              }}
            />
          </div>
          <div className="mt-12 grid gap-x-8 gap-y-8 md:grid-cols-2">
            <CompactItem name="Member applications" badge="Team">
              Gate entry behind a short application, reviewed by the team in a
              private thread — approve or deny in one click.
            </CompactItem>
          </div>
        </div>
      </section>

      {/* Spam & raid defense */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-5xl">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            Spam &amp; raid defense
          </p>
          <div className="mt-8">
            <FeatureBlock
              title="Spam &amp; raid detection"
              why="Euno scores messages as they arrive and responds in proportion — log, delete, restrict, timeout, or auto-kick. Content rules work free for every server; velocity and raid detection are part of Team."
              steps={[
                "Every message is scored against content and velocity signals",
                "Low scores log quietly; high scores delete, timeout, and restrict",
                "Coordinated raids trip velocity rules and get kicked automatically",
              ]}
              asset={{
                kind: "screenshot",
                caption:
                  "Euno catching a coordinated raid with graduated responses",
              }}
            />
          </div>
          <div className="mt-12 grid gap-x-8 gap-y-8 md:grid-cols-2">
            <CompactItem name="Content rules">
              Scam links, mass pings, and zalgo/unicode abuse are caught for
              every server, free, with graduated responses.
            </CompactItem>
            <CompactItem name="Velocity &amp; raid detection" badge="Team">
              Cross-channel duplicates, channel-hopping, and rapid-fire bursts —
              the signatures of a coordinated raid.
            </CompactItem>
            <CompactItem name="Honeypot channels">
              A trap channel no real member would post in — anyone who does is
              softbanned automatically.
            </CompactItem>
            <CompactItem name="Compromised-account alerts">
              A user flagged for spam across several servers is timed out and
              warned their account may be compromised.
            </CompactItem>
          </div>
        </div>
      </section>

      {/* Setup & admin */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-5xl">
          <p className="text-accent-strong text-sm font-medium tracking-wide uppercase">
            Setup &amp; admin
          </p>
          <div className="mt-8">
            <FeatureBlock
              reverse
              title="Set up in minutes"
              why="One command walks you through the whole configuration — mod role, mod-log and deletion-log channels, honeypot, tickets, applications, member roles. No config files, no guesswork."
              steps={[
                "Run /setup in your server",
                "Answer a short series of prompts for roles and channels",
                "Euno wires everything up and confirms what's live",
              ]}
              asset={{
                kind: "recording",
                caption: "The /setup wizard configuring a server end to end",
              }}
            />
          </div>
          <div className="mt-12 grid gap-x-8 gap-y-8 md:grid-cols-2">
            <CompactItem name="/check-requirements">
              Validate Euno's permissions and config in one command before you
              rely on it.
            </CompactItem>
            <CompactItem name="Reactji forwarding">
              Pick an emoji and a threshold; messages that hit it get forwarded
              to a highlights channel.
            </CompactItem>
            <CompactItem name="Data export" badge="Team">
              Export your server's moderation data — settings, stats, reported
              messages — as JSON, anytime.
            </CompactItem>
          </div>
        </div>
      </section>

      {/* Lens C — Free vs Team matrix */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Free for every server. Team when you decide together.
          </h2>
          <div className="mt-10 grid items-start gap-8 md:grid-cols-2">
            <div className="rounded border border-stone-300 bg-white p-8">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Free
              </h3>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Anonymous reporting</li>
                <li>Per-user tracking &amp; history</li>
                <li>Deletion logging</li>
                <li>Force-ban &amp; purge</li>
                <li>Content spam rules</li>
                <li>Honeypot channels</li>
                <li>/setup wizard &amp; requirements check</li>
                <li>Reactji forwarding</li>
              </ul>
            </div>
            <div className="border-accent-strong rounded border-2 bg-white p-8 shadow-lg">
              <h3 className="font-serif text-xl font-bold text-stone-900">
                Team
                <span className="text-base font-medium text-stone-500">
                  {" "}
                  · $100 / year
                </span>
              </h3>
              <ul className="mt-6 space-y-3 text-sm text-stone-700">
                <li>Escalation voting</li>
                <li>Shared ticketing</li>
                <li>Member applications</li>
                <li>Velocity &amp; raid detection</li>
                <li>/modreport analytics</li>
                <li>Extended history (beyond 30 days)</li>
                <li>Data export</li>
              </ul>
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

      {/* Roadmap note */}
      <section className="px-6 py-16 lg:py-20">
        <div className="border-accent-strong mx-auto max-w-3xl rounded border-l-4 bg-amber-50 p-8">
          <h2 className="font-serif text-2xl font-bold text-stone-900">
            On the roadmap: Server Federation
          </h2>
          <p className="mt-4 text-stone-700">
            Cross-community coordination for mod teams — share news of
            enforcement decisions with allied communities. Not automatic ban
            lists, but real coordination between teams that trust each other.
          </p>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-serif text-3xl font-bold text-stone-900">
            Add Euno to your server
          </h2>
          <p className="mt-4 text-stone-600">
            Free for mod tracking and anonymous reports — no card, no time
            limit.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href="/auth?flow=signup"
              className="bg-accent-strong rounded px-6 py-3 text-base font-medium text-white hover:bg-amber-700"
            >
              Add Euno — free
            </a>
            <a
              href="/pricing"
              className="text-base font-medium text-stone-600 hover:text-stone-900"
            >
              See pricing →
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
