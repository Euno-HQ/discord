import { data } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { Page } from "#~/basics/page.js";
import { GuildSettingsForm } from "#~/components/GuildSettingsForm";
import { fetchGuildData } from "#~/helpers/guildData.server";
import { log, trackPerformance } from "#~/helpers/observability";
import { registerGuild, setSettings, SETTINGS } from "#~/models/guilds.server";
import { requireUser } from "#~/models/session.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/onboard";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireUser(request);
  const { guildId } = params;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  log("info", "onboarding", "Onboarding page accessed", { guildId });

  // Get subscription info for the guild
  const subscription = await runEffect(
    SubscriptionService.getGuildSubscription(guildId),
  );
  const tier = await runEffect(SubscriptionService.getProductTier(guildId));

  // Fetch guild data using the reusable service
  const { roles, channels } = await fetchGuildData(guildId);

  return {
    guildId,
    subscription,
    tier,
    roles,
    channels,
  };
}

export default function Onboard({
  loaderData: { guildId, roles, channels },
}: Route.ComponentProps) {
  return (
    <Page>
      <h2 className="font-serif text-3xl font-bold text-stone-100">
        <div className="inline-block">
          <div className="mr-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-900">
            <svg
              className="h-6 w-6 text-emerald-400"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        </div>
        Set up Euno for your server
      </h2>
      <p className="mt-2 text-lg text-stone-400">
        Configure the essential settings to get started
      </p>

      <GuildSettingsForm
        guildId={guildId}
        roles={roles}
        channels={channels}
        buttonText="Complete Setup"
      />
    </Page>
  );
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const formData = await request.formData();
  const guildId = formData.get("guild_id") as string;
  const modLogChannel = formData.get("mod_log_channel") as string;
  const moderatorRole = formData.get("moderator_role") as string;
  const restrictedRole = formData.get("restricted_role") as string;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  if (!modLogChannel || !moderatorRole) {
    throw data(
      { message: "Moderator role and log channel are required" },
      { status: 400 },
    );
  }

  log("info", "onboarding", "Onboarding form submitted", {
    guildId,
    modLogChannel,
    moderatorRole,
    hasRestrictedRole: !!restrictedRole,
  });

  try {
    // Register the guild and set up configuration
    await trackPerformance("guilds.registerGuild", () =>
      registerGuild(guildId),
    );

    await trackPerformance("guilds.setSettings", () =>
      setSettings(guildId, {
        [SETTINGS.modLog]: modLogChannel,
        [SETTINGS.moderator]: moderatorRole,
        [SETTINGS.restricted]: restrictedRole || undefined,
      }),
    );

    // Initialize free subscription for new guilds
    await runEffect(SubscriptionService.initializeFreeSubscription(guildId));

    log("info", "onboarding", "Onboarding completed successfully", {
      guildId,
      settings: {
        modLog: modLogChannel,
        moderator: moderatorRole,
        restricted: restrictedRole || null,
      },
    });

    return data({ success: true });
  } catch (error) {
    log("error", "onboarding", "Onboarding failed", { guildId, error });
    throw data(
      { message: "Failed to complete onboarding. Please try again." },
      { status: 500 },
    );
  }
}
