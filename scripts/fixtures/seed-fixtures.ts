/**
 * Seeds known fixture data for non-production environments.
 * Creates deterministic test users, guilds, sessions, and channel info.
 */

import { FIXTURE_IDS } from "./constants.ts";
import db from "./db.ts";

export async function seedFixtures(): Promise<void> {
  // 1. Seed test users
  for (const [key, user] of Object.entries(FIXTURE_IDS.users)) {
    await db
      .insertInto("users")
      .values({
        id: user.id,
        externalId: user.externalId,
        email: user.email,
        authProvider: "discord",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    console.log(`    User: ${key}`);
  }

  // 2. Seed test session
  await db
    .insertInto("sessions")
    .values({
      id: FIXTURE_IDS.sessions.testSession,
      data: JSON.stringify({
        userId: FIXTURE_IDS.users.testUser.id,
        discordToken: {
          access_token: "fixture_access_token",
          token_type: "Bearer",
          expires_at: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          scope: "identify email guilds guilds.members.read",
        },
      }),
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  console.log("    Session: testSession");

  // 3. Seed guilds with subscriptions
  for (const [key, guild] of Object.entries(FIXTURE_IDS.guilds)) {
    await db
      .insertInto("guilds")
      .values({
        id: guild.id,
        settings: JSON.stringify({}),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const isPaid = key === "paid";
    await db
      .insertInto("guild_subscriptions")
      .values({
        guild_id: guild.id,
        product_tier: isPaid ? "paid" : "free",
        status: "active",
        stripe_customer_id: isPaid ? FIXTURE_IDS.stripe.customerId : null,
        stripe_subscription_id: isPaid
          ? FIXTURE_IDS.stripe.subscriptionId
          : null,
        current_period_end: isPaid
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    console.log(`    Guild: ${key} (${isPaid ? "paid" : "free"})`);
  }

  // 4. Seed channel info for reference
  for (const [name, id] of Object.entries(FIXTURE_IDS.channels)) {
    await db
      .insertInto("channel_info")
      .values({
        id,
        name: `#${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`,
        category: name.startsWith("help") ? "Help" : "General",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  console.log("    Channels: seeded");
}
