import WebSocket from "ws";
import type { TwitchClient } from "./twitch.js";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";

export interface ChatMessage {
  id: string;
  user_login: string;
  user_name: string;
  user_id: string;
  text: string;
  badges: string[];
  reply_to?: string;
  at: string;
}

export interface StreamEvent {
  type: string;
  at: string;
  summary: string;
  data: Record<string, unknown>;
}

/** Abonnements EventSub ouverts au démarrage, avec le scope qu'ils exigent. */
function subscriptions(broadcasterId: string, meId: string) {
  return [
    { type: "channel.chat.message", version: "1", scope: "user:read:chat",
      condition: { broadcaster_user_id: broadcasterId, user_id: meId } },
    { type: "channel.follow", version: "2", scope: "moderator:read:followers",
      condition: { broadcaster_user_id: broadcasterId, moderator_user_id: meId } },
    { type: "channel.subscribe", version: "1", scope: "channel:read:subscriptions",
      condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.subscription.gift", version: "1", scope: "channel:read:subscriptions",
      condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.cheer", version: "1", scope: "bits:read",
      condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.raid", version: "1", scope: null,
      condition: { to_broadcaster_user_id: broadcasterId } },
    { type: "stream.online", version: "1", scope: null,
      condition: { broadcaster_user_id: broadcasterId } },
    { type: "stream.offline", version: "1", scope: null,
      condition: { broadcaster_user_id: broadcasterId } },
  ];
}

function summarize(type: string, e: any): string {
  switch (type) {
    case "channel.follow":
      return `${e.user_name} suit maintenant la chaîne`;
    case "channel.subscribe":
      return `${e.user_name} s'est abonné (tier ${Number(e.tier) / 1000})${e.is_gift ? " (offert)" : ""}`;
    case "channel.subscription.gift":
      return `${e.is_anonymous ? "Anonyme" : e.user_name} a offert ${e.total} abonnement(s)`;
    case "channel.cheer":
      return `${e.is_anonymous ? "Anonyme" : e.user_name} a envoyé ${e.bits} bits : ${e.message}`;
    case "channel.raid":
      return `Raid de ${e.from_broadcaster_user_name} avec ${e.viewers} spectateurs`;
    case "stream.online":
      return "Le stream a démarré";
    case "stream.offline":
      return "Le stream est terminé";
    default:
      return type;
  }
}

/**
 * Client EventSub WebSocket : reçoit le chat et les événements de la chaîne
 * et les garde dans des tampons circulaires que les outils MCP consultent.
 */
export class EventSubListener {
  readonly chat: ChatMessage[] = [];
  readonly events: StreamEvent[] = [];
  readonly status: { connected: boolean; active: string[]; failed: string[] } = {
    connected: false,
    active: [],
    failed: [],
  };
  private ws: WebSocket | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly twitch: TwitchClient,
    private readonly maxChat = 500,
    private readonly maxEvents = 200,
  ) {}

  start(url = EVENTSUB_URL): void {
    this.stopped = false;
    this.connect(url, false);
  }

  stop(): void {
    this.stopped = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.ws?.close();
  }

  private connect(url: string, isReconnect: boolean): void {
    const ws = new WebSocket(url);
    const previous = this.ws;
    this.ws = ws;

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const type = msg.metadata?.message_type;
      const keepalive = msg.payload?.session?.keepalive_timeout_seconds;
      this.armKeepalive(keepalive);

      if (type === "session_welcome") {
        this.status.connected = true;
        if (isReconnect) {
          // Twitch conserve les abonnements lors d'un session_reconnect.
          previous?.close();
        } else {
          this.subscribeAll(msg.payload.session.id).catch((err) =>
            console.error("[eventsub] abonnement :", err),
          );
        }
      } else if (type === "session_reconnect") {
        this.connect(msg.payload.session.reconnect_url, true);
      } else if (type === "notification") {
        this.handle(msg.payload.subscription.type, msg.payload.event);
      } else if (type === "revocation") {
        const t = msg.payload.subscription.type;
        this.status.active = this.status.active.filter((s) => s !== t);
        this.status.failed.push(`${t} (révoqué : ${msg.payload.subscription.status})`);
      }
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.status.connected = false;
      if (this.stopped) return;
      console.error("[eventsub] connexion fermée, reconnexion dans 5 s");
      setTimeout(() => !this.stopped && this.connect(EVENTSUB_URL, false), 5000);
    });

    ws.on("error", (err) => console.error("[eventsub] erreur :", err.message));
  }

  private armKeepalive(seconds?: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    const timeout = ((seconds ?? 10) + 10) * 1000;
    this.keepaliveTimer = setTimeout(() => {
      console.error("[eventsub] plus de keepalive, reconnexion");
      this.ws?.terminate();
    }, timeout);
  }

  private async subscribeAll(sessionId: string): Promise<void> {
    this.status.active = [];
    this.status.failed = [];
    const scopes = new Set(this.twitch.me.scopes);
    for (const sub of subscriptions(this.twitch.channel.id, this.twitch.me.id)) {
      if (sub.scope && !scopes.has(sub.scope)) {
        this.status.failed.push(`${sub.type} (scope manquant : ${sub.scope})`);
        continue;
      }
      try {
        await this.twitch.request("POST", "/eventsub/subscriptions", {}, {
          type: sub.type,
          version: sub.version,
          condition: sub.condition,
          transport: { method: "websocket", session_id: sessionId },
        });
        this.status.active.push(sub.type);
      } catch (err) {
        this.status.failed.push(`${sub.type} (${(err as Error).message})`);
      }
    }
    console.error(`[eventsub] actifs : ${this.status.active.join(", ") || "aucun"}`);
  }

  private handle(type: string, e: any): void {
    const at = new Date().toISOString();
    if (type === "channel.chat.message") {
      this.chat.push({
        id: e.message_id,
        user_login: e.chatter_user_login,
        user_name: e.chatter_user_name,
        user_id: e.chatter_user_id,
        text: e.message?.text ?? "",
        badges: (e.badges ?? []).map((b: any) => b.set_id),
        reply_to: e.reply?.parent_user_login,
        at,
      });
      if (this.chat.length > this.maxChat) this.chat.splice(0, this.chat.length - this.maxChat);
      return;
    }
    this.events.push({ type, at, summary: summarize(type, e), data: e });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
}
