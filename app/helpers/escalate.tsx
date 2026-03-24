import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ThreadChannel,
} from "discord.js";

export async function escalationControls(
  reportedUserId: string,
  thread: ThreadChannel,
) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Moderator controls**"),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`escalate-delete|${reportedUserId}`)
          .setLabel("Delete all reported messages")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`escalate-kick|${reportedUserId}`)
          .setLabel("Kick")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`escalate-ban|${reportedUserId}`)
          .setLabel("Ban")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`escalate-ban-delete|${reportedUserId}`)
          .setLabel("Ban + Delete (7d)")
          .setStyle(ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`escalate-restrict|${reportedUserId}`)
          .setLabel("Restrict")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`escalate-timeout|${reportedUserId}`)
          .setLabel("Timeout")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Anyone can escalate, which will notify moderators and call for a vote on how to respond.",
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`escalate-escalate|${reportedUserId}|0`)
          .setLabel("Escalate")
          .setStyle(ButtonStyle.Primary),
      ),
    );

  await thread.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}
