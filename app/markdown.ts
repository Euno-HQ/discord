import MarkdownIt from "markdown-it";

// Shared markdown renderer for any page sourced from first-party `.md` content.
//
// `html: false` escapes any raw HTML in the source, so the rendered output is
// safe to inject (no sanitizer needed) as long as the input stays first-party.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}
