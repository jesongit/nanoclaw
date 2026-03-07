import crypto, { KeyObject } from 'crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const QQ_ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE_URL = 'https://api.sgroup.qq.com';
const QQ_CALLBACK_ACK = { op: 12 };
const QQ_GROUP_AT_MESSAGE_EVENT = 'GROUP_AT_MESSAGE_CREATE';
const QQ_DIRECT_MESSAGE_EVENT = 'C2C_MESSAGE_CREATE';
const QQBOT_MESSAGE_DEDUP_TTL_MS = 60_000;
const QQBOT_MESSAGE_DEDUP_MAX = 1000;

interface QQAuthor {
  user_openid?: string;
  member_openid?: string;
  username?: string;
  nickname?: string;
}

interface QQAttachment {
  content_type?: string;
  filename?: string;
  url?: string;
}

interface QQMessageEvent {
  id?: string;
  content?: string;
  timestamp?: string;
  group_openid?: string;
  attachments?: QQAttachment[];
  author?: QQAuthor;
}

interface QQValidationPayload {
  op?: number;
  d?: {
    plain_token?: string;
    event_ts?: string;
  };
}

interface QQWebhookPayload {
  op?: number;
  t?: string;
  id?: string;
  d?: QQMessageEvent;
}

interface ReplyContext {
  msgId: string;
  nextSeq: number;
}

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

export interface QQBotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class QQBotChannel implements Channel {
  name = 'qqbot';

  private server: Server | null = null;
  private isListening = false;
  private readonly opts: QQBotChannelOpts;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly webhookHost: string;
  private readonly webhookPort: number;
  private readonly webhookPath: string;
  private readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private accessToken: AccessTokenState | null = null;
  private readonly replyContexts = new Map<string, ReplyContext>();
  private readonly recentInboundMessages = new Map<string, number>();

  constructor(
    appId: string,
    appSecret: string,
    opts: QQBotChannelOpts,
    webhookHost = '127.0.0.1',
    webhookPort = 8080,
    webhookPath = '/qqbot/webhook',
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.webhookHost = webhookHost;
    this.webhookPort = webhookPort;
    this.webhookPath = QQBotChannel.normalizeWebhookPath(webhookPath);

    const { publicKey, privateKey } = QQBotChannel.deriveKeyPair(appSecret);
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }

  async connect(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleWebhook(req, res).catch((err) => {
        logger.error({ err }, 'QQBot webhook handler failed');
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: 'internal error' });
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.off('error', onError);
        reject(err);
      };

