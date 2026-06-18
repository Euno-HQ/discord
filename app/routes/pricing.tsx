import type { MetaFunction } from "react-router";

import { SiteFooter } from "#~/components/SiteFooter";
import { SiteHeader } from "#~/components/SiteHeader";

export const meta: MetaFunction = () => [
  { title: "Pricing – Euno" },
  {
    name: "description",
    content:
      "Mod tracking and anonymous reports are free for any Discord server. Escalation voting and shared ticketing are $100 a year.",
  },
  {
    tagName: "link",
    rel: "canonical",
    href: "https://euno.reactiflux.com/pricing",
  },
  { property: "og:url", content: "https://euno.reactiflux.com/pricing" },
  { property: "og:title", content: "Pricing – Euno" },
];

/**
 * /pricing route.
 *
 * DRAFT — reframed for the free-tier pivot (2026-05-25). This supersedes the
 * single-tier copy in notes/2026-05-12_2_page-copy-pricing.md, which assumed
 * "$100/year, one tier, no free tier." New model: free tier (mod tracking +
 * anonymous reports, no time limit) + paid "Team" tier ($100/yr — escalation
 * voting + shared ticketing), with a 90-day Team trial offered as an in-product
 * upsell rather than the headline. Tier name and the free/paid feature split
 * are proposed, not locked. Refund window reconciled to 180 days to match the
 * locked carve-outs (memory/project_euno_pricing_carveouts.md).
 */
