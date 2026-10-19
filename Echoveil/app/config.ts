export interface Settings {
  DISCORD_TOKEN: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  CONFESSION_CHANNEL_ID: string;
}

export function config(): Settings {
  const keys = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'CONFESSION_CHANNEL_ID'];
  for (const key of keys) {
    if (!process.env[key] || process.env[key].startsWith('replace_')) {
      throw new Error(`Set ${key} in .env first.`);
    }
  }
  for (const key of keys.slice(1)) {
    if (!/^\d{17,20}$/.test(process.env[key] ?? '')) throw new Error(`${key} must be a Discord ID.`);
  }
  return {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN!,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID!,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID!,
    CONFESSION_CHANNEL_ID: process.env.CONFESSION_CHANNEL_ID!,
  };
}
