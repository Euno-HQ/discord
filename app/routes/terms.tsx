import { useLoaderData } from "react-router";

import { LegalErrorBoundary, LegalPage } from "#~/legal/LegalPage";

// Bundled at build time so the content ships inside the build artifact rather
// than being read from disk at request time (see app/legal/LegalPage.tsx).
import termsMarkdown from "../../TERMS_OF_SERVICE.md?raw";

export async function loader() {
  return { markdown: termsMarkdown };
}

export default function Terms() {
  const { markdown } = useLoaderData<typeof loader>();
  return <LegalPage markdown={markdown} />;
}

export function ErrorBoundary() {
  return <LegalErrorBoundary />;
}
