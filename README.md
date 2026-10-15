# twitch-mcp-server

Serveur [MCP](https://modelcontextprotocol.io) qui connecte Claude à Twitch : Claude peut lire le chat et les infos du stream, consulter followers et clips, et agir comme un bot (envoyer des messages, modérer, réagir aux événements en direct reçus via EventSub).

## Outils exposés

| Outil | Rôle | Scope Twitch |
|---|---|---|
| `get_connection_status` | Compte connecté, chaîne, scopes, abonnements EventSub actifs | — |
| `get_channel_info` | Profil, titre, catégorie, langue, tags | — |
| `get_stream_status` | En direct ou non, spectateurs, heure de début | — |
| `get_followers` | Followers récents et total | `moderator:read:followers` |
| `get_chatters` | Personnes connectées au chat | `moderator:read:chatters` |
| `get_clips` | Clips d'une chaîne, filtrables par période | — |
| `read_chat` | Derniers messages du chat reçus en direct | `user:read:chat` |
| `get_recent_events` | Follows, abonnements, subs offerts, bits, raids, début/fin de stream | voir plus bas |
| `search_categories` | Recherche d'une catégorie (jeu) | — |
| `send_chat_message` | Envoyer un message (ou répondre à un message) | `user:write:chat` |
| `send_announcement` | Annonce mise en avant | `moderator:manage:announcements` |
| `create_clip` | Créer un clip du direct | `clips:edit` |
| `shoutout` | Shoutout officiel à une autre chaîne | `moderator:manage:shoutouts` |
| `delete_chat_message` | Supprimer un message | `moderator:manage:chat_messages` |
| `timeout_user` / `ban_user` / `unban_user` | Modération | `moderator:manage:banned_users` |
| `update_chat_settings` | Modes lent, followers, abonnés, emotes, messages uniques | `moderator:manage:chat_settings` |
| `update_stream_info` | Changer le titre ou la catégorie | `channel:manage:broadcast` |

Les événements en direct arrivent par EventSub WebSocket dès le démarrage du serveur et sont gardés en mémoire (500 messages de chat, 200 événements). `read_chat` et `get_recent_events` ne voient donc que ce qui s'est passé depuis le lancement. Abonnements ouverts : `channel.chat.message`, `channel.follow`, `channel.subscribe`, `channel.subscription.gift` (`channel:read:subscriptions`), `channel.cheer` (`bits:read`), `channel.raid`, `stream.online`, `stream.offline`.

## Installation

Il faut Node.js 22 ou plus récent.

```bash
git clone https://github.com/herve80100-commits/twitch-mcp-server.git
cd twitch-mcp-server
npm install
npm run build
```

### 1. Créer l'application Twitch

1. Ouvrez <https://dev.twitch.tv/console/apps> (activez la double authentification sur votre compte si Twitch la demande).
2. **Register Your Application** :
   - **Name** : ce que vous voulez, par exemple `claude-mcp-herve`.
   - **OAuth Redirect URLs** : `http://localhost:3000`
   - **Category** : `Chat Bot`.
   - **Client Type** : `Confidential`.
3. Ouvrez l'application créée, copiez le **Client ID**, puis cliquez sur **New Secret** et copiez le **Client Secret**.

### 2. Renseigner les variables

```bash
cp .env.example .env
```

Puis remplissez `.env` :

```
TWITCH_CLIENT_ID=votre_client_id
TWITCH_CLIENT_SECRET=votre_client_secret
TWITCH_CHANNEL=votre_chaine
```

### 3. Autoriser le compte

```bash
npm run auth
```

Le navigateur s'ouvre sur la page d'autorisation Twitch. Connectez-vous avec le compte qui agira dans le chat, acceptez, et les jetons sont enregistrés dans `~/.twitch-mcp/tokens.json`. Ils sont renouvelés automatiquement ensuite.

Deux choix possibles pour ce compte :
- **Votre compte de diffuseur** : tout fonctionne, les messages de Claude apparaissent sous votre nom.
- **Un compte bot dédié** : les messages apparaissent sous le nom du bot. Donnez-lui le rôle de modérateur (`/mod nomdubot` dans votre chat) pour la modération, les followers et les annonces. `update_stream_info` exige le rôle d'éditeur, et `channel.subscribe` / `channel.cheer` ne sont accessibles qu'au diffuseur lui-même.

### 4. Brancher sur Claude Desktop

Ouvrez **Claude Desktop → Paramètres → Développeur → Modifier la configuration** et ajoutez :

```json
{
  "mcpServers": {
    "twitch": {
      "command": "node",
      "args": ["/chemin/absolu/vers/twitch-mcp-server/dist/index.js"],
      "env": {
        "TWITCH_CLIENT_ID": "votre_client_id",
        "TWITCH_CLIENT_SECRET": "votre_client_secret",
        "TWITCH_CHANNEL": "votre_chaine"
      }
    }
  }
}
```

Sous Windows, le chemin s'écrit avec des doubles barres obliques inverses, par exemple `"C:\\Users\\herve\\twitch-mcp-server\\dist\\index.js"`.

Redémarrez Claude Desktop. Demandez par exemple « Est-ce que ma chaîne est en direct ? », « Résume le chat des 10 dernières minutes » ou « Remercie les derniers followers dans le chat ».

Pour Claude Code :

```bash
claude mcp add twitch -e TWITCH_CLIENT_ID=... -e TWITCH_CLIENT_SECRET=... -e TWITCH_CHANNEL=... -- node /chemin/absolu/vers/twitch-mcp-server/dist/index.js
```

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `TWITCH_CLIENT_ID` | oui | Client ID de l'application Twitch |
| `TWITCH_CLIENT_SECRET` | oui | Client Secret de l'application |
| `TWITCH_CHANNEL` | non | Chaîne ciblée ; par défaut, celle du compte autorisé |
| `TWITCH_TOKEN_FILE` | non | Fichier des jetons (défaut `~/.twitch-mcp/tokens.json`) |
| `TWITCH_AUTH_PORT` | non | Port de `npm run auth` (défaut `3000`, à refléter dans l'URL de redirection) |

## Dépannage

- **« Aucun jeton trouvé »** : lancez `npm run auth`.
- **Un outil répond 401 ou 403 « Missing scope »** : relancez `npm run auth` pour accorder les scopes ajoutés.
- **`read_chat` est vide** : appelez `get_connection_status` ; la section `eventsub.failed` indique les abonnements refusés et pourquoi.
- **« redirect_mismatch »** : l'URL de redirection de l'application Twitch doit être exactement `http://localhost:3000`.

## Licence

MIT
