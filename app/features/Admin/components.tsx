// Structural interfaces for component props — compatible with Stripe SDK types
// without requiring a .server import in this client-safe module.
export interface PaymentMethodItem {
  id: string;
  type: string;
  card?: {
    brand?: string | null;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
  } | null;
}

export interface InvoiceItem {
  id: string;
  created?: number | null;
  number?: string | null;
  amount_due?: number | null;
  status?: string | null;
  hosted_invoice_url?: string | null;
}

export function TierBadge({ tier }: { tier: string | null }) {
  if (!tier || tier === "free") {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-600 px-2.5 py-0.5 text-xs font-medium text-gray-200">
        Free
      </span>
    );
  }
  if (tier === "paid") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-800 px-2.5 py-0.5 text-xs font-medium text-emerald-200">
        Paid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-teal-800 px-2.5 py-0.5 text-xs font-medium text-teal-200">
      Custom
    </span>
  );
}

export function StatusDot({ status }: { status: string | null }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-green-400">
        <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
        Active
      </span>
    );
  }
  if (status && status !== "active") {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-rose-400">
        <span className="inline-block h-2 w-2 rounded-full bg-rose-400" />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm text-gray-500">
      <span className="inline-block h-2 w-2 rounded-full bg-gray-500" />
      No subscription
    </span>
  );
}

export function tierAmount(tier: string | null) {
  if (tier === "paid") return "$100/yr";
  if (tier === "custom") return "Custom";
  return "$0";
}

export function GuildIcon({
  guildId,
  icon,
  name,
  size = "sm",
}: {
  guildId: string;
  icon: string | null;
  name: string;
  size?: "sm" | "lg";
}) {
  const dimension = size === "lg" ? "h-12 w-12" : "h-8 w-8";
  const fontSize = size === "lg" ? "text-sm" : "text-xs";
  const cdnSize = size === "lg" ? 64 : 32;
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (icon) {
    return (
      <img
        src={`https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=${cdnSize}`}
        alt=""
        className={`${dimension} rounded-full`}
      />
    );
  }
  return (
    <div
      className={`flex ${dimension} items-center justify-center rounded-full bg-gray-600 ${fontSize} font-medium text-gray-300`}
    >
      {initials}
    </div>
  );
}

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
    >
      {children}
      <svg
        className="h-3 w-3"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </a>
  );
}

