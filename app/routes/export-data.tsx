import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { log, trackPerformance } from "#~/helpers/observability";
import { requireUser } from "#~/models/session.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/export-data";

/**
 * GDPR Data Export Route
 * Allows users to export all their personal data and server data they manage
 */
export async function loader({ request }: Route.LoaderArgs) {
  return trackPerformance(
    "dataExport",
    async () => {
      const user = await requireUser(request);
      const url = new URL(request.url);
      const guildId = url.searchParams.get("guild_id");

      log("info", "DataExport", "User requested data export", {
        userId: user.id,
        guildId: guildId ?? "none",
      });

      // Check if user has premium access (data export is a paid feature)
      if (guildId) {
        const hasAccess = await SubscriptionService.hasFeature(
          guildId,
          "data_export",
        );

        if (!hasAccess) {
          return new Response(
            JSON.stringify({
              error:
                "Data export is a Pro feature. Please upgrade your subscription.",
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // Build data export
      const exportData: Record<string, unknown> = {
        exported_at: new Date().toISOString(),
        user: {
          id: user.id,
          email: user.email,
          external_id: user.externalId,
          auth_provider: user.authProvider,
        },
      };

      // If guild_id is provided, export guild-specific data
      if (guildId) {
        log("info", "DataExport", "Exporting guild data", {
          userId: user.id,
          guildId,
        });

        // Get guild settings
        const guild = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            const rows = yield* db
              .selectFrom("guilds")
              .selectAll()
              .where("id", "=", guildId);
            return rows[0];
          }),
        );

        if (guild) {
          exportData.guild = {
            id: guild.id,
            settings: guild.settings ? JSON.parse(guild.settings) : null,
          };
        }

        // Get subscription data
        const subscription =
          await SubscriptionService.getGuildSubscription(guildId);

        if (subscription) {
          exportData.subscription = {
            product_tier: subscription.product_tier,
            status: subscription.status,
            current_period_end: subscription.current_period_end,
            created_at: subscription.created_at,
          };
        }

        // Get message statistics (aggregated, no actual message content)
        const messageStats = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            return yield* db
              .selectFrom("message_stats")
              .selectAll()
              .where("guild_id", "=", guildId)
              .limit(1000); // Limit to prevent huge exports
          }),
        );

        if (messageStats.length > 0) {
          exportData.message_statistics = messageStats.map((stat) => ({
            sent_at: new Date(stat.sent_at * 1000).toISOString(),
            author_id: stat.author_id,
            channel_id: stat.channel_id,
            channel_category: stat.channel_category,
            word_count: stat.word_count,
            char_count: stat.char_count,
            react_count: stat.react_count,
          }));
        }

        // Get reported messages (sanitized)
        const reportedMessages = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            return yield* db
              .selectFrom("reported_messages")
              .selectAll()
              .where("guild_id", "=", guildId)
              .where("deleted_at", "is", null)
              .limit(100);
          }),
        );

        if (reportedMessages.length > 0) {
          exportData.reported_messages = reportedMessages.map((report) => ({
            id: report.id,
            reported_message_id: report.reported_message_id,
            reported_channel_id: report.reported_channel_id,
            reported_user_id: report.reported_user_id,
            staff_id: report.staff_id,
            staff_username: report.staff_username,
            reason: report.reason,
            created_at: report.created_at,
          }));
        }
      }

      log("info", "DataExport", "Data export completed successfully", {
        userId: user.id,
        guildId: guildId ?? "none",
        dataSize: JSON.stringify(exportData).length,
      });

      // Return as downloadable JSON file
      const filename = guildId
        ? `euno-export-${guildId}-${Date.now()}.json`
        : `euno-export-user-${user.id}-${Date.now()}.json`;

      return new Response(JSON.stringify(exportData, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },
    { userId: (await requireUser(request)).id },
  );
}

/**
 * Handle data deletion requests
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405 });
  }

  return trackPerformance(
    "dataDelete",
    async () => {
      const user = await requireUser(request);
      const url = new URL(request.url);
      const guildId = url.searchParams.get("guild_id");

      log("warn", "DataDelete", "User requested data deletion", {
        userId: user.id,
        guildId: guildId ?? "none",
      });

      if (!guildId) {
        return new Response(
          JSON.stringify({
            error:
              "guild_id parameter required for data deletion. To delete your user account, please contact support.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Soft delete reported messages for this guild
      await runEffect(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          yield* db
            .updateTable("reported_messages")
            .set({ deleted_at: new Date().toISOString() })
            .where("guild_id", "=", guildId);

          yield* db
            .deleteFrom("message_stats")
            .where("guild_id", "=", guildId);

          yield* db
            .deleteFrom("guild_subscriptions")
            .where("guild_id", "=", guildId);

          yield* db.deleteFrom("guilds").where("id", "=", guildId);
        }),
      );

      log("info", "DataDelete", "Guild data deleted successfully", {
        userId: user.id,
        guildId,
      });

      return new Response(
        JSON.stringify({
          message: "Guild data has been deleted successfully",
          guild_id: guildId,
          deleted_at: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
    { userId: (await requireUser(request)).id },
  );
}
