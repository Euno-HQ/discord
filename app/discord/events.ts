import type {
  AutoModerationActionExecution,
  AutoModerationRule,
  Guild,
  GuildBan,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialGuildMember,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  ReadonlyCollection,
  User,
} from "discord.js";

// --- Enriched message events ---
// Bot/system/DM messages are filtered at the source.
// MessageCreate gets full enrichment (guild + member available synchronously
// from Discord.js). Delete/Update/BulkDelete get guild resolved from client
// cache; pipelines handle further async resolution (e.g., message cache lookup).

export interface GuildMemberMessage {
  readonly type: "GuildMemberMessage";
  readonly message: Message<true>;
  readonly guild: Guild;
  readonly member: GuildMember;
}

export interface GuildMessageDelete {
  readonly type: "GuildMessageDelete";
  readonly message: Message | PartialMessage;
  readonly guild: Guild;
  readonly guildId: string;
}

export interface GuildMessageUpdate {
  readonly type: "GuildMessageUpdate";
  readonly oldMessage: Message | PartialMessage;
  readonly newMessage: Message | PartialMessage;
  readonly guild: Guild;
  readonly guildId: string;
}

export interface GuildMessageBulkDelete {
  readonly type: "GuildMessageBulkDelete";
  readonly messages: ReadonlyCollection<string, Message | PartialMessage>;
  readonly channel: GuildTextBasedChannel;
  readonly guild: Guild;
  readonly guildId: string;
}

// --- Raw events (not enriched, passed through as-is) ---

export interface GuildBanAddEvent {
  readonly type: "GuildBanAdd";
  readonly ban: GuildBan;
}

export interface GuildBanRemoveEvent {
  readonly type: "GuildBanRemove";
  readonly ban: GuildBan;
}

export interface GuildMemberRemoveEvent {
  readonly type: "GuildMemberRemove";
  readonly member: GuildMember | PartialGuildMember;
}

export interface GuildMemberUpdateEvent {
  readonly type: "GuildMemberUpdate";
  readonly oldMember: GuildMember | PartialGuildMember;
  readonly newMember: GuildMember;
}

export interface GuildCreateEvent {
  readonly type: "GuildCreate";
  readonly guild: Guild;
}

export interface GuildDeleteEvent {
  readonly type: "GuildDelete";
  readonly guild: Guild;
}

export interface AutoModerationActionEvent {
  readonly type: "AutoModerationActionExecution";
  readonly execution: AutoModerationActionExecution;
}

export interface AutoModerationRuleCreateEvent {
  readonly type: "AutoModerationRuleCreate";
  readonly rule: AutoModerationRule;
}

export interface AutoModerationRuleDeleteEvent {
  readonly type: "AutoModerationRuleDelete";
  readonly rule: AutoModerationRule;
}

export interface AutoModerationRuleUpdateEvent {
  readonly type: "AutoModerationRuleUpdate";
  readonly oldRule: AutoModerationRule | null;
  readonly newRule: AutoModerationRule;
}

export interface MessageReactionAddEvent {
  readonly type: "MessageReactionAdd";
  readonly reaction: MessageReaction | PartialMessageReaction;
  readonly user: User | PartialUser;
}

export interface MessageReactionRemoveEvent {
  readonly type: "MessageReactionRemove";
  readonly reaction: MessageReaction | PartialMessageReaction;
  readonly user: User | PartialUser;
}

// Note: InteractionCreate and ThreadCreate are handled directly in gateway.ts, not through the event bus.

// --- Union type ---

export type GuildMessageEvent =
  | GuildMemberMessage
  | GuildMessageDelete
  | GuildMessageUpdate
  | GuildMessageBulkDelete;

export type DiscordEvent =
  | GuildMessageEvent
  | GuildBanAddEvent
  | GuildBanRemoveEvent
  | GuildMemberRemoveEvent
  | GuildMemberUpdateEvent
  | GuildCreateEvent
  | GuildDeleteEvent
  | AutoModerationActionEvent
  | AutoModerationRuleCreateEvent
  | AutoModerationRuleDeleteEvent
  | AutoModerationRuleUpdateEvent
  | MessageReactionAddEvent
  | MessageReactionRemoveEvent;

// --- Type guards ---

const GUILD_MESSAGE_TYPES = new Set([
  "GuildMemberMessage",
  "GuildMessageDelete",
  "GuildMessageUpdate",
  "GuildMessageBulkDelete",
]);

export const isGuildMessageEvent = (
  event: DiscordEvent,
): event is GuildMessageEvent => GUILD_MESSAGE_TYPES.has(event.type);

export const isGuildMemberMessage = (
  event: DiscordEvent,
): event is GuildMemberMessage => event.type === "GuildMemberMessage";

export const isMessageReactionAddEvent = (
  event: DiscordEvent,
): event is MessageReactionAddEvent => event.type === "MessageReactionAdd";

export const isGuildCreateOrDeleteEvent = (
  event: DiscordEvent,
): event is GuildCreateEvent | GuildDeleteEvent =>
  event.type === "GuildCreate" || event.type === "GuildDelete";
