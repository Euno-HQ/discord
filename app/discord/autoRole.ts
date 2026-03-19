import { Events, type Client } from "discord.js";
import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

export const autoRole = async (client: Client) => {
  client.on(Events.GuildMemberAdd, (member) => {
    void runEffect(
      Effect.gen(function* () {
        const settings = yield* fetchSettingsEffect(member.guild.id, [
          SETTINGS.autoRole,
        ]);
        const roleId = settings.autoRole;
        if (!roleId) return;

        yield* Effect.tryPromise({
          try: () => member.roles.add(roleId),
          catch: (error) =>
            new DiscordApiError({ operation: "addAutoRole", cause: error }),
        });

        yield* logEffect(
          "info",
          "AutoRole",
          "Assigned auto-role to new member",
          {
            guildId: member.guild.id,
            userId: member.id,
            roleId,
          },
        );
      }).pipe(
        Effect.catchAll((error) =>
          logEffect("warn", "AutoRole", "Failed to assign auto-role", {
            guildId: member.guild.id,
            userId: member.id,
            error,
          }),
        ),
        Effect.withSpan("autoRole.assign", {
          attributes: { guildId: member.guild.id, userId: member.id },
        }),
      ),
    );
  });
};
