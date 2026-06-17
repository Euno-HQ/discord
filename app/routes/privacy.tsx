import { useLoaderData } from "react-router";

import { LegalErrorBoundary, LegalPage } from "#~/legal/LegalPage";

// Bundled at build time so the content ships inside the build artifact rather
// than being read from disk at request time (see app/legal/LegalPage.tsx).
import privacyMarkdown from "../../PRIVACY_POLICY.md?raw";

export async function loader() {
  return { markdown: privacyMarkdown };
}

export default function Privacy() {
  const { markdown } = useLoaderData<typeof loader>();
  return <LegalPage markdown={markdown} />;
}

export function ErrorBoundary() {
  return <LegalErrorBoundary />;
}
