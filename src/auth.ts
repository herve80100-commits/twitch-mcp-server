import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope?: string[];
}

export interface TokenInfo {
  client_id: string;
  login: string;
  user_id: string;
  scopes: string[];
  expires_in: number;
}

const OAUTH = "https://id.twitch.tv/oauth2";

export async function readTokens(config: Config): Promise<Tokens> {
  try {
    return JSON.parse(await fs.readFile(config.tokenFile, "utf8")) as Tokens;
  } catch {
    throw new Error(
      `Aucun jeton trouvé dans ${config.tokenFile}. Lancez d'abord \`npm run auth\`.`,
    );
  }
}

export async function writeTokens(config: Config, tokens: Tokens): Promise<void> {
  await fs.mkdir(path.dirname(config.tokenFile), { recursive: true });
  await fs.writeFile(config.tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Échec OAuth Twitch (${res.status}) : ${await res.text()}`);
  }
  return (await res.json()) as Tokens;
}

export function exchangeCode(config: Config, code: string, redirectUri: string) {
  return tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
}

export function refreshTokens(config: Config, refreshToken: string) {
  return tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function validate(accessToken: string): Promise<TokenInfo | null> {
  const res = await fetch(`${OAUTH}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  return res.ok ? ((await res.json()) as TokenInfo) : null;
}

/** Garde le jeton utilisateur en mémoire et le renouvelle quand Twitch le refuse. */
export class TokenManager {
  private tokens: Tokens | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  async getAccessToken(): Promise<string> {
    if (!this.tokens) this.tokens = await readTokens(this.config);
    return this.tokens.access_token;
  }

  async refresh(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const current = this.tokens ?? (await readTokens(this.config));
        const next = await refreshTokens(this.config, current.refresh_token);
        this.tokens = next;
        await writeTokens(this.config, next);
        return next.access_token;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Valide le jeton (en le renouvelant si besoin) et renvoie l'identité associée. */
  async whoami(): Promise<TokenInfo> {
    let info = await validate(await this.getAccessToken());
    if (!info) info = await validate(await this.refresh());
    if (!info) throw new Error("Jeton Twitch invalide. Relancez `npm run auth`.");
    return info;
  }
}
