// Discord revoked MessageContent 2026-09; flip to true and redeploy once
// re-approved. (GuildMembers was also revoked and is permanently unused:
// kick/timeout logging uses GuildAuditLogEntryCreate instead.)
export const MESSAGE_CONTENT_INTENT = false;
