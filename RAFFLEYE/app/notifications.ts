import { AttachmentBuilder, MessageFlags } from 'discord.js';
import type { MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { errorCode, log, SafeError } from './log.js';
import { parsePost, sha256, terminal } from './models.js';
import { cardButtons, giveawayEmbed, NO_MENTIONS, visible } from './presentation.js';
import { PostScreenshots } from './screenshots.js';
import type { Service } from './service.js';

export interface DeliveryChannel {
  guildId: string;
  ping?():Promise<Pick<MessageCreateOptions,'content'|'allowedMentions'>>;
  send(options: MessageCreateOptions): Promise<{ id: string }>;
  edit(messageId: string, options: MessageEditOptions): Promise<{ id: string }>;
}
function missingMessage(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 10008;
}
export class Notifier {
  screenshots: PostScreenshots;
  constructor(private readonly service: Service, private readonly channel: (id: string) => Promise<DeliveryChannel>, private readonly assertOwner: () => void = () => {}, private readonly clock: () => number = Date.now, private readonly signal?: AbortSignal) {
    this.screenshots = new PostScreenshots(service.settings, signal);
  }
  async notify(): Promise<void> {
    const { store, settings } = this.service;
    for (const item of store.pendingNotifications(this.clock())) {
      this.signal?.throwIfAborted();
      this.assertOwner();
      store.setMeta('last_progress', new Date(this.clock()).toISOString());
      const row = store.giveaway(item.post_id);
      if (!row || !visible(row, settings.giveaway_topic) || (!item.message_id && terminal(row.status))) { store.discardNotification(item); continue; }
      const paceKey = 'notification_after:' + item.channel_id;
      const canSend = Number(store.meta(paceKey, '0')) <= this.clock() / 1000 && !store.paused(item.channel_id);
      if (!item.message_id && !canSend) continue;
      let sentNew = false;
      try {
        const channel = await this.channel(item.channel_id);
        if (channel.guildId !== settings.discord_guild_id) throw new SafeError('invalid_configured_channel');
        const post = parsePost(row.post), embed = giveawayEmbed(row), buttons = cardButtons(row);
        const closure = store.metaJson<{ author: string; source_id: string } | null>('closure:' + post.id, null);
        if (terminal(row.status) && closure) embed.setDescription(`**${row.status === 'cancelled' ? 'Cancelled' : 'Ended'} — [host update](https://x.com/${closure.author}/status/${closure.source_id})**\n` + embed.data.description);
        const screenshot = await this.screenshots.get(post);
        if (screenshot) embed.setImage(`attachment://post-${post.id}.png`);
        const files = () => screenshot ? [new AttachmentBuilder(screenshot, { name: `post-${post.id}.png` })] : [];
        const send = async () => {
          this.assertOwner(); this.signal?.throwIfAborted();
          const ping:MessageCreateOptions=!item.message_id&&channel.ping?await channel.ping():{allowedMentions:NO_MENTIONS,flags:MessageFlags.SuppressNotifications};
          const message = await channel.send({ embeds: [embed], components: [buttons], files: files(), ...ping, nonce: sha256(item.channel_id + ':' + item.post_id).slice(0, 24), enforceNonce: true });
          sentNew = true;
          return message;
        };
        let message: { id: string };
        if (item.message_id) {
          try {
            this.assertOwner(); this.signal?.throwIfAborted();
            message = await channel.edit(item.message_id, { embeds: [embed], components: [buttons], attachments: [], files: files(), allowedMentions: NO_MENTIONS });
          } catch (error) {
            if (!missingMessage(error)) throw error;
            if (terminal(row.status)) { store.discardNotification(item); continue; }
            if (!canSend) continue;
            message = await send();
          }
        } else message = await send();
        store.transaction(() => {
          if (sentNew) store.setMeta(paceKey, this.clock() / 1000 + settings.notification_interval_seconds);
          store.delivered(item, message.id);
          store.setMeta('last_delivery', new Date(this.clock()).toISOString());
        });
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (error instanceof SafeError && error.code === 'worker_lease_lost') throw error;
        store.deliveryFailed(item, errorCode(error), this.clock());
        log('delivery_deferred', { error: errorCode(error) });
      }
    }
  }
}
