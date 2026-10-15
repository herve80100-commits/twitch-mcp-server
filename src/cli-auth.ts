#!/usr/bin/env node
/**
 * Obtient un jeton utilisateur Twitch (Authorization Code Flow) :
 * ouvre la page d'autorisation, reçoit le code sur http://localhost:<port>
 * et enregistre les jetons dans TWITCH_TOKEN_FILE.
 */
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { loadConfig, SCOPES } from "./config.js";
import { exchangeCode, validate, writeTokens } from "./auth.js";

const config = loadConfig();
const redirectUri = `http://localhost:${config.authPort}`;
const state = crypto.randomBytes(16).toString("hex");

const authorizeUrl =
  "https://id.twitch.tv/oauth2/authorize?" +
  new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    force_verify: "true",
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  const code = url.searchParams.get("code");
  if (!code && !url.searchParams.get("error")) {
    res.writeHead(404).end();
    return;
  }
  const finish = (status: number, text: string) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
    server.close();
  };
  if (url.searchParams.get("state") !== state) return finish(400, "État OAuth invalide.");
  if (!code) return finish(400, `Autorisation refusée : ${url.searchParams.get("error_description")}`);
  try {
    const tokens = await exchangeCode(config, code, redirectUri);
    await writeTokens(config, tokens);
    const info = await validate(tokens.access_token);
    console.log(`Connecté en tant que ${info?.login}. Jetons enregistrés dans ${config.tokenFile}`);
    finish(200, "C'est bon ! Vous pouvez fermer cet onglet et revenir à Claude.");
  } catch (err) {
    console.error((err as Error).message);
    finish(500, (err as Error).message);
    process.exitCode = 1;
  }
});

server.listen(config.authPort, () => {
  console.log(`Ouvrez cette adresse pour autoriser l'application :\n\n${authorizeUrl}\n`);
  const opener = process.platform === "win32" ? 'start ""' : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${opener} "${authorizeUrl}"`, () => {});
});
