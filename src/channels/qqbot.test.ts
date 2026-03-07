import crypto from 'crypto';
import { request } from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readEnvFile } from '../env.js';
import { registerChannel } from './registry.js';
import { QQBotChannel, type QQBotChannelOpts } from './qqbot.js';

const originalFetch = globalThis.fetch;
const registerChannelMock = vi.mocked(registerChannel);
const readEnvFileMock = vi.mocked(readEnvFile);
const qqbotFactory = registerChannelMock.mock.calls[0]?.[1];

function createTestOpts(
  overrides?: Partial<QQBotChannelOpts>,
): QQBotChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'qqgrp:group_001': {
        name: 'QQ Group',
        folder: 'qq-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'qqdm:user_001': {
        name: 'QQ DM',
        folder: 'qq-dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function deriveKeyPair(appSecret: string) {
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

function signedHeaders(
  appSecret: string,
  body: string,
  timestamp = '1704067200',
) {
  const { privateKey } = deriveKeyPair(appSecret);
  const signature = crypto
    .sign(null, Buffer.from(`${timestamp}${body}`, 'utf-8'), privateKey)
    .toString('hex');

  return {
    'x-signature-ed25519': signature,
    'x-signature-timestamp': timestamp,
  };
}

async function postWebhook(
  channel: QQBotChannel,
  payload: unknown,
  headers: Record<string, string> = {},
  path = '/qqbot/webhook',
): Promise<{ statusCode: number; body: string }> {
  const server = (channel as any).server;
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function createGroupAtEvent(overrides?: Record<string, unknown>) {
  return {
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'msg_group_001',
      content: '你好',
      timestamp: '2024-01-01T00:00:00.000Z',
      group_openid: 'group_001',
      attachments: [],
      author: {
        user_openid: 'user_001',
        member_openid: 'member_001',
        username: 'Alice',
      },
      ...overrides,
    },
  };
}

function createDmEvent(overrides?: Record<string, unknown>) {
  return {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'msg_dm_001',
      content: '你好',
      timestamp: '2024-01-01T00:00:00.000Z',
      attachments: [],
      author: {
        user_openid: 'user_001',
        member_openid: 'member_001',
        username: 'Alice',
      },
      ...overrides,
    },
  };
}

