import { isRouteErrorResponse, useRouteError } from "react-router";

import { renderMarkdown } from "#~/markdown";

// Shared layout for the legal markdown pages (terms, privacy).
export function LegalPage({ markdown }: { markdown: string }) {
  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-lg bg-white px-6 py-8 shadow-sm sm:px-10">
          <div
            className="prose prose-stone max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
          />
        </div>
        <div className="mt-6 text-center">
          <a href="/" className="text-sm text-indigo-600 hover:text-indigo-500">
            ← Back to Home
          </a>
        </div>
      </div>
    </div>
  );
}

// Route-level error boundary so a failure to render a legal page degrades to a
// friendly message instead of the framework's raw error screen.
export function LegalErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "We couldn’t load this page right now.";

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-lg bg-white px-6 py-8 text-center shadow-sm sm:px-10">
          <h1 className="text-2xl font-bold text-gray-900">
            Something went wrong
          </h1>
          <p className="mt-3 text-gray-700">{detail}</p>
          <p className="mt-1 text-sm text-gray-500">
            Please try again later, or contact support@euno.reactiflux.com.
          </p>
          <a
            href="/"
            className="mt-6 inline-block text-sm text-indigo-600 hover:text-indigo-500"
          >
            ← Back to Home
          </a>
        </div>
      </div>
    </div>
  );
}
