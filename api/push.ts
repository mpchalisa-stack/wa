import type { IncomingMessage, ServerResponse } from 'node:http';
import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

interface VercelResponse extends ServerResponse {
  status?: (code: number) => VercelResponse;
  json?: (payload: unknown) => VercelResponse;
}

const ALLOWED_PUSH_TYPES = new Set(['message', 'call']);
const MAX_TOKEN_LENGTH = 4096;
const MIN_TOKEN_LENGTH = 10;
const MAX_SENDER_LENGTH = 120;
const MAX_BODY_LENGTH = 500;

function sendJson(res: VercelResponse, statusCode: number, payload: Record<string, unknown>): void {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    const statusRes = res.status(statusCode);
    if (typeof statusRes.json === 'function') {
      statusRes.json(payload);
      return;
    }
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function getFirebaseAdminApp(): App {
  if (getApps().length > 0) {
    return getApp();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FCM_ADMIN_NOT_CONFIGURED');
  }

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

async function parseJsonBody(req: VercelRequest): Promise<Record<string, unknown> | null> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_PAYLOAD_BYTES = 16 * 1024;

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes <= MAX_PAYLOAD_BYTES) {
        chunks.push(buf);
      }
    });
    req.on('end', () => {
      if (totalBytes === 0 || totalBytes > MAX_PAYLOAD_BYTES) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        );
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { success: false, ok: false, error: 'Method Not Allowed' });
    return;
  }

  const payload = await parseJsonBody(req);
  if (!payload) {
    sendJson(res, 400, { success: false, ok: false, error: 'Invalid JSON request body' });
    return;
  }

  const rawToken = typeof payload.targetToken === 'string' ? payload.targetToken.trim() : '';
  const rawType = typeof payload.type === 'string' ? payload.type.trim() : '';
  const rawSender = typeof payload.sender === 'string' ? payload.sender.trim() : '';
  const rawBody = typeof payload.body === 'string' ? payload.body.trim() : '';

  if (
    !rawToken ||
    rawToken.length < MIN_TOKEN_LENGTH ||
    rawToken.length > MAX_TOKEN_LENGTH ||
    /\s/.test(rawToken)
  ) {
    sendJson(res, 400, { success: false, ok: false, error: 'Invalid targetToken' });
    return;
  }

  if (!ALLOWED_PUSH_TYPES.has(rawType)) {
    sendJson(res, 400, { success: false, ok: false, error: 'Invalid push type' });
    return;
  }

  if (!rawSender || !rawBody) {
    sendJson(res, 400, { success: false, ok: false, error: 'Missing sender or body' });
    return;
  }

  const safeSender = rawSender.slice(0, MAX_SENDER_LENGTH);
  const safeBody = rawBody.slice(0, MAX_BODY_LENGTH);

  try {
    const adminApp = getFirebaseAdminApp();
    const messageId = await getMessaging(adminApp).send({
      token: rawToken,
      android: {
        priority: 'high',
        ttl: 0,
      },
      data: {
        type: String(rawType),
        sender: String(safeSender),
        body: String(safeBody),
      },
    });

    sendJson(res, 200, { success: true, ok: true, messageId });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'FCM_ADMIN_NOT_CONFIGURED') {
      sendJson(res, 503, {
        success: false,
        ok: false,
        code: 'FCM_ADMIN_NOT_CONFIGURED',
        error: 'Push service is not configured on server',
      });
      return;
    }

    const fcmCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';

    if (
      fcmCode === 'messaging/registration-token-not-registered' ||
      fcmCode === 'messaging/invalid-registration-token'
    ) {
      sendJson(res, 410, {
        success: false,
        ok: false,
        code: fcmCode,
        error: 'Target token is no longer valid',
      });
      return;
    }

    sendJson(res, 502, {
      success: false,
      ok: false,
      code: fcmCode || 'FCM_SEND_FAILED',
      error: 'Failed to deliver FCM push message',
    });
  }
}