export function PaymentMethodsList({
  paymentMethods,
  compact,
}: {
  paymentMethods: PaymentMethodItem[];
  compact?: boolean;
}) {
  if (paymentMethods.length === 0) {
    return <p className="text-sm text-gray-500">No payment methods on file</p>;
  }
  if (compact) {
    return (
      <ul className="space-y-1">
        {paymentMethods.map((pm) => (
          <li key={pm.id} className="text-sm text-gray-400">
            {pm.type === "card" && pm.card
              ? `${pm.card.brand?.toUpperCase()} ****${pm.card.last4} (exp ${pm.card.exp_month}/${pm.card.exp_year})`
              : pm.type}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-2">
      {paymentMethods.map((pm) => (
        <li
          key={pm.id}
          className="flex items-center gap-3 text-sm text-gray-300"
        >
          <span className="rounded bg-gray-700 px-2 py-0.5 font-mono text-xs text-gray-400">
            {pm.type}
          </span>
          {pm.type === "card" && pm.card ? (
            <span>
              {pm.card.brand?.toUpperCase()} ****{pm.card.last4} (exp{" "}
              {pm.card.exp_month}/{pm.card.exp_year})
            </span>
          ) : (
            <span>{pm.type}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function InvoiceTable({
  invoices,
  compact,
}: {
  invoices: InvoiceItem[];
  compact?: boolean;
}) {
  if (invoices.length === 0) {
    return <p className="text-sm text-gray-500">No invoices</p>;
  }
  const py = compact ? "py-1" : "py-2";
  const pb = compact ? "pb-1" : "pb-2";
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-600 text-left text-gray-400">
          <th className={`${pb} pr-4 font-medium`}>Date</th>
          {!compact && <th className={`${pb} pr-4 font-medium`}>Number</th>}
          <th className={`${pb} pr-4 font-medium`}>Amount</th>
          <th className={`${pb} pr-4 font-medium`}>Status</th>
          <th className={`${pb} font-medium`}>Invoice</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id} className="border-b border-gray-700">
            <td className={`${py} pr-4 text-gray-400`}>
              {inv.created
                ? new Date(inv.created * 1000).toLocaleDateString()
                : "-"}
            </td>
            {!compact && (
              <td className={`${py} pr-4 font-mono text-xs text-gray-500`}>
                {inv.number ?? "-"}
              </td>
            )}
            <td className={`${py} pr-4 text-gray-300`}>
              {inv.amount_due != null
                ? `$${(inv.amount_due / 100).toFixed(2)}`
                : "-"}
            </td>
            <td className={`${py} pr-4`}>
              <span
                className={
                  inv.status === "paid" ? "text-green-400" : "text-yellow-400"
                }
              >
                {inv.status ?? "-"}
              </span>
            </td>
            <td className={py}>
              {inv.hosted_invoice_url && (
                <a
                  href={inv.hosted_invoice_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  View
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Badge showing job status with color coding. Processing jobs verified by Supervisor. */
export function JobStatusBadge({
  status,
  fiberActive,
}: {
  status: string;
  fiberActive: boolean;
}) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400",
    processing: fiberActive
      ? "bg-green-500/20 text-green-400"
      : "bg-orange-500/20 text-orange-400",
    completed: "bg-gray-500/20 text-gray-400",
    failed: "bg-red-500/20 text-red-400",
  };

  const label = status === "processing" && !fiberActive ? "stale" : status;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-500/20 text-gray-300"}`}
    >
      {label}
    </span>
  );
}

/** Progress display for multi-phase jobs. */
export function JobProgressBar({
  phase,
  totalPhases,
  progressCount,
}: {
  phase: number;
  totalPhases: number;
  progressCount: number;
}) {
  return (
    <div className="text-xs text-gray-400">
      <span>
        Phase {phase}/{totalPhases}
      </span>
      {progressCount > 0 && (
        <span className="ml-2">{progressCount.toLocaleString()} processed</span>
      )}
    </div>
  );
}

export function PostHogSection({
  featureFlags,
  groupProperties,
  compact,
}: {
  featureFlags: Record<string, string | boolean> | null;
  groupProperties?: Record<string, string | number> | null;
  compact?: boolean;
}) {
  const Heading = compact ? "h4" : "h2";
  const SubHeading = compact ? "h5" : "h3";
  const headingClass = compact
    ? "mb-2 text-sm font-medium text-gray-300"
    : "text-lg font-semibold text-gray-200";
  const subHeadingClass = compact
    ? "mb-1 text-xs font-medium text-gray-400"
    : "mb-2 text-sm font-medium text-gray-400";
  const wrapperClass = compact
    ? ""
    : "space-y-3 rounded-md border border-gray-600 bg-gray-800 p-4";

  if (featureFlags === null) {
    return (
      <div className={wrapperClass}>
        <Heading className={headingClass}>PostHog</Heading>
        <p className="text-sm text-gray-500">PostHog not configured</p>
      </div>
    );
  }

  const flagEntries = Object.entries(featureFlags).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const propEntries = groupProperties ? Object.entries(groupProperties) : [];

  return (
    <div className={wrapperClass}>
      <Heading className={headingClass}>PostHog</Heading>

      {propEntries.length > 0 && (
        <div>
          <SubHeading className={subHeadingClass}>Group Properties</SubHeading>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            {propEntries.map(([key, value]) => (
              <div key={key}>
                <dt className="text-gray-500">{key}</dt>
                <dd className="text-gray-300">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div>
        <SubHeading className={subHeadingClass}>Feature Flags</SubHeading>
        {flagEntries.length === 0 ? (
          <p className="text-sm text-gray-500">No feature flags evaluated</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {flagEntries.map(([name, value]) => (
              <span
                key={name}
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ${
                  value === true
                    ? "bg-emerald-800 text-emerald-200"
                    : value === false
                      ? "bg-gray-600 text-gray-300"
                      : "bg-indigo-800 text-indigo-200"
                }`}
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
