import { useMemo } from "react";
import { Link, useSearchParams, type LoaderFunctionArgs } from "react-router";
import {
  // Line,
  // Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  // Scatter,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { runEffect } from "#~/AppRuntime";
import { getUserCohortAnalysis } from "#~/helpers/cohortAnalysis.js";
import { getUserMessageAnalyticsEffect } from "#~/models/activity.server";

import type { Route } from "./+types/sh-user";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { guildId, userId } = params;

  // Star Hunter is only enabled for Reactiflux
  if (guildId !== "102860784329052160") {
    throw new Response("Not Found", { status: 404 });
  }

  if (!guildId || !userId) {
    throw new Error("cannot load data without user_id and guild_id");
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const minThreshold = Number(url.searchParams.get("minThreshold") ?? 10);

  if (!start || !end) {
    throw new Error("cannot load data without start and end range");
  }

  const [analysis, data] = await Promise.all([
    getUserCohortAnalysis(guildId, userId, start, end, minThreshold),
    runEffect(getUserMessageAnalyticsEffect(guildId, userId, start, end)),
  ]);

  return {
    analysis,
    data,
  };
}

const num = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export default function UserProfile({
  params,
  loaderData: { data, analysis },
}: Route.ComponentProps) {
  const [qs] = useSearchParams();
  const start = qs.get("start");
  const end = qs.get("end");

  const derivedData = useMemo(() => {
    // Calculate days between start and end dates
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    const daysBetween =
      startDate && endDate
        ? Math.ceil(
            (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
          ) + 1
        : 0;

    return {
      totalMessages: data.categoryBreakdown.reduce(
        (a, c) => a + Number(c.messages),
        0,
      ),
      totalReactions: data.dailyBreakdown.reduce(
        (a, c) => a + Number(c.react_count),
        0,
      ),
      totalWords: data.dailyBreakdown.reduce(
        (a, c) => a + Number(c.word_count),
        0,
      ),
      daysBetween,
    };
  }, [data, start, end]);

  return (
    <>
      <style>{`
text {
  fill: #ccc;
}
.recharts-default-tooltip {
  background-color: rgb(55,65,81) !important;
}`}</style>

      <div className="flex h-16 items-center justify-between border-b border-gray-700 px-4">
        <Link
          to={{
            pathname: `/app/${params.guildId}/sh`,
            search: `?start=${start}&end=${end}`,
          }}
          className="rounded bg-gray-600 px-4 py-2 text-white transition-colors hover:bg-gray-500"
        >
          ← Dashboard
        </Link>

        <h1 className="text-4xl font-bold">
          {data.userInfo?.username}
          <small className="text-gray-300">
            {data.userInfo?.global_name &&
              data.userInfo.global_name !== data.userInfo.username && (
                <div className="pt-2 text-center text-xl text-gray-300">
                  <small>In {derivedData.daysBetween} days</small> (
                  {data.userInfo.global_name}) <small>:</small>
                </div>
              )}
          </small>
        </h1>
        <div className="px-4"> </div>
      </div>

      <div className="h-full px-6 py-8">
        <div>
          {/* (top 5: 👀❤️✨‼️🫡) (top langs: JS, Go, Rust) */}
          <p>
            Sent {num.format(derivedData.totalMessages)} messages in{" "}
            {data.channelBreakdown.length} channels consisting of{" "}
            {num.format(derivedData.totalWords)} words (
            {num.format(derivedData.totalWords / derivedData.totalMessages)}{" "}
            words/message).
          </p>
          <p></p>
          <p>Received {num.format(derivedData.totalReactions)} reactions.</p>
          <pre>{JSON.stringify(analysis, null, 2)}</pre>
        </div>
        <div className="mx-auto max-w-screen-lg">
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart
              width={500}
              height={300}
              data={data.channelBreakdown}
              margin={{
                top: 20,
                right: 50,
                bottom: 20,
                left: 20,
              }}
            >
              <CartesianGrid strokeDasharray="1 3" stroke="#ddd" />
              <XAxis dataKey="name" />
              <YAxis domain={[0, 250]} />
              <Tooltip />
              <Legend fill="lightgray" />
              <Bar dataKey="messages" fill="#8884d8" />
            </ComposedChart>
          </ResponsiveContainer>
          <ResponsiveContainer width="100%" height={300}>
            <RadarChart
              cx="50%"
              cy="50%"
              outerRadius="80%"
              data={data.categoryBreakdown}
            >
              <PolarGrid />
              <PolarAngleAxis dataKey="channel_category" />
              <PolarRadiusAxis />
              <Tooltip />
              <Radar
                name="Messages"
                dataKey="messages"
                stroke="#8884d8"
                fill="#8884d8"
                fillOpacity={0.6}
              />
              <Legend fill="lightgray" />
            </RadarChart>
          </ResponsiveContainer>

          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              width={500}
              height={200}
              data={data.dailyBreakdown}
              syncId="dailyStats"
              margin={{
                top: 20,
                right: 20,
                bottom: 20,
                left: 20,
              }}
            >
              <CartesianGrid strokeDasharray="7 3" stroke="#ddd" />
              <XAxis dataKey="date" scale="band" />
              <YAxis domain={[0, 125]} />
              <Tooltip />
              <Legend />
              <Legend fill="lightgray" />
              <Bar dataKey="messages" fill="#4d48e2" />
            </ComposedChart>
          </ResponsiveContainer>

          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              width={500}
              height={200}
              data={data.dailyBreakdown}
              syncId="dailyStats"
              margin={{
                top: 20,
                right: 20,
                bottom: 20,
                left: 20,
              }}
            >
              <CartesianGrid strokeDasharray="7 3" stroke="#ddd" />
              <XAxis dataKey="date" scale="band" />
              <YAxis domain={[0, 1250]} />
              <Tooltip />
              <Legend />
              <Bar dataKey="word_count" stackId="1" fill="red" />
            </ComposedChart>
          </ResponsiveContainer>

          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              width={500}
              height={200}
              data={data.dailyBreakdown}
              syncId="dailyStats"
              margin={{
                top: 20,
                right: 20,
                bottom: 20,
                left: 20,
              }}
            >
              <CartesianGrid strokeDasharray="7 3" stroke="#ddd" />
              <XAxis dataKey="date" scale="band" />
              <YAxis domain={[0, 25]} />
              <Tooltip />
              <Legend />
              <Bar dataKey="react_count" fill="green" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
