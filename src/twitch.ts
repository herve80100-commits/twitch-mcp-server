import type { Config } from "./config.js";
import type { TokenManager } from "./auth.js";

const HELIX = "https://api.twitch.tv/helix";

type Query = Record<string, string | number | boolean | undefined | string[]>;

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  description: string;
  broadcaster_type: string;
  created_at: string;
  profile_image_url: string;
}

export class TwitchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class TwitchClient {
  /** Identité du compte authentifié (diffuseur ou modérateur/bot). */
  me!: { id: string; login: string; scopes: string[] };
  /** Chaîne ciblée par défaut. */
  channel!: TwitchUser;

  constructor(
    private readonly config: Config,
    private readonly tokens: TokenManager,
  ) {}

  async init(): Promise<void> {
    const info = await this.tokens.whoami();
    this.me = { id: info.user_id, login: info.login, scopes: info.scopes };
    const login = this.config.channel || info.login;
    const user = await this.getUser(login);
    if (!user) throw new Error(`Chaîne Twitch introuvable : ${login}`);
    this.channel = user;
  }

  async request<T = any>(
    method: string,
    endpoint: string,
    query: Query = {},
    body?: unknown,
    retry = true,
  ): Promise<T> {
    const url = new URL(HELIX + endpoint);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        "Client-Id": this.config.clientId,
        Authorization: `Bearer ${await this.tokens.getAccessToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      await this.tokens.refresh();
      return this.request(method, endpoint, query, body, false);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new TwitchError(res.status, `Twitch ${method} ${endpoint} → ${res.status} : ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getUser(login: string): Promise<TwitchUser | undefined> {
    const { data } = await this.request<{ data: TwitchUser[] }>("GET", "/users", { login });
    return data[0];
  }

  async getUsers(logins: string[]): Promise<TwitchUser[]> {
    if (logins.length === 0) return [];
    const { data } = await this.request<{ data: TwitchUser[] }>("GET", "/users", { login: logins });
    return data;
  }

  /** Résout un login (ou la chaîne par défaut) en identifiant Twitch. */
  async resolveId(login?: string): Promise<string> {
    if (!login || login.toLowerCase() === this.channel.login) return this.channel.id;
    const user = await this.getUser(login.toLowerCase());
    if (!user) throw new Error(`Utilisateur Twitch introuvable : ${login}`);
    return user.id;
  }
}
