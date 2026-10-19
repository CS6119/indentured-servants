import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags } from 'discord.js';
import { createHandler, confessionPost, modal, panel, MODAL, BUTTON, SETTINGS, CONFIRM_OFF, CONFIRM_ON } from '../app/confessions.ts';
import { Preferences } from '../app/preferences.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const posts = [];
  const preferences = new Preferences();
  const channel = { type: ChannelType.GuildText, guildId: 'server', guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => true }), send: async body => { posts.push(body); } };
  const handler = createHandler({ channels: { fetch: async () => channel } },
    { DISCORD_GUILD_ID: 'server', CONFESSION_CHANNEL_ID: 'channel' }, preferences);
  function interaction(text = 'A private thought') {
    const replies = [];
    return { guildId: 'server', user: { id: 'secret-author' }, customId: MODAL,
      isChatInputCommand: () => false, isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: () => text }, replies,
      reply: async body => { replies.push(body); }, deferReply: async body => { replies.push(body); },
      deleteReply: async () => { replies.push('deleted'); }, update: async body => { replies.push(body); },
      editReply: async body => { replies.push(body); }, showModal: async body => { replies.push(body.toJSON()); } };
  }
  return { handler, posts, channel, interaction, preferences };
}

test('personal opt-out deletes only the private acknowledgement after publishing', async () => {
  const f = fixture();
  f.preferences.setConfirmations('secret-author', false);
  const i = f.interaction(); await f.handler(i);
  assert.equal(f.posts.length, 1);
  assert.equal(i.replies.at(-1), 'deleted');
  const other = f.interaction(); other.user.id = 'other'; await f.handler(other);
  assert.equal(other.replies.at(-1).content, 'Your confession has been posted anonymously.');
});
test('settings are private, work during cooldown and can turn confirmations back on', async () => {
  const f = fixture(); await f.handler(f.interaction());
  const i = f.interaction(); i.isModalSubmit = () => false; i.isButton = () => true;
  i.customId = SETTINGS; await f.handler(i);
  assert.equal(i.replies.at(-1).flags, MessageFlags.Ephemeral);
  i.customId = CONFIRM_OFF; await f.handler(i);
  assert.equal(f.preferences.confirmations(i.user.id), false);
  assert.equal(f.preferences.confirmations('other'), true);
  i.customId = CONFIRM_ON; await f.handler(i);
  assert.equal(f.preferences.confirmations(i.user.id), true);
  assert.equal(f.posts.length, 1);
});
test('hiding confirmations does not hide a failed submission', async () => {
  const f = fixture(); f.preferences.setConfirmations('secret-author', false);
  f.channel.send = async () => { throw new Error('offline'); };
  const i = f.interaction(); await assert.rejects(f.handler(i));
  assert.ok(!i.replies.includes('deleted'));
});
test('preferences survive restart and store only opted-out user IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echoveil-prefs-'));
  try {
    const file = join(dir, 'preferences.json');
    const first = new Preferences(file); first.setConfirmations('123', false);
    const restored = new Preferences(file);
    assert.equal(restored.confirmations('123'), false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['123']);
    restored.setConfirmations('123', true);
    assert.equal(new Preferences(file).confirmations('123'), true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Discord validates the panel and modal component structures', () => {
  assert.equal(modal().toJSON().custom_id, MODAL);
  assert.equal(panel().components[0].toJSON().components[0].custom_id, BUTTON);
});
test('posts contain text but no submitting identity and never ping mentions', async () => {
  const f = fixture();
  const i = f.interaction('@everyone hello');
  await f.handler(i);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].embeds[0].toJSON().description, '@everyone hello');
  assert.ok(!JSON.stringify(f.posts).includes('secret-author'));
  assert.deepEqual(f.posts[0].allowedMentions.parse, []);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
});
test('opening the popup never publishes a channel message', async () => {
  const f = fixture(); const i = f.interaction();
  i.customId = BUTTON; i.isButton = () => true; i.isModalSubmit = () => false;
  await f.handler(i);
  assert.equal(f.posts.length, 0);
  assert.equal(i.replies[0].custom_id, MODAL);
});
test('empty text and oversized submissions are rejected', async () => {
  assert.throws(() => confessionPost('   '));
  assert.throws(() => confessionPost('x'.repeat(4001)));
  const f = fixture(); await f.handler(f.interaction('  ')); assert.equal(f.posts.length, 0);
});
test('repeat submissions are rate limited', async () => {
  const f = fixture(); await f.handler(f.interaction()); await f.handler(f.interaction());
  assert.equal(f.posts.length, 1);
});
test('simultaneous submissions cannot bypass the cooldown', async () => {
  const f = fixture(); await Promise.all([f.handler(f.interaction()), f.handler(f.interaction())]);
  assert.equal(f.posts.length, 1);
});
test('failed sends release pending state so a retry is possible', async () => {
  const f = fixture(); const send = f.channel.send;
  f.channel.send = async () => { throw new Error('offline'); };
  await assert.rejects(f.handler(f.interaction()));
  f.channel.send = send; await f.handler(f.interaction()); assert.equal(f.posts.length, 1);
});
test('wrong server and missing bot permissions cannot publish', async () => {
  const f = fixture(); const i = f.interaction(); i.guildId = 'other';
  await f.handler(i); assert.equal(f.posts.length, 0);
  f.channel.permissionsFor = () => ({ has: () => false });
  await assert.rejects(f.handler(f.interaction())); assert.equal(f.posts.length, 0);
});
test('panel command requires Manage Server', async () => {
  const f = fixture(); const i = f.interaction();
  i.isChatInputCommand = () => true; i.isModalSubmit = () => false;
  i.commandName = 'confession-panel'; i.memberPermissions = { has: () => false };
  await f.handler(i); assert.equal(f.posts.length, 0);
});
