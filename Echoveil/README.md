# Echoveil

A new Discord confession bot. Members click **Write a confession**, complete a private popup, and Echoveil publishes an anonymous embed in your chosen channel. Writing in the popup never sends a member message or a channel typing indicator. Submission confirmations and errors are private.

Built with the same core stack as the improved RAFFLEYE: TypeScript 5.9, Node.js 22, discord.js 14.27, strict compiler checks, ESLint, and Vitest. Source lives in `app/`; compiled output goes to `dist/`. This is a separate bot with its own token and configuration.

## Setup on Windows

1. Install Node.js 22.12 or newer (Node 22 is already available on this computer).
2. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application named **Echoveil**, and set its bot username to **Echoveil**. You can add your own avatar. This is a separate application from the existing Echoveil; its ID and discriminator will be different.
3. In the application's **Bot** settings, generate/reset the token. Keep it private and paste it only into your local `.env` file. No privileged gateway intents are needed.
4. Install the application to your server using the `bot` and `applications.commands` scopes. Grant **View Channels**, **Send Messages**, **Embed Links**, and **Read Message History**. Administrator permission is not needed.
5. Enable Developer Mode in Discord under User Settings → Advanced. Copy your server ID and your confession text channel ID. Copy the Application ID from the developer portal.
6. In this folder, run:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   npm install
   npm run validate
   npm run register
   npm start
   ```

   Fill all four `.env` values before running registration. Do not commit or share `.env`.
7. As a member with **Manage Server**, run `/confession-panel`. Echoveil posts its permanent button in the configured channel. Run this once; running it again posts another panel. Existing buttons keep working after a bot restart.
8. Make the confession channel read-only for members: deny **Send Messages**, **Create Public Threads**, **Create Private Threads**, and **Send Messages in Threads** for `@everyone`. Check other roles and member overrides too: explicit allows can override the restriction. Keep **View Channel** and **Read Message History** enabled. Allow Echoveil **Send Messages** and **Embed Links** explicitly. Administrator users bypass channel restrictions. The bot does not automatically modify server permissions.

The bot process must remain running to accept confessions. Closing the terminal or sleeping/shutting down the computer stops it. For continuous operation, run one instance on an always-on host. The cooldown is in memory and resets after restart; it is not shared between instances.

## Privacy and behavior

- Click **My settings** on the panel or a new confession, or run `/confession-settings`, to turn your success confirmation off/on. Settings are private and work during cooldown. When off, the temporary private acknowledgement is deleted after successful posting; failures still show. Discord may briefly show a loading indicator while sending.
- Opt-out preferences persist in `data/preferences.json` as user IDs only, separately from confessions, with no post IDs, text, or submission history. Turning confirmations back on removes the stored preference. Docker uses a dedicated volume for this file.

- No message-content intent and no public message listener: the bot never uses a post-and-delete submission flow.
- No author name, avatar, ID, or member mention is added to confession posts.
- Discord interaction payloads include the submitter's identity. This implementation does not store confession content or author-to-post mappings on disk and does not log interaction payloads or raw API errors. Operators who change the code could capture that information; this is anonymity from other members, not from Discord.
- A user ID and expiry timestamp are held in memory for a 45-second cooldown and then discarded. In-flight user IDs are held only while handling a submission.
- Confession content remains in the public Discord message until a moderator deletes it. Identifying information typed by the author is not automatically removed.
- Mention pings are disabled. Confessions allow up to 4,000 characters and publish immediately without moderation approval. Moderators can remove posts using Discord's normal controls.
- If a network request has an uncertain result, the private error asks the member to check the channel before retrying. Delivery cannot be guaranteed exactly once across network failures.

## Verification

Run `npm run validate` after code changes to type-check, lint, compile and test. Run `npm run build` before restarting the bot. The included GitHub Actions workflow runs validation when this folder is used as the repository root.

Run `npm test` for local tests covering popup construction, identity exclusion, private acknowledgements, mention suppression, validation, cooldowns, concurrent submissions, permissions, server isolation and failed sends.

Before inviting members, verify with a second Discord account: open and type in the popup, confirm the other account sees no typing indicator or draft, submit, and confirm it sees only Echoveil's anonymous post. Test read-only channel permissions with a regular member account. Test a restart with the existing button. Live Discord behavior requires your own configured application; local tests use mocks.

API references: [Discord interactions](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx), [discord.js modal builder](https://discord.js.org/docs/packages/discord.js/main/ModalBuilder%3AClass), [Discord channel permissions](https://support.discord.com/hc/en-us/articles/10543994968087-Channel-Permissions-Settings-101).

## Docker (optional)

With Docker installed and `.env` configured:

```powershell
docker compose build
docker compose run --rm sinner node dist/register.js
docker compose up -d
```

After changes, run `docker compose up -d --build`. The image build must pass validation before launch. Docker restarts the container after a crash while Docker is running. Docker does not keep the bot online when the host is asleep or off. Never run the local process and Docker copy at the same time. No automatic commit watcher is installed for Echoveil; these files prepare deployment but do not activate it.