export default function Pricing() {
  return (
    <div className="bg-surface-light min-h-screen">
      <SiteHeader />

      {/* Hero */}
      <section className="px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-stone-900 lg:text-5xl">
            Free to run. $100 a year to decide together.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-stone-600">
            Mod tracking and anonymous reports are free for any server, no time
            limit. Escalation voting and shared ticketing — the features that
            turn moderation into a team call — are $100 a year.
          </p>
        </div>
      </section>

      {/* Price cards */}
      <section className="px-6 pb-12">
        <div className="mx-auto grid max-w-4xl items-start gap-8 md:grid-cols-2">
          {/* Free */}
          <div className="rounded border border-stone-300 bg-white p-8">
            <h2 className="font-serif text-2xl font-bold text-stone-900">
              Free
            </h2>
            <p className="mt-4">
              <span className="text-4xl font-bold text-stone-900">$0</span>
            </p>
            <p className="mt-1 text-sm text-stone-500">
              For any server, no time limit
            </p>
            <ul className="mt-6 space-y-3 text-stone-700">
              <li>Anonymous community reports</li>
              <li>Per-user mod tracking &amp; action history</li>
              <li>Content spam detection &amp; honeypot channels</li>
              <li>Deletion logging</li>
              <li>Standard moderation commands</li>
            </ul>
            <a
              href="/auth?flow=signup"
              className="mt-8 block rounded border border-stone-300 px-4 py-3 text-center text-base font-medium text-stone-700 hover:bg-stone-100"
            >
              Add Euno free
            </a>
          </div>

          {/* Team (paid) */}
          <div className="border-accent-strong rounded border-2 bg-white p-8 shadow-lg">
            <h2 className="font-serif text-2xl font-bold text-stone-900">
              Team
            </h2>
            <p className="mt-4">
              <span className="text-4xl font-bold text-stone-900">$100</span>
              <span className="text-base font-medium text-stone-500">
                {" "}
                / year
              </span>
            </p>
            <p className="mt-1 text-sm text-stone-500">
              Everything in Free, plus team decisions
            </p>
            <ul className="mt-6 space-y-3 text-stone-700">
              <li>Escalation voting</li>
              <li>Shared ticketing</li>
              <li>/modreport analytics</li>
              <li>Velocity &amp; raid spam detection</li>
              <li>Data export &amp; extended history</li>
            </ul>
            <a
              href="/auth?flow=signup"
              className="bg-accent-strong mt-8 block rounded px-4 py-3 text-center text-base font-medium text-white hover:bg-amber-700"
            >
              Start free, upgrade anytime
            </a>
            <p className="mt-3 text-center text-xs text-stone-500">
              Try the Team features free for 90 days — no card.
            </p>
          </div>
        </div>
      </section>

      {/* Trial-as-upsell note */}
      <section className="px-6 pb-16 lg:pb-24">
        <p className="mx-auto max-w-2xl text-center text-stone-600">
          Not ready to commit? Add Euno free and run it for as long as you like.
          When your mod team wants to try escalation voting and shared
          ticketing, start a 90-day trial from inside the app — no credit card.
        </p>
      </section>

      {/* What the Team tier gets you */}
      <section className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="font-serif text-2xl font-bold text-stone-900">
            What the Team tier gets you
          </h2>
          <ul className="mt-8 space-y-5 text-stone-700">
            <li>
              <span className="font-semibold text-stone-900">
                Escalation voting
              </span>{" "}
              — when a call is hard or controversial, route it to the full mod
              team. Decisions get a quorum, not a lone trigger-finger.
            </li>
            <li>
              <span className="font-semibold text-stone-900">
                Shared ticketing
              </span>{" "}
              — every DM, appeal, and follow-up lives in one thread the whole
              team can see, claim, and hand off. No more &ldquo;wait, who&apos;s
              talking to this user?&rdquo;
            </li>
            <li>
              <span className="font-semibold text-stone-900">
                Analytics &amp; audit trail
              </span>{" "}
              — who banned, who voted, who closed the ticket, with timestamps.
              Report-count trends, action breakdowns, and the full picture on
              any user with /modreport.
            </li>
            <li>
              <span className="font-semibold text-stone-900">
                Velocity &amp; raid spam detection
              </span>{" "}
              — cross-channel duplicate detection, channel hopping, rapid-fire
              messaging. Catches coordinated raids, not just individual
              spammers.
            </li>
            <li>
              <span className="font-semibold text-stone-900">
                Data export &amp; extended history
              </span>{" "}
              — your moderation history is yours, searchable and exportable, and
              kept beyond the free 30-day window.
            </li>
          </ul>
          <p className="mt-8 text-sm text-stone-500">
            Anonymous reports and per-user mod tracking stay free, for every
            server, forever.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Questions
          </h2>
          <dl className="mt-12 space-y-8">
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Is there a free tier?
              </dt>
              <dd className="mt-2 text-stone-700">
                Yes. Mod tracking and anonymous reports are free for any server,
                with no time limit. Escalation voting and shared ticketing are
                the paid Team tier — $100 a year.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Do I need a credit card to start?
              </dt>
              <dd className="mt-2 text-stone-700">
                No. Add Euno and the free tier is yours immediately. You only
                add a card when you upgrade to Team — and even then you can run
                a 90-day trial of the Team features first.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                What happens when a Team trial ends?
              </dt>
              <dd className="mt-2 text-stone-700">
                The Team features pause and your server drops back to the free
                tier — mod tracking and anonymous reports keep working.
                There&apos;s a 14-day grace window so nothing breaks
                mid-incident, and your data and config stay intact.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                What if my server has more than 100K members?
              </dt>
              <dd className="mt-2 text-stone-700">
                Euno runs on servers of every size on the same plan. If you have
                an edge case — a million members, weird ratelimit needs, custom
                integrations — talk to us.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Can I cancel?
              </dt>
              <dd className="mt-2 text-stone-700">
                Yes. Remove the bot anytime, or drop from Team back to free. If
                you cancel a paid year we don&apos;t bill you for the next one.
                The price is annual but the commitment isn&apos;t.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Why annual only?
              </dt>
              <dd className="mt-2 text-stone-700">
                Moderation is slow work and the value of team tooling shows up
                over months, not weeks. Annual pricing keeps the math simple and
                keeps us focused on building the product instead of running a
                billing department.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Do you offer discounts for nonprofits, open-source communities,
                or large servers?
              </dt>
              <dd className="mt-2 text-stone-700">
                No. A hundred dollars a year is already priced for volunteer mod
                teams running real communities. We may introduce enterprise
                pricing for customers using Euno as part of a marketing or
                support function.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                What if Euno breaks something, or my team isn&apos;t happy?
              </dt>
              <dd className="mt-2 text-stone-700">
                Email us within 180 days of any annual charge and we&apos;ll
                refund you, no interrogation. After that, cancel and you
                won&apos;t be billed again. We&apos;re not trying to trap
                anyone.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Trial-end policy + refund microcopy */}
      <section className="bg-surface-light-alt px-6 py-12">
        <div className="mx-auto max-w-3xl space-y-4 text-center text-sm text-stone-500">
          <p>
            When a Team trial or paid year ends, the bot keeps working through a
            14-day grace window so you&apos;re never mid-incident when access
            changes — then the Team features pause and the free tier continues.
          </p>
          <p>
            Full refund within 180 days of any annual charge — just email us.
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
