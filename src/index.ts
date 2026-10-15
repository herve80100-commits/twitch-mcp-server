#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { TokenManager } from "./auth.js";
import { TwitchClient } from "./twitch.js";
import { EventSubListener } from "./eventsub.js";

const config = loadConfig();
const twitch = new TwitchClient(config, new TokenManager(config));
const listener = new EventSubListener(twitch);

const server = new McpServer({ name: "twitch-mcp-server", version: "0.1.0" });

const login = z
  .string()
  .optional()
  .describe("Login Twitch de la chaîne (par défaut : la chaîne configurée)");

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

/** Enveloppe un handler pour transformer les exceptions en erreurs lisibles par Claude. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
    }
  };
}

const read = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

// ---------- Lecture ----------

server.registerTool(
  "get_connection_status",
  {
    title: "État de la connexion",
    description: "Compte authentifié, chaîne ciblée, scopes accordés et abonnements EventSub actifs.",
    inputSchema: {},
    annotations: read,
  },
  safe(async () =>
    ok({
      authenticated_as: twitch.me.login,
      channel: twitch.channel.login,
      scopes: twitch.me.scopes,
      eventsub: listener.status,
      chat_messages_buffered: listener.chat.length,
      events_buffered: listener.events.length,
    }),
  ),
);

server.registerTool(
  "get_channel_info",
  {
    title: "Infos de la chaîne",
    description: "Profil et réglages d'une chaîne : titre, catégorie, langue, tags, description.",
    inputSchema: { login },
    annotations: read,
  },
  safe(async ({ login }) => {
    const user = login ? await twitch.getUser(login.toLowerCase()) : twitch.channel;
    if (!user) throw new Error(`Chaîne introuvable : ${login}`);
    const { data } = await twitch.request("GET", "/channels", { broadcaster_id: user.id });
    return ok({ ...user, channel: data[0] });
  }),
);

server.registerTool(
  "get_stream_status",
  {
    title: "État du stream",
    description: "Indique si la chaîne est en direct, avec titre, catégorie, nombre de spectateurs et heure de début.",
    inputSchema: { login },
    annotations: read,
  },
  safe(async ({ login }) => {
    const user_login = (login ?? twitch.channel.login).toLowerCase();
    const { data } = await twitch.request("GET", "/streams", { user_login });
    return ok(data[0] ? { live: true, ...data[0] } : { live: false, login: user_login });
  }),
);

server.registerTool(
  "get_followers",
  {
    title: "Followers",
    description:
      "Liste les followers de la chaîne configurée (les plus récents d'abord) et leur nombre total. " +
      "Nécessite d'être diffuseur ou modérateur de la chaîne.",
    inputSchema: {
      first: z.number().int().min(1).max(100).default(20).describe("Nombre de résultats (1-100)"),
      after: z.string().optional().describe("Curseur de pagination renvoyé par l'appel précédent"),
    },
    annotations: read,
  },
  safe(async ({ first, after }) => {
    const res = await twitch.request("GET", "/channels/followers", {
      broadcaster_id: twitch.channel.id,
      first,
      after,
    });
    return ok({ total: res.total, followers: res.data, next_cursor: res.pagination?.cursor });
  }),
);

server.registerTool(
  "get_chatters",
  {
    title: "Spectateurs connectés au chat",
    description: "Liste les utilisateurs actuellement connectés au chat de la chaîne configurée.",
    inputSchema: {
      first: z.number().int().min(1).max(1000).default(100),
      after: z.string().optional(),
    },
    annotations: read,
  },
  safe(async ({ first, after }) => {
    const res = await twitch.request("GET", "/chat/chatters", {
      broadcaster_id: twitch.channel.id,
      moderator_id: twitch.me.id,
      first,
      after,
    });
    return ok({ total: res.total, chatters: res.data, next_cursor: res.pagination?.cursor });
  }),
);

server.registerTool(
  "get_clips",
  {
    title: "Clips",
    description: "Liste les clips d'une chaîne, éventuellement sur une période donnée (dates ISO 8601).",
    inputSchema: {
      login,
      first: z.number().int().min(1).max(100).default(20),
      started_at: z.string().optional().describe("Début de période, ex. 2026-10-01T00:00:00Z"),
      ended_at: z.string().optional().describe("Fin de période"),
      after: z.string().optional(),
    },
    annotations: read,
  },
  safe(async ({ login, first, started_at, ended_at, after }) => {
    const res = await twitch.request("GET", "/clips", {
      broadcaster_id: await twitch.resolveId(login),
      first,
      started_at,
      ended_at,
      after,
    });
    const clips = res.data.map((c: any) => ({
      id: c.id,
      title: c.title,
      url: c.url,
      creator: c.creator_name,
      views: c.view_count,
      duration: c.duration,
      created_at: c.created_at,
    }));
    return ok({ clips, next_cursor: res.pagination?.cursor });
  }),
);

server.registerTool(
  "read_chat",
  {
    title: "Lire le chat",
    description:
      "Renvoie les derniers messages du chat reçus en direct depuis le démarrage du serveur " +
      "(500 au maximum en mémoire).",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(50),
      since_minutes: z.number().positive().optional().describe("Seulement les N dernières minutes"),
      user: z.string().optional().describe("Filtrer sur un login"),
    },
    annotations: read,
  },
  safe(async ({ limit, since_minutes, user }) => {
    let messages = listener.chat;
    if (since_minutes) {
      const from = Date.now() - since_minutes * 60_000;
      messages = messages.filter((m) => Date.parse(m.at) >= from);
    }
    if (user) messages = messages.filter((m) => m.user_login === user.toLowerCase());
    const out = messages.slice(-limit);
    if (out.length === 0 && !listener.status.active.includes("channel.chat.message")) {
      return ok({ messages: [], warning: "L'abonnement au chat n'est pas actif.", eventsub: listener.status });
    }
    return ok({ messages: out });
  }),
);

server.registerTool(
  "get_recent_events",
  {
    title: "Événements récents",
    description:
      "Événements reçus en direct via EventSub : nouveaux followers, abonnements, abonnements offerts, " +
      "bits, raids, début et fin de stream.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(20),
      type: z
        .string()
        .optional()
        .describe("Filtrer par type, ex. channel.follow, channel.subscribe, channel.cheer, channel.raid"),
    },
    annotations: read,
  },
  safe(async ({ limit, type }) => {
    const events = type ? listener.events.filter((e) => e.type === type) : listener.events;
    return ok(events.slice(-limit).map(({ type, at, summary }) => ({ type, at, summary })));
  }),
);

server.registerTool(
  "search_categories",
  {
    title: "Chercher une catégorie",
    description: "Recherche une catégorie (jeu) Twitch par nom.",
    inputSchema: { query: z.string(), first: z.number().int().min(1).max(100).default(10) },
    annotations: read,
  },
  safe(async ({ query, first }) => {
    const { data } = await twitch.request("GET", "/search/categories", { query, first });
    return ok(data.map((c: any) => ({ id: c.id, name: c.name })));
  }),
);

// ---------- Actions (bot et modération) ----------

server.registerTool(
  "send_chat_message",
  {
    title: "Envoyer un message",
    description: "Envoie un message dans le chat de la chaîne configurée, éventuellement en réponse à un message.",
    inputSchema: {
      message: z.string().min(1).max(500),
      reply_to_message_id: z.string().optional().describe("ID d'un message (voir read_chat)"),
    },
    annotations: write,
  },
  safe(async ({ message, reply_to_message_id }) => {
    const { data } = await twitch.request("POST", "/chat/messages", {}, {
      broadcaster_id: twitch.channel.id,
      sender_id: twitch.me.id,
      message,
      reply_parent_message_id: reply_to_message_id,
    });
    const result = data[0];
    if (!result.is_sent) throw new Error(`Message refusé : ${result.drop_reason?.message ?? "raison inconnue"}`);
    return ok({ sent: true, message_id: result.message_id });
  }),
);

server.registerTool(
  "send_announcement",
  {
    title: "Annonce",
    description: "Publie une annonce mise en avant dans le chat.",
    inputSchema: {
      message: z.string().min(1).max(500),
      color: z.enum(["primary", "blue", "green", "orange", "purple"]).default("primary"),
    },
    annotations: write,
  },
  safe(async ({ message, color }) => {
    await twitch.request(
      "POST",
      "/chat/announcements",
      { broadcaster_id: twitch.channel.id, moderator_id: twitch.me.id },
      { message, color },
    );
    return ok("Annonce publiée.");
  }),
);

server.registerTool(
  "create_clip",
  {
    title: "Créer un clip",
    description: "Crée un clip des dernières secondes du stream (la chaîne doit être en direct).",
    inputSchema: { login },
    annotations: write,
  },
  safe(async ({ login }) => {
    const { data } = await twitch.request("POST", "/clips", { broadcaster_id: await twitch.resolveId(login) });
    return ok({ id: data[0].id, edit_url: data[0].edit_url });
  }),
);

server.registerTool(
  "shoutout",
  {
    title: "Shoutout",
    description: "Fait un shoutout officiel à une autre chaîne (la chaîne doit être en direct).",
    inputSchema: { user: z.string().describe("Login de la chaîne à mettre en avant") },
    annotations: write,
  },
  safe(async ({ user }) => {
    await twitch.request("POST", "/chat/shoutouts", {
      from_broadcaster_id: twitch.channel.id,
      to_broadcaster_id: await twitch.resolveId(user),
      moderator_id: twitch.me.id,
    });
    return ok(`Shoutout envoyé à ${user}.`);
  }),
);

server.registerTool(
  "delete_chat_message",
  {
    title: "Supprimer un message",
    description: "Supprime un message du chat par son ID (voir read_chat).",
    inputSchema: { message_id: z.string() },
    annotations: destructive,
  },
  safe(async ({ message_id }) => {
    await twitch.request("DELETE", "/moderation/chat", {
      broadcaster_id: twitch.channel.id,
      moderator_id: twitch.me.id,
      message_id,
    });
    return ok("Message supprimé.");
  }),
);

server.registerTool(
  "timeout_user",
  {
    title: "Timeout",
    description: "Exclut temporairement un utilisateur du chat.",
    inputSchema: {
      user: z.string().describe("Login de l'utilisateur"),
      duration_seconds: z.number().int().min(1).max(1_209_600).default(600),
      reason: z.string().max(500).optional(),
    },
    annotations: destructive,
  },
  safe(async ({ user, duration_seconds, reason }) => {
    await twitch.request(
      "POST",
      "/moderation/bans",
      { broadcaster_id: twitch.channel.id, moderator_id: twitch.me.id },
      { data: { user_id: await twitch.resolveId(user), duration: duration_seconds, reason } },
    );
    return ok(`${user} est exclu pour ${duration_seconds} s.`);
  }),
);

server.registerTool(
  "ban_user",
  {
    title: "Bannir",
    description: "Bannit définitivement un utilisateur du chat.",
    inputSchema: { user: z.string(), reason: z.string().max(500).optional() },
    annotations: destructive,
  },
  safe(async ({ user, reason }) => {
    await twitch.request(
      "POST",
      "/moderation/bans",
      { broadcaster_id: twitch.channel.id, moderator_id: twitch.me.id },
      { data: { user_id: await twitch.resolveId(user), reason } },
    );
    return ok(`${user} est banni.`);
  }),
);

server.registerTool(
  "unban_user",
  {
    title: "Débannir",
    description: "Lève le ban ou le timeout d'un utilisateur.",
    inputSchema: { user: z.string() },
    annotations: write,
  },
  safe(async ({ user }) => {
    await twitch.request("DELETE", "/moderation/bans", {
      broadcaster_id: twitch.channel.id,
      moderator_id: twitch.me.id,
      user_id: await twitch.resolveId(user),
    });
    return ok(`${user} n'est plus banni.`);
  }),
);

server.registerTool(
  "update_chat_settings",
  {
    title: "Réglages du chat",
    description: "Active ou désactive les modes du chat : lent, followers, abonnés, emotes, messages uniques.",
    inputSchema: {
      slow_mode: z.boolean().optional(),
      slow_mode_wait_seconds: z.number().int().min(3).max(120).optional(),
      follower_mode: z.boolean().optional(),
      follower_mode_minutes: z.number().int().min(0).max(129_600).optional(),
      subscriber_mode: z.boolean().optional(),
      emote_mode: z.boolean().optional(),
      unique_chat_mode: z.boolean().optional(),
    },
    annotations: write,
  },
  safe(async (args) => {
    const { data } = await twitch.request(
      "PATCH",
      "/chat/settings",
      { broadcaster_id: twitch.channel.id, moderator_id: twitch.me.id },
      {
        slow_mode: args.slow_mode,
        slow_mode_wait_time: args.slow_mode_wait_seconds,
        follower_mode: args.follower_mode,
        follower_mode_duration: args.follower_mode_minutes,
        subscriber_mode: args.subscriber_mode,
        emote_mode: args.emote_mode,
        unique_chat_mode: args.unique_chat_mode,
      },
    );
    return ok(data[0]);
  }),
);

server.registerTool(
  "update_stream_info",
  {
    title: "Modifier le titre ou la catégorie",
    description:
      "Change le titre et/ou la catégorie du stream. Le compte authentifié doit être le diffuseur ou un éditeur.",
    inputSchema: {
      title: z.string().max(140).optional(),
      category: z.string().optional().describe("Nom exact de la catégorie, ex. Just Chatting"),
    },
    annotations: write,
  },
  safe(async ({ title, category }) => {
    let game_id: string | undefined;
    if (category) {
      const { data } = await twitch.request("GET", "/games", { name: category });
      if (!data[0]) throw new Error(`Catégorie introuvable : ${category} (essayez search_categories)`);
      game_id = data[0].id;
    }
    if (!title && !game_id) throw new Error("Indiquez un titre ou une catégorie.");
    await twitch.request("PATCH", "/channels", { broadcaster_id: twitch.channel.id }, { title, game_id });
    return ok("Infos du stream mises à jour.");
  }),
);

async function main() {
  await twitch.init();
  listener.start();
  await server.connect(new StdioServerTransport());
  console.error(`[twitch-mcp] connecté en tant que ${twitch.me.login} sur la chaîne ${twitch.channel.login}`);
}

main().catch((err) => {
  console.error("[twitch-mcp]", err.message ?? err);
  process.exit(1);
});
