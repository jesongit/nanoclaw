# Intent: Detect QQBot credentials in verify step

Extend `setup/verify.ts` so the health check recognizes QQBot as a
configured channel when both `QQBOT_APP_ID` and `QQBOT_APP_SECRET` are
present in the environment or `.env` file.

This change should preserve the existing checks for every other channel.
