import os from "node:os";
import path from "node:path";

export const SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:read:followers",
  "moderator:read:chatters",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
  "moderator:manage:chat_settings",
  "moderator:manage:announcements",
  "moderator:manage:shoutouts",
  "clips:edit",
  "channel:manage:broadcast",
  "channel:read:subscriptions",
  "bits:read",
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  }
  return value;
}

export interface Config {
  clientId: string;
  clientSecret: string;
  channel: string;
  tokenFile: string;
  authPort: number;
}

export function loadConfig(): Config {
  return {
    clientId: required("TWITCH_CLIENT_ID"),
    clientSecret: required("TWITCH_CLIENT_SECRET"),
    channel: (process.env.TWITCH_CHANNEL ?? "").toLowerCase(),
    tokenFile:
      process.env.TWITCH_TOKEN_FILE ?? path.join(os.homedir(), ".twitch-mcp", "tokens.json"),
    authPort: Number(process.env.TWITCH_AUTH_PORT ?? 3000),
  };
}
