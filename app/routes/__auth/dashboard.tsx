import type { PropsWithChildren } from "react";
import { data, Link, useSearchParams } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { RangeForm, type PresetKey } from "#~/features/StarHunter/RangeForm.js";
import {
  calculateCohortBenchmarks,
  getCohortMetrics,
} from "#~/helpers/cohortAnalysis";
import { log, trackPerformance } from "#~/helpers/observability";
import { getTopParticipantsEffect } from "#~/models/activity.server";

import type { Route } from "./+types/dashboard";

export async function loader({ params, request }: Route.LoaderArgs) {
  // Star Hunter is only enabled for Reactiflux
  if (params.guildId !== "102860784329052160") {
    throw new Response("Not Found", { status: 404 });
  }

  return trackPerformance(
    "dashboardLoader",
    async () => {
      const url = new URL(request.url);
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const guildId = params.guildId;
      const minThreshold = Number(url.searchParams.get("minThreshold") ?? 10);

      log("info", "Dashboard", "Dashboard loader accessed", {
        guildId,
        start,
        end,
        userAgent: request.headers.get("user-agent"),
        ip: request.headers.get("x-forwarded-for") ?? "unknown",
      });

      if (!(guildId && start && end)) {
        log(
          "warn",
          "Dashboard",
          "Invalid dashboard request - missing parameters",
          {
            guildId,
            start,
            end,
          },
        );
        return data(null, { status: 400 });
      }

      const userResults = await runEffect(
        getTopParticipantsEffect(guildId, start, end),
      );

      // Return full cohort metrics and benchmarks
      const cohortMetrics = await getCohortMetrics(
        guildId,
        start,
        end,
        minThreshold,
      );
      const benchmarks = calculateCohortBenchmarks(cohortMetrics);
      return { cohortMetrics, benchmarks, userResults };
    },
    {
      guildId: params.guildId,
      start: new URL(request.url).searchParams.get("start"),
      end: new URL(request.url).searchParams.get("end"),
    },
  );
}

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});
const percent = percentFormatter.format.bind(percentFormatter);

const Td = ({ children, ...props }: PropsWithChildren) => (
  <td {...props} className="padding-8">
    {children}
  </td>
);
const Th = ({ children, ...props }: PropsWithChildren) => (
  <th
    {...props}
    className="relative max-w-8 origin-bottom-left -rotate-45 text-nowrap"
  >
    {children}
  </th>
);
const Tr = ({ children, ...props }: PropsWithChildren) => (
  <tr {...props}>{children}</tr>
);

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const [qs] = useSearchParams();

  const start = qs.get("start") ?? undefined;
  const end = qs.get("end") ?? undefined;
  const interval = (qs.get("interval") as PresetKey) ?? undefined;

  if (!loaderData) {
    return (
      <div className="h-full px-6 py-8">
        <div className="flex justify-center">
          <RangeForm values={{ start, end }} interval={interval} />
        </div>
        <div></div>
      </div>
    );
  }

  const { userResults, cohortMetrics, benchmarks } = loaderData;

  return (
    <div className="px-6 py-8">
      <div className="flex justify-center">
        <RangeForm values={{ start, end }} interval={interval} />
      </div>
      <div>
        <textarea readOnly className="resize text-black">
          {JSON.stringify({ benchmarks }, null, 2)}
        </textarea>
        <textarea readOnly className="resize text-black">
          {JSON.stringify({ cohortMetrics }, null, 2)}
        </textarea>

        <textarea
          readOnly
          className="resize text-black"
          defaultValue={`Author ID,Percent Zero Days,Word Count,Message Count,Channel Count,Category Count,Reaction Count,Word Score,Message Score,Channel Score,Consistency Score
${userResults
  .map(
    (d) =>
      `${d.data.member.author_id},${d.metadata.percentZeroDays},${d.data.member.total_word_count},${d.data.member.message_count},${d.data.member.channel_count},${d.data.member.category_count},${d.data.member.total_reaction_count},${d.score.wordScore},${d.score.messageScore},${d.score.channelScore},${d.score.consistencyScore}`,
  )
  .join("\n")}`}
        ></textarea>
        <table className="mt-24">
          <thead>
            <Tr>
              <Th>Author ID</Th>
              <Th>Percent Zero Days</Th>
              <Th>Word Count</Th>
              <Th>Message Count</Th>
              <Th>Channel Count</Th>
              <Th>Category Count</Th>
              <Th>Reaction Count</Th>
              <Th>Word Score</Th>
              <Th>Message Score</Th>
              <Th>Channel Score</Th>
              <Th>Consistency Score</Th>
            </Tr>
          </thead>
          <tbody>
            {userResults.map((d) => (
              <Tr key={d.data.member.author_id}>
                <Td>
                  <Link
                    to={{
                      pathname: d.data.member.author_id,
                      search: `?start=${start}&end=${end}`,
                    }}
                  >
                    {d.data.member.username ?? d.data.member.author_id}
                  </Link>
                </Td>
                <Td>{percent(d.metadata.percentZeroDays)}</Td>
                <Td>{d.data.member.total_word_count}</Td>
                <Td>{d.data.member.message_count}</Td>
                <Td>{d.data.member.channel_count}</Td>
                <Td>{d.data.member.category_count}</Td>
                <Td>{d.data.member.total_reaction_count}</Td>
                <Td>{d.score.wordScore}</Td>
                <Td>{d.score.messageScore}</Td>
                <Td>{d.score.channelScore}</Td>
                <Td>{d.score.consistencyScore}</Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
