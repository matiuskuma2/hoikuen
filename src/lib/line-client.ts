/**
 * LINE Messaging API Client for Cloudflare Workers
 * 
 * Node.js SDKはCloudflare Workers上で動作しない可能性があるため、
 * Web Crypto API + fetch による直接HTTPコールで実装。
 * 署名検証は HMAC-SHA256 (Web Crypto) を使用。
 */

const LINE_API_BASE = 'https://api.line.me/v2/bot';

// ============================================================
// 署名検証 (HMAC-SHA256 via Web Crypto API)
// ============================================================

/**
 * LINE Webhookリクエストの署名を検証する。
 * @param body      - リクエストボディ (raw string)
 * @param signature - X-Line-Signature ヘッダー値
 * @param secret    - Channel Secret
 * @returns true if valid
 */
export async function verifySignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return expected === signature;
}

// ============================================================
// Reply / Push メッセージ送信
// ============================================================

interface LineMessage {
  type: string;
  text?: string;
  [key: string]: unknown;
}

async function callLineApi(
  path: string,
  channelAccessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${LINE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * replyToken を使って即時返信する。
 */
export async function replyMessage(
  replyToken: string,
  messages: LineMessage[],
  channelAccessToken: string,
): Promise<Response> {
  return callLineApi('/message/reply', channelAccessToken, {
    replyToken,
    messages,
  });
}

/**
 * userId を指定してプッシュ送信する。
 */
export async function pushMessage(
  to: string,
  messages: LineMessage[],
  channelAccessToken: string,
): Promise<Response> {
  return callLineApi('/message/push', channelAccessToken, {
    to,
    messages,
  });
}

// ============================================================
// プロフィール取得
// ============================================================

export interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export async function getProfile(
  userId: string,
  channelAccessToken: string,
): Promise<LineProfile | null> {
  const res = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<LineProfile>;
}

// ============================================================
// LINE Event 型定義 (最低限の webhook event types)
// ============================================================

export interface LineEvent {
  type: 'message' | 'follow' | 'unfollow' | 'postback' | 'join' | 'leave';
  timestamp: number;
  source: {
    type: 'user' | 'group' | 'room';
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  replyToken?: string;
  message?: {
    id: string;
    type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'sticker';
    text?: string;
  };
  postback?: {
    data: string;
    params?: Record<string, string>;
  };
}

export interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}