      server.once('error', onError);
      server.listen(this.webhookPort, this.webhookHost, () => {
        server.off('error', onError);
        server.on('error', (err) => {
          logger.error({ err }, 'QQBot webhook server error');
        });
        this.isListening = true;
        logger.info(
          {
            host: this.webhookHost,
            port: this.webhookPort,
            path: this.webhookPath,
          },
          'QQBot webhook server listening',
        );
        console.log(
          `\n  QQBot webhook: http://${this.webhookHost}:${this.webhookPort}${this.webhookPath}\n`,
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.server || !this.isListening) {
      logger.warn('QQBot webhook server not initialized');
      return;
    }

    try {
      await this.sendPlatformMessage(jid, text);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQBot message');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.isListening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qqgrp:') || jid.startsWith('qqdm:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.server = null;
    this.isListening = false;
    this.accessToken = null;
    this.replyContexts.clear();
    this.recentInboundMessages.clear();
    logger.info('QQBot webhook server stopped');
  }

  private async handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestPath = (req.url || '').split('?')[0] || '';
    if (req.method !== 'POST' || requestPath !== this.webhookPath) {
      this.writeJson(res, 404, { error: 'not found' });
      return;
    }

    const rawBody = await this.readRawBody(req);
    let payload: QQWebhookPayload | QQValidationPayload;

    try {
      payload = JSON.parse(rawBody) as QQWebhookPayload | QQValidationPayload;
    } catch {
      this.writeJson(res, 400, { error: 'invalid json' });
      return;
    }

    const botAppId = this.firstHeader(req.headers['x-bot-appid']);
    if (botAppId && botAppId !== this.appId) {
      this.writeJson(res, 401, { error: 'invalid app id' });
      return;
    }

    if ((payload as QQValidationPayload).op === 13) {
      this.handleValidation(payload as QQValidationPayload, res);
      return;
    }

    const signature = this.firstHeader(req.headers['x-signature-ed25519']);
    const timestamp = this.firstHeader(req.headers['x-signature-timestamp']);
    if (!signature || !timestamp) {
      this.writeJson(res, 401, { error: 'missing signature' });
      return;
    }

    if (!this.verifySignature(timestamp, rawBody, signature)) {
      this.writeJson(res, 401, { error: 'invalid signature' });
      return;
    }

    await this.handleEvent(payload as QQWebhookPayload);
    this.writeJson(res, 200, QQ_CALLBACK_ACK);
  }

  private handleValidation(
    payload: QQValidationPayload,
    res: ServerResponse,
  ): void {
    const plainToken = payload.d?.plain_token || '';
    const eventTs = payload.d?.event_ts || '';

    if (!plainToken || !eventTs) {
      this.writeJson(res, 400, { error: 'invalid validation payload' });
      return;
    }

    const signature = crypto
      .sign(
        null,
        Buffer.from(`${eventTs}${plainToken}`, 'utf-8'),
        this.privateKey,
      )
      .toString('hex');

    this.writeJson(res, 200, {
      plain_token: plainToken,
      signature,
    });
  }

  private async handleEvent(payload: QQWebhookPayload): Promise<void> {
    const event = payload.d;
    if (!event) return;

    if (payload.t === QQ_GROUP_AT_MESSAGE_EVENT) {
      await this.handleInboundMessage(event, true, payload.t || '');
      return;
    }

    if (payload.t === QQ_DIRECT_MESSAGE_EVENT) {
      await this.handleInboundMessage(event, false, payload.t || '');
      return;
    }
  }

  private async handleInboundMessage(
    event: QQMessageEvent,
    isGroup: boolean,
    eventType: string,
  ): Promise<void> {
    const msgId = event.id || '';
    const timestamp = event.timestamp || new Date().toISOString();
    const author = event.author || {};
    const sender = isGroup
      ? author.member_openid || author.user_openid || ''
      : author.user_openid || author.member_openid || '';
    const senderName =
      author.username || author.nickname || sender || 'Unknown User';
    const chatId = isGroup ? event.group_openid || '' : author.user_openid || '';

    if (!msgId || !chatId) {
      logger.warn({ eventType, msgId, chatId }, 'QQBot event missing identifiers');
      return;
    }

    const chatJid = isGroup ? `qqgrp:${chatId}` : `qqdm:${chatId}`;
    const chatName = isGroup ? `QQ Group ${chatId}` : senderName;
    const rawContent = this.formatMessageContent(event.content || '', event.attachments);
    const normalizedMessage = isGroup
      ? {
          content: this.ensureAssistantTrigger(rawContent),
          commandContent: rawContent.trim(),
        }
      : {
          content: rawContent,
          commandContent: rawContent.trim(),
        };

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'qqbot', isGroup);

    if (this.isDuplicateInboundMessage(chatJid, msgId)) {
      logger.debug({ chatJid, msgId, eventType }, 'Ignoring duplicate QQBot message');
      return;
    }

    this.replyContexts.set(chatJid, { msgId, nextSeq: 1 });

    if (/\/chatid\b/i.test(normalizedMessage.commandContent)) {
      await this.sendPlatformMessage(
        chatJid,
        `Chat ID: \`${chatJid}\`\nName: ${chatName}\nType: ${isGroup ? 'group' : 'private'}`,
      );
      return;
    }

    if (/\/ping\b/i.test(normalizedMessage.commandContent)) {
      await this.sendPlatformMessage(chatJid, `${ASSISTANT_NAME} is online.`);
      return;
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered QQBot chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: normalizedMessage.content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'QQBot message stored',
    );
  }

