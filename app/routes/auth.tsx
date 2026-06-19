import { redirect } from "react-router";

import { Login } from "#~/basics/login";
import { initOauthLogin } from "#~/models/session.server";

import type { Route } from "./+types/auth";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const flow = url.searchParams.get("flow");
  const guildId = url.searchParams.get("guild_id");
  const redirectTo = url.searchParams.get("redirectTo");

  // If flow parameter is provided, handle as OAuth initiation
  if (flow) {
    // Validate flow type
    if (!["user", "signup", "add-bot"].includes(flow)) {
      throw redirect("/");
    }

    return await initOauthLogin({
      request,
      flow: flow as "user" | "signup" | "add-bot",
      guildId: guildId ?? undefined,
      redirectTo: redirectTo ?? "/",
    });
  }

  // Otherwise, redirect to home (preserving original behavior)
  return redirect("/");
}

export default function LoginPage() {
  return (
    <div className="flex min-h-full flex-col justify-center">
      <div className="mx-auto w-full max-w-md px-8">
        <Login redirectTo="/" />
      </div>
    </div>
  );
}

export async function action({ request }: Route.ActionArgs) {
  // Handle form POST from Login component (existing functionality)
  const form = await request.formData();
  const redirectTo = form.get("redirectTo");

  return initOauthLogin({
    request,
    // redirectTo is FormDataEntryValue (string | File); File has no meaningful
    // toString, but in practice this field is always a string from the form.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    redirectTo: redirectTo?.toString() ?? "/app",
  });
}
