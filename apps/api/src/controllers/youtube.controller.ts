import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { google } from "googleapis";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { buildAuthUrl, oauthClient } from "../integrations/youtube/oauth";
import { scoped } from "../lib/logger";
import { encryptSecret } from "../lib/secret-crypto";

const log = scoped("yt-oauth");

// In-memory state store for CSRF protection on the OAuth callback.
// MVP-grade — good enough for single-user self-hosted usage.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function cleanupStates() {
  const now = Date.now();
  for (const [k, ts] of pendingStates) {
    if (now - ts > STATE_TTL_MS) pendingStates.delete(k);
  }
}

export async function startOAuth(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    cleanupStates();
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());
    const url = buildAuthUrl(state);
    log.info("redirecting to google consent");
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

export async function oauthCallback(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const errorQ = typeof req.query.error === "string" ? req.query.error : "";

    if (errorQ) {
      log.warn({ errorQ }, "oauth denied");
      res.redirect(`${env.WEB_BASE_URL}/?youtube=denied`);
      return;
    }
    if (!code || !state || !pendingStates.has(state)) {
      log.warn({ hasCode: !!code, hasState: !!state }, "oauth bad callback");
      res.status(400).send("Invalid OAuth callback");
      return;
    }
    pendingStates.delete(state);

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      log.warn({ hasAccess: !!tokens.access_token, hasRefresh: !!tokens.refresh_token }, "incomplete tokens");
      res.status(400).send(
        "Google returned no refresh_token. Disconnect this app at https://myaccount.google.com/permissions and try again."
      );
      return;
    }
    client.setCredentials(tokens);

    // Fetch channel info for display.
    const youtube = google.youtube({ version: "v3", auth: client });
    const channelRes = await youtube.channels.list({
      mine: true,
      part: ["id", "snippet"],
    });
    const channel = channelRes.data.items?.[0];
    const channelId = channel?.id ?? null;
    const channelTitle = channel?.snippet?.title ?? null;

    const expiresAt = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 55 * 60 * 1000);

    await prisma.youTubeAccount.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        channelId,
        channelTitle,
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        scope: tokens.scope ?? "",
        tokenExpiresAt: expiresAt,
      },
      update: {
        channelId,
        channelTitle,
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        scope: tokens.scope ?? "",
        tokenExpiresAt: expiresAt,
      },
    });

    log.info({ channelId, channelTitle }, "youtube connected");
    res.redirect(`${env.WEB_BASE_URL}/?youtube=connected`);
  } catch (err) {
    next(err);
  }
}

export async function oauthStatus(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const acct = await prisma.youTubeAccount.findUnique({
      where: { id: "default" },
    });
    if (!acct) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: true,
      channelId: acct.channelId,
      channelTitle: acct.channelTitle,
      scope: acct.scope,
      tokenExpiresAt: acct.tokenExpiresAt,
    });
  } catch (err) {
    next(err);
  }
}

export async function disconnect(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    await prisma.youTubeAccount.deleteMany({ where: { id: "default" } });
    log.info("youtube disconnected");
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
}