  private ensureAssistantTrigger(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) return `@${ASSISTANT_NAME}`;
    if (TRIGGER_PATTERN.test(trimmed)) return trimmed;
    return `@${ASSISTANT_NAME} ${trimmed}`;
  }

  private isDuplicateInboundMessage(chatJid: string, msgId: string): boolean {
    const now = Date.now();
    this.pruneRecentInboundMessages(now);
    const key = `${chatJid}:${msgId}`;
    if (this.recentInboundMessages.has(key)) {
      return true;
    }
    this.recentInboundMessages.set(key, now + QQBOT_MESSAGE_DEDUP_TTL_MS);
    if (this.recentInboundMessages.size > QQBOT_MESSAGE_DEDUP_MAX) {
      const oldestKey = this.recentInboundMessages.keys().next().value as
        | string
        | undefined;
      if (oldestKey) {
        this.recentInboundMessages.delete(oldestKey);
      }
    }
    return false;
  }

  private pruneRecentInboundMessages(now: number): void {
    for (const [key, expiresAt] of this.recentInboundMessages.entries()) {
      if (expiresAt > now) {
        continue;
      }
      this.recentInboundMessages.delete(key);
    }
  }

  private formatMessageContent(
    content: string,
    attachments: QQAttachment[] = [],
  ): string {
    const placeholders = attachments
      .map((attachment) => this.formatAttachment(attachment))
      .filter(Boolean);

    if (placeholders.length === 0) {
      return content;
    }

    if (content) {
      return `${content}\n${placeholders.join('\n')}`;
    }

    return placeholders.join('\n');
  }

  private formatAttachment(attachment: QQAttachment): string {
    const contentType = (attachment.content_type || '').toLowerCase();
    const filename = attachment.filename || attachment.url || 'attachment';

    if (contentType.startsWith('image/')) {
      return `[Image: ${filename}]`;
    }
    if (contentType.startsWith('video/')) {
      return `[Video: ${filename}]`;
    }
    if (contentType.startsWith('audio/')) {
      return `[Audio: ${filename}]`;
    }
    return `[Attachment: ${filename}]`;
  }

  private async sendPlatformMessage(jid: string, text: string): Promise<void> {
    const context = this.replyContexts.get(jid);
    if (!context) {
      logger.warn({ jid }, 'No QQBot reply context for chat');
      return;
    }

    const accessToken = await this.getAccessToken();
    const nextSeq = context.nextSeq;
    context.nextSeq += 1;

    let url: string;
    if (jid.startsWith('qqgrp:')) {
      url = `${QQ_API_BASE_URL}/v2/groups/${jid.slice('qqgrp:'.length)}/messages`;
    } else if (jid.startsWith('qqdm:')) {
      url = `${QQ_API_BASE_URL}/v2/users/${jid.slice('qqdm:'.length)}/messages`;
    } else {
      logger.warn({ jid }, 'Unsupported QQBot JID');
      return;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: text,
        msg_type: 0,
        msg_id: context.msgId,
        msg_seq: nextSeq,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QQBot API ${response.status}: ${errorText}`);
    }

    logger.info({ jid, length: text.length, msgSeq: nextSeq }, 'QQBot message sent');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }

    const response = await fetch(QQ_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`QQBot token API ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token || !data.expires_in) {
      throw new Error('QQBot token response missing access_token or expires_in');
    }

    this.accessToken = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
    };

    return this.accessToken.token;
  }

  private verifySignature(
    timestamp: string,
    rawBody: string,
    signatureHex: string,
  ): boolean {
    try {
      const signature = Buffer.from(signatureHex, 'hex');
      return crypto.verify(
        null,
        Buffer.from(`${timestamp}${rawBody}`, 'utf-8'),
        this.publicKey,
        signature,
      );
    } catch {
      return false;
    }
  }

  private async readRawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      req.on('error', reject);
    });
  }

  private writeJson(
    res: ServerResponse,
    statusCode: number,
    body: Record<string, unknown>,
  ): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private firstHeader(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] || '';
    return value || '';
  }

  private static normalizeWebhookPath(webhookPath: string): string {
    if (!webhookPath) return '/qqbot/webhook';
    const withLeadingSlash = webhookPath.startsWith('/')
      ? webhookPath
      : `/${webhookPath}`;
    return withLeadingSlash.replace(/\/+$/, '') || '/qqbot/webhook';
  }

  private static deriveKeyPair(appSecret: string): {
    publicKey: KeyObject;
    privateKey: KeyObject;
  } {
    const secretBytes = Buffer.from(appSecret, 'utf-8');
    const seed = Buffer.alloc(32);
    for (let i = 0; i < seed.length; i += 1) {
      seed[i] = secretBytes[i % secretBytes.length] || 0;
    }

    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey(privateKey);

    return { publicKey, privateKey };
  }
}

registerChannel('qqbot', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'QQBOT_APP_ID',
    'QQBOT_APP_SECRET',
    'QQBOT_WEBHOOK_HOST',
    'QQBOT_WEBHOOK_PORT',
    'QQBOT_WEBHOOK_PATH',
  ]);

  const appId = process.env.QQBOT_APP_ID || envVars.QQBOT_APP_ID || '';
  const appSecret =
    process.env.QQBOT_APP_SECRET || envVars.QQBOT_APP_SECRET || '';
  const webhookHost =
    process.env.QQBOT_WEBHOOK_HOST || envVars.QQBOT_WEBHOOK_HOST || '127.0.0.1';
  const webhookPath =
    process.env.QQBOT_WEBHOOK_PATH || envVars.QQBOT_WEBHOOK_PATH || '/qqbot/webhook';
  const webhookPortRaw =
    process.env.QQBOT_WEBHOOK_PORT || envVars.QQBOT_WEBHOOK_PORT || '8080';
  const webhookPort = Number.parseInt(webhookPortRaw, 10);

  if (!appId || !appSecret) {
    logger.warn('QQBot: QQBOT_APP_ID or QQBOT_APP_SECRET not set');
    return null;
  }

  if (!Number.isInteger(webhookPort) || webhookPort <= 0 || webhookPort > 65535) {
    logger.warn({ webhookPortRaw }, 'QQBot: invalid QQBOT_WEBHOOK_PORT');
    return null;
  }

  const qqOpts: QQBotChannelOpts = {
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
  };

  return new QQBotChannel(
    appId,
    appSecret,
    qqOpts,
    webhookHost,
    webhookPort,
    webhookPath,
  );
});
