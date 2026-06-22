import { data } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { GuildSettingsForm } from "#~/components/GuildSettingsForm";
import { logEffect } from "#~/effects/observability";
import { fetchGuildData } from "#~/helpers/guildData.server";
import { trackPerformance } from "#~/helpers/observability";
import { fetchSettings, setSettings, SETTINGS } from "#~/models/guilds.server";
import { requireUser } from "#~/models/session.server";

import type { Route } from "./+types/settings";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireUser(request);
  const { guildId } = params;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  void runEffect(
    logEffect("info", "settings", "Settings page accessed", { guildId }),
  );

  // Fetch current guild settings
  const [currentSettings, { roles, channels }] = await Promise.all([
    runEffect(
      fetchSettings(guildId, [
        SETTINGS.modLog,
        SETTINGS.moderator,
        SETTINGS.restricted,
      ]),
    ).catch(() => undefined),
    runEffect(fetchGuildData(guildId)),
  ]);

  return {
    guildId,
    roles,
    channels,
    currentSettings,
  };
}

export default function Settings({
  loaderData: { guildId, roles, channels, currentSettings },
}: Route.ComponentProps) {
  return (
    <div className="space-y-8">
      {/* Settings Form */}
      <GuildSettingsForm
        guildId={guildId}
        roles={roles}
        channels={channels}
        buttonText="Save Settings"
        defaultValues={
          currentSettings
            ? {
                moderatorRole: currentSettings.moderator,
                modLogChannel: currentSettings.modLog,
                restrictedRole: currentSettings.restricted,
              }
            : undefined
        }
      />
    </div>
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

  void runEffect(
    logEffect("info", "settings", "Settings form submitted", {
      guildId,
      modLogChannel,
      moderatorRole,
      hasRestrictedRole: !!restrictedRole,
    }),
  );

  try {
    await trackPerformance("guilds.setSettings", () =>
      runEffect(
        setSettings(guildId, {
          [SETTINGS.modLog]: modLogChannel,
          [SETTINGS.moderator]: moderatorRole,
          [SETTINGS.restricted]: restrictedRole || undefined,
        }),
      ),
    );

    void runEffect(
      logEffect("info", "settings", "Settings updated successfully", {
        guildId,
        settings: {
          modLog: modLogChannel,
          moderator: moderatorRole,
          restricted: restrictedRole || null,
        },
      }),
    );

    return data({ success: true });
  } catch (error) {
    void runEffect(
      logEffect("error", "settings", "Settings update failed", {
        guildId,
        error,
      }),
    );
    throw data(
      { message: "Failed to update settings. Please try again." },
      { status: 500 },
    );
  }
}
