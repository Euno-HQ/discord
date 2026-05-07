import { Page } from "#~/basics/page.js";
import {
  JobProgressBar,
  JobStatusBadge,
} from "#~/features/Admin/components.js";
import { requireAdmin } from "#~/features/Admin/helpers.server.js";
import {
  fetchAdminJobs,
  type AdminJob,
} from "#~/features/Admin/jobHelpers.server.js";

import type { Route } from "./+types/admin.jobs";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const jobs = await fetchAdminJobs();
  return { jobs };
}

export default function AdminJobs({ loaderData }: Route.ComponentProps) {
  const { jobs } = loaderData;

  return (
    <Page>
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-gray-200">Background Jobs</h1>

        {jobs.length === 0 ? (
          <p className="text-gray-400">No background jobs found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-600 text-gray-400">
                <tr>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Guild</th>
                  <th className="px-3 py-2">Progress</th>
                  <th className="px-3 py-2">Errors</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}

function JobRow({ job }: { job: AdminJob }) {
  const isStale = job.status === "processing" && !job.fiberActive;

  return (
    <tr className={isStale ? "bg-orange-900/10" : ""}>
      <td className="px-3 py-2">
        <JobStatusBadge status={job.status} fiberActive={job.fiberActive} />
      </td>
      <td className="px-3 py-2 font-mono text-xs text-gray-300">
        {job.job_type}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-gray-400">
        {job.guild_id}
      </td>
      <td className="px-3 py-2">
        <JobProgressBar
          phase={job.phase}
          totalPhases={job.total_phases}
          progressCount={job.progress_count}
        />
      </td>
      <td className="px-3 py-2">
        {job.error_count > 0 ? (
          <span className="text-red-400">{job.error_count}</span>
        ) : (
          <span className="text-gray-500">0</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-gray-400">
        {new Date(job.created_at).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-xs text-gray-400">
        {new Date(job.updated_at).toLocaleString()}
      </td>
    </tr>
  );
}
