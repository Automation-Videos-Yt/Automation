import { Router } from "express";
import {
  disconnect,
  oauthCallback,
  oauthStatus,
  startOAuth,
} from "../controllers/youtube.controller";

export const youtubeRouter = Router();

youtubeRouter.get("/youtube", startOAuth);
youtubeRouter.get("/youtube/callback", oauthCallback);
youtubeRouter.get("/youtube/status", oauthStatus);
youtubeRouter.post("/youtube/disconnect", disconnect);
