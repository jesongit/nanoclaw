---
name: add-qqbot
description: Add QQ Bot API v2 as a channel. First version focuses on group @mentions and direct chats using webhook callbacks.
---

# Add QQBot Channel

This skill adds QQ Bot API v2 support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

Current scope of this skill:
- Supports **群聊 @机器人消息** via `GROUP_AT_MESSAGE_CREATE`
- Supports **QQ 私聊消息** via `C2C_MESSAGE_CREATE`
- Uses **Webhook 入站 + OpenAPI 出站**
- **暂不包含频道 / Guild**

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `qqbot` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a QQ Bot App ID and App Secret, or do you need to create them?

If they have them, collect them now. If not, walk them through Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-qqbot
```

This deterministically:
- Adds `src/channels/qqbot.ts` (QQBot webhook channel with self-registration)
- Adds `src/channels/qqbot.test.ts` (unit tests)
- Appends `import './qqbot.js'` to `src/channels/index.ts`
- Extends `setup/verify.ts` so QQBot credentials are detected
- Updates `.env.example` with QQBot environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/index.ts.intent.md`
- `modify/setup/verify.ts.intent.md`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create QQ Bot credentials (if needed)

If the user does not already have a QQ Bot application, tell them:

> I need you to create a QQ bot application in the QQ 机器人开放平台:
>
> 1. Open the QQ Bot developer console
> 2. Create or select your bot application
> 3. Copy the **AppID** and **AppSecret / Bot Secret**
> 4. In event subscriptions, enable the **群聊 + 单聊** event set
> 5. Prefer the official **Webhook** callback mode instead of the legacy WebSocket gateway

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
QQBOT_APP_ID=<your-app-id>
QQBOT_APP_SECRET=<your-app-secret>
QQBOT_WEBHOOK_HOST=127.0.0.1
QQBOT_WEBHOOK_PORT=8080
QQBOT_WEBHOOK_PATH=/qqbot/webhook
```

Notes:
- `QQBOT_WEBHOOK_HOST=127.0.0.1` is recommended when you put NanoClaw behind Nginx/Caddy/Traefik.
- If you need NanoClaw to listen directly on the network, set `QQBOT_WEBHOOK_HOST=0.0.0.0`.
- The skill uses QQ official `Webhook` callbacks for inbound messages and QQ OpenAPI for replies.

Sync to the runtime environment if your install expects `data/env/env`:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Expose the webhook publicly

QQ requires a public callback URL. NanoClaw listens locally at:

```text
http://<QQBOT_WEBHOOK_HOST>:<QQBOT_WEBHOOK_PORT><QQBOT_WEBHOOK_PATH>
```

Expose that local listener through a public HTTPS endpoint with a reverse proxy.

Example public callback URL:

```text
https://your-domain.example/qqbot/webhook
```

Important:
- Do not rewrite the request body before it reaches NanoClaw
- Preserve the original raw body and QQ signature headers
- The callback validation (`op=13`) is handled automatically by the channel

### Configure webhook in QQ console

In the QQ Bot console:

1. Set the callback URL to your public HTTPS endpoint
2. Keep the path aligned with `QQBOT_WEBHOOK_PATH`
3. Enable the **群聊 + 单聊** events
4. Save and complete the callback verification

## Phase 4: Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl restart nanoclaw
```

## Phase 5: Registration

### Get Chat ID

Tell the user:

> To get the QQ registration ID:
>
> - Private chat: send `/chatid` directly to the bot
> - Group chat: **@ the bot** and send `/chatid`
>
> The bot will reply with a JID like:
> - `qqdm:<openid>` for private chats
> - `qqgrp:<group_openid>` for group chats

Wait for the user to provide the JID.

### Register the chat

Use the IPC register flow or register directly.

Private chat as main chat:

```typescript
registerGroup("qqdm:<openid>", {
  name: "QQ DM",
  folder: "qqbot_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

Group chat as trigger-only chat:

```typescript
registerGroup("qqgrp:<group_openid>", {
  name: "QQ Group",
  folder: "qq_group",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

Notes:
- QQ 群聊通过 `GROUP_AT_MESSAGE_CREATE` 的 @机器人消息触发
- QQ 私聊消息直接入站，不需要额外前缀

## Phase 6: Verify

Tell the user:

> Test the bot:
>
> - Private chat: send a normal message or `/ping`
> - Group chat: @ the bot and send `/ping` or `你好`
>
> The bot should reply within a few seconds.

If needed, check logs:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Callback validation fails

Check:
1. The public URL maps to `QQBOT_WEBHOOK_PATH`
2. Your reverse proxy forwards the raw request body unchanged
3. Signature headers reach NanoClaw unchanged
4. `QQBOT_APP_ID` and `QQBOT_APP_SECRET` are correct

### Bot receives private messages but not group messages

Check that:
1. The QQ console enabled the 群聊事件 set
2. The group message actually **@mentions the bot**
3. The callback URL is verified and active

### Bot cannot reply

Current QQBot integration replies using the latest inbound QQ message context (`msg_id`). If there has been no recent inbound message for that chat, NanoClaw may not be able to send a proactive message.

## After Setup

This first version supports:
- Webhook callback validation (`op=13`)
- QQ signature verification
- `GROUP_AT_MESSAGE_CREATE` and `C2C_MESSAGE_CREATE`
- `/chatid` and `/ping`
- Attachment placeholders
- QQ group @mention -> NanoClaw trigger normalization

Not included yet:
- Channel / Guild support
- Guaranteed proactive sending without recent inbound context