describe('QQBotChannel', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = originalFetch;
    delete process.env.QQBOT_APP_ID;
    delete process.env.QQBOT_APP_SECRET;
    delete process.env.QQBOT_WEBHOOK_HOST;
    delete process.env.QQBOT_WEBHOOK_PORT;
    delete process.env.QQBOT_WEBHOOK_PATH;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  describe('factory', () => {
    it('self-registers qqbot factory', () => {
      expect(registerChannelMock).toHaveBeenCalledWith(
        'qqbot',
        expect.any(Function),
      );
      expect(qqbotFactory).toBeTypeOf('function');
    });

    it('returns null when credentials are missing', () => {
      const instance = qqbotFactory!(createTestOpts() as any);
      expect(instance).toBeNull();
    });

    it('returns null when webhook port is invalid', () => {
      readEnvFileMock.mockReturnValue({
        QQBOT_APP_ID: 'app_123',
        QQBOT_APP_SECRET: 'secret_123',
        QQBOT_WEBHOOK_PORT: '70000',
      });

      const instance = qqbotFactory!(createTestOpts() as any);
      expect(instance).toBeNull();
    });

    it('creates channel when credentials are configured', () => {
      readEnvFileMock.mockReturnValue({
        QQBOT_APP_ID: 'app_123',
        QQBOT_APP_SECRET: 'secret_123',
        QQBOT_WEBHOOK_HOST: '127.0.0.1',
        QQBOT_WEBHOOK_PORT: '8080',
        QQBOT_WEBHOOK_PATH: '/qqbot/webhook',
      });

      const instance = qqbotFactory!(createTestOpts() as any);
      expect(instance).toBeInstanceOf(QQBotChannel);
    });
  });

  describe('connection lifecycle', () => {
    it('connects and disconnects cleanly', async () => {
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
        '127.0.0.1',
        0,
      );

      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('webhook handling', () => {
    it('responds to callback validation', async () => {
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const response = await postWebhook(channel, {
        op: 13,
        d: {
          plain_token: 'plain-token',
          event_ts: '1704067200',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        plain_token: 'plain-token',
        signature: expect.any(String),
      });

      await channel.disconnect();
    });

    it('rejects signed events with invalid signature', async () => {
      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createGroupAtEvent();
      const body = JSON.stringify(payload);
      const response = await postWebhook(channel, payload, {
        'x-signature-ed25519': 'not-a-valid-signature',
        'x-signature-timestamp': '1704067200',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid signature' });
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(body).toContain('GROUP_AT_MESSAGE_CREATE');

      await channel.disconnect();
    });

    it('stores metadata and message for @ group chat', async () => {
      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createGroupAtEvent();
      const body = JSON.stringify(payload);
      const response = await postWebhook(
        channel,
        payload,
        signedHeaders('secret_123', body),
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ op: 12 });
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qqgrp:group_001',
        '2024-01-01T00:00:00.000Z',
        'QQ Group group_001',
        'qqbot',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qqgrp:group_001',
        expect.objectContaining({
          id: 'msg_group_001',
          chat_jid: 'qqgrp:group_001',
          sender: 'member_001',
          sender_name: 'Alice',
          content: '@Andy 你好',
          is_from_me: false,
        }),
      );

      await channel.disconnect();
    });

    it('only handles @ group messages and ignores unrelated group event types', async () => {
      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = {
        op: 0,
        t: 'GROUP_MESSAGE_CREATE',
        d: {
          id: 'msg_group_ordinary_001',
          content: '你好',
          timestamp: '2024-01-01T00:00:00.000Z',
          group_openid: 'group_001',
          attachments: [],
          author: {
            user_openid: 'user_001',
            member_openid: 'member_001',
            username: 'Alice',
          },
        },
      };
      const body = JSON.stringify(payload);
      const response = await postWebhook(
        channel,
        payload,
        signedHeaders('secret_123', body),
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ op: 12 });
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('only stores metadata for unregistered chats', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createGroupAtEvent({ group_openid: 'group_unknown' });
      const body = JSON.stringify(payload);
      await postWebhook(channel, payload, signedHeaders('secret_123', body));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qqgrp:group_unknown',
        '2024-01-01T00:00:00.000Z',
        'QQ Group group_unknown',
        'qqbot',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('stores direct messages without prepending trigger', async () => {
      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createDmEvent();
      const body = JSON.stringify(payload);
      await postWebhook(channel, payload, signedHeaders('secret_123', body));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qqdm:user_001',
        '2024-01-01T00:00:00.000Z',
        'Alice',
        'qqbot',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qqdm:user_001',
        expect.objectContaining({ content: '你好' }),
      );

      await channel.disconnect();
    });

    it('normalizes inbound timestamps to UTC ISO format', async () => {
      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createDmEvent({ timestamp: '2026-03-07T09:00:00+08:00' });
      const body = JSON.stringify(payload);
      await postWebhook(channel, payload, signedHeaders('secret_123', body));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qqdm:user_001',
        '2026-03-07T01:00:00.000Z',
        'Alice',
        'qqbot',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qqdm:user_001',
        expect.objectContaining({ timestamp: '2026-03-07T01:00:00.000Z' }),
      );

      await channel.disconnect();
    });
  });

  describe('bot commands and outbound replies', () => {
    it('replies to /chatid through QQ OpenAPI', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access_123', expires_in: 7200 }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
        });

      const opts = createTestOpts();
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        opts,
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createGroupAtEvent({ content: '/chatid' });
      const body = JSON.stringify(payload);
      const response = await postWebhook(
        channel,
        payload,
        signedHeaders('secret_123', body),
      );

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://bots.qq.com/app/getAppAccessToken',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.sgroup.qq.com/v2/groups/group_001/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'QQBot access_123',
          }),
          body: expect.stringContaining('Chat ID: `qqgrp:group_001`'),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('replies to /ping in private chat', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access_123', expires_in: 7200 }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
        });

      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createDmEvent({ content: '/ping' });
      const body = JSON.stringify(payload);
      await postWebhook(channel, payload, signedHeaders('secret_123', body));

      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.sgroup.qq.com/v2/users/user_001/messages',
        expect.objectContaining({
          body: expect.stringContaining('Andy is online.'),
        }),
      );

      await channel.disconnect();
    });

    it('deduplicates duplicate /ping events with same msg id', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access_123', expires_in: 7200 }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
        });

      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const payload = createGroupAtEvent({ id: 'dup_ping', content: '/ping' });
      const body = JSON.stringify(payload);
      await postWebhook(channel, payload, signedHeaders('secret_123', body));
      await postWebhook(channel, payload, signedHeaders('secret_123', body));

      expect(fetchMock).toHaveBeenCalledTimes(2);

      await channel.disconnect();
    });

    it('routes sendMessage to group and private APIs after inbound context exists', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access_123', expires_in: 7200 }),
          text: async () => '',
        })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
        '127.0.0.1',
        0,
      );
      await channel.connect();

      const groupPayload = createGroupAtEvent({
        content: 'first group message',
      });
      const dmPayload = createDmEvent({ content: 'first dm message' });
      const groupBody = JSON.stringify(groupPayload);
      const dmBody = JSON.stringify(dmPayload);
      await postWebhook(
        channel,
        groupPayload,
        signedHeaders('secret_123', groupBody),
      );
      await postWebhook(
        channel,
        dmPayload,
        signedHeaders('secret_123', dmBody),
      );

      await channel.sendMessage('qqgrp:group_001', 'group reply');
      await channel.sendMessage('qqdm:user_001', 'dm reply');

      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.sgroup.qq.com/v2/groups/group_001/messages',
        expect.objectContaining({
          body: expect.stringContaining('group reply'),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        'https://api.sgroup.qq.com/v2/users/user_001/messages',
        expect.objectContaining({ body: expect.stringContaining('dm reply') }),
      );

      await channel.disconnect();
    });
  });

  describe('ownsJid', () => {
    it('owns qq group and dm JIDs only', () => {
      const channel = new QQBotChannel(
        'app_123',
        'secret_123',
        createTestOpts(),
      );
      expect(channel.ownsJid('qqgrp:group_001')).toBe(true);
      expect(channel.ownsJid('qqdm:user_001')).toBe(true);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('qqg:channel_001')).toBe(false);
    });
  });
});
