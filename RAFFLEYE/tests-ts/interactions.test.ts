import { afterEach, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { Bot } from '../app/bot.js';
import { Service } from '../app/service.js';
import { Store } from '../app/storage.js';
import { offlineSettings } from '../app/config.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const settings = offlineSettings(':memory:'); settings.discord_guild_id = '123';
  const service = new Service(store, settings), bot = new Bot(service, () => {}, new AbortController().signal);
  const reply = vi.fn(), update = vi.fn();
  const interaction = {
    customId: 'raffleye:home', guildId:'123', guild:{}, user:{id:'456'}, deferred:false, replied:false,
    isRepliable: () => true, inGuild: () => true, isChatInputCommand: () => false, isMessageComponent: () => true,
    isModalSubmit: () => false, isButton: () => true, isChannelSelectMenu: () => false, isStringSelectMenu: () => false,
    message:{flags:{has:() => false}}, reply, update,
  };
  return { bot, interaction, reply, update };
}
it('public dashboard button opens a private reply', async () => {
  const { bot, interaction, reply, update } = setup();
  await bot.handle(interaction as unknown as Interaction);
  expect(reply).toHaveBeenCalledOnce(); expect(update).not.toHaveBeenCalled();
  expect(reply.mock.calls[0]![0].flags).toBe(MessageFlags.Ephemeral);
  expect(reply.mock.calls[0]![0].embeds[0].data.title).toBe('RAFFLEYE');
});
it('private help navigation updates the existing menu', async () => {
  const { bot, interaction, reply, update } = setup();
  interaction.customId = 'raffleye:help:cards'; interaction.message.flags.has = () => true;
  await bot.handle(interaction as unknown as Interaction);
  expect(reply).not.toHaveBeenCalled(); expect(update.mock.calls[0]![0].embeds[0].data.description).toContain('profile location');
});
it('rejects controls from another server', async () => {
  const { bot, interaction, reply } = setup(); interaction.guildId = '789';
  await bot.handle(interaction as unknown as Interaction);
  expect(reply.mock.calls[0]![0].content).toContain('configured server');
});
