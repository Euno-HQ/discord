import { layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("routes/__auth.tsx", [
    route("login", "routes/__auth/login.tsx"),
    route("app/", "routes/__auth/app.tsx"),

    route("app/admin", "routes/__auth/admin.tsx"),
    route("app/admin/jobs", "routes/__auth/admin.jobs.tsx"),
    route("app/admin/:guildId", "routes/__auth/admin.$guildId.tsx"),

    route("app/:guildId", "routes/__auth/guild.tsx"),
    route("app/:guildId/onboard", "routes/onboard.tsx"),
    route("app/:guildId/sh", "routes/__auth/dashboard.tsx"),
    route("app/:guildId/sh/:userId", "routes/__auth/sh-user.tsx"),
    layout("components/TabsLayout.tsx", [
      route("app/:guildId/settings", "routes/__auth/settings.tsx"),
      route("app/:guildId/settings/upgrade", "routes/__auth/upgrade.tsx"),
    ]),
  ]),
  route("auth", "routes/auth.tsx"),
  route("discord-oauth", "routes/discord-oauth.tsx"),
  route("healthcheck", "routes/healthcheck.tsx"),
  route("/", "routes/index.tsx"),
  route("logout", "routes/logout.tsx"),
  route("payment/success", "routes/payment.success.tsx"),
  route("webhooks/stripe", "routes/webhooks.stripe.tsx"),
  route("export-data", "routes/export-data.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
] satisfies RouteConfig;
