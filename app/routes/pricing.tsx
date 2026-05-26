import type { MetaFunction } from "react-router";

import { SiteFooter } from "#~/components/SiteFooter";
import { SiteHeader } from "#~/components/SiteHeader";

export const meta: MetaFunction = () => [
  { title: "Pricing – Euno" },
  {
    name: "description",
    content:
      "Try Euno free for 90 days, then $100 a year. One tier, every feature — moderation built for Discord mod teams.",
  },
];

/**
 * Canonical /pricing route. Copy is locked in
 * notes/2026-05-12_2_page-copy-pricing.md — single tier, 90-day trial,
 * $100/year. Headline uses Variant B; A and C are alternates in the spec.
 */
export default function Pricing() {
  return (
    <div className="bg-surface-light min-h-screen">
      <SiteHeader />

      {/* Hero */}
      <section className="px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-stone-900 lg:text-5xl">
            Try Euno free for 90 days. Keep it for $100/year.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-stone-600">
            Spend three months running real moderation through Euno before you
            decide whether it&apos;s worth a hundred dollars. No card now, no
            surprise charges later.
          </p>
        </div>
      </section>

      {/* Price card + what you get */}
      <section className="px-6 pb-16 lg:pb-24">
        <div className="mx-auto grid max-w-5xl items-start gap-8 md:grid-cols-2">
          {/* Price card */}
          <div className="border-accent-strong rounded border-2 bg-white p-8 shadow-lg">
            <p className="font-serif text-2xl font-bold text-stone-900">
              Free for 90 days
            </p>
            <p className="mt-2 text-stone-600">
              Full product. No credit card. No feature gates.
            </p>
            <div className="my-6 border-t border-stone-200" />
            <p>
              <span className="text-4xl font-bold text-stone-900">$100</span>
              <span className="text-base font-medium text-stone-500">
                {" "}
                / year
              </span>
            </p>
            <p className="mt-2 text-stone-600">Flat. One tier. One server.</p>
            <p className="mt-6 text-sm text-stone-500 italic">
              Less than two hours of a burnt-out mod&apos;s time. Less than a
              single &ldquo;I quit the team&rdquo; Discord meltdown.
            </p>
            <a
              href="/auth?flow=signup"
              className="bg-accent-strong mt-8 block rounded px-4 py-3 text-center text-base font-medium text-white hover:bg-amber-700"
            >
              Start the 90-day trial
            </a>
            <p className="mt-3 text-center text-xs text-stone-500">
              No credit card. No feature gates. Cancel by removing the bot.
            </p>
            <a
              href="#faq"
              className="mt-4 block text-center text-sm font-medium text-stone-600 hover:text-stone-900"
            >
              Why one tier?
            </a>
          </div>

          {/* What you get */}
          <div>
            <h2 className="font-serif text-xl font-bold text-stone-900">
              What you get
            </h2>
            <ul className="mt-6 space-y-5 text-stone-700">
              <li>
                <span className="font-semibold text-stone-900">
                  Escalation voting
                </span>{" "}
                — when a call is hard or controversial, route it to the full mod
                team. Decisions get a quorum, not a lone trigger-finger.
              </li>
              <li>
                <span className="font-semibold text-stone-900">
                  Anonymous community reports
                </span>{" "}
                — members flag bad behavior without exposing themselves to
                retaliation. Reports land in a private mod queue, not a public
                channel.
              </li>
              <li>
                <span className="font-semibold text-stone-900">
                  Shared ticketing
                </span>{" "}
                — every DM, appeal, and follow-up lives in one thread the whole
                team can see, claim, and hand off. No more &ldquo;wait,
                who&apos;s talking to this user?&rdquo;
              </li>
              <li>
                <span className="font-semibold text-stone-900">
                  Audit trail on every action
                </span>{" "}
                — who banned, who voted, who closed the ticket, with timestamps.
                Useful for appeals, useful for onboarding new mods, useful when
                a community lead asks what happened.
              </li>
              <li>
                <span className="font-semibold text-stone-900">
                  Standard automod and slash commands
                </span>{" "}
                — warn, mute, kick, ban, slowmode, raid protection, link
                filters, the regex rules you&apos;d expect. You don&apos;t lose
                baseline moderation to get the team features.
              </li>
              <li>
                <span className="font-semibold text-stone-900">
                  Data export
                </span>{" "}
                — your moderation history is yours, searchable from your Discord
                server.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="bg-surface-light-alt px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center font-serif text-3xl font-bold text-stone-900">
            Questions
          </h2>
          <dl className="mt-12 space-y-8">
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                What happens after the 90-day trial?
              </dt>
              <dd className="mt-2 text-stone-700">
                On day 90 we ask you to pay. The bot keeps full functionality
                for a 14-day grace period — nothing breaks mid-incident — and
                then it stops accepting new commands until you renew. Your data
                and config stay intact.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Do I need to add a credit card to start?
              </dt>
              <dd className="mt-2 text-stone-700">
                No. You add Euno to your server and the trial begins. We&apos;ll
                email and ping your admin role at day 75 and day 89.
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
                Yes. Remove the bot anytime. If you cancel during a paid year we
                don&apos;t bill you for the next one. The price is annual but
                the commitment isn&apos;t.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Why annual only?
              </dt>
              <dd className="mt-2 text-stone-700">
                Moderation is slow work and the value of a tool like this shows
                up over months, not weeks. Annual pricing keeps the math simple
                and keeps us focused on building the product instead of running
                a billing department.
              </dd>
            </div>
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                Is there a free tier?
              </dt>
              <dd className="mt-2 text-stone-700">
                No. A free tier would mean two products — one we build for and
                one we tolerate — and the &ldquo;tolerated&rdquo; one is always
                the volunteer mod&apos;s. We&apos;d rather give you ninety days
                of the real thing.
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
            {/*
              NOTE FOR COPY OWNER: this answer says refunds are "the first 30
              days," but the page footer + the locked carve-outs
              (memory/project_euno_pricing_carveouts.md) say a full refund is
              available within 180 days. Rendered verbatim from the spec; the
              30-vs-180 contradiction needs to be reconciled before this page
              ships publicly.
            */}
            <div>
              <dt className="font-serif text-lg font-semibold text-stone-900">
                What if Euno breaks something, or my team isn&apos;t happy?
              </dt>
              <dd className="mt-2 text-stone-700">
                Email us in the first 30 days of a paid year and we&apos;ll
                refund you, no interrogation. After that, cancel and you
                won&apos;t be billed again. We&apos;re not trying to trap
                anyone.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Trial-end policy + refund microcopy */}
      <section className="px-6 py-12">
        <div className="mx-auto max-w-3xl space-y-4 text-center text-sm text-stone-500">
          <p>
            At day 90 the bot keeps working for a 14-day grace window so
            you&apos;re never mid-incident when access changes. After that,
            commands pause until you renew; your settings and history stay put.
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
