/**
 * @fileoverview Native OIDC authentication via Authorization Code flow.
 *
 * Implements OpenID Connect login against any OIDC provider (e.g., Pocket ID).
 * Activated when CODEMAN_OIDC_ISSUER and CODEMAN_OIDC_CLIENT_ID are set.
 *
 * Flow:
 * 1. Unauthenticated request → redirect to provider's authorization endpoint
 * 2. User authenticates at the provider
 * 3. Provider redirects back to /auth/callback with an authorization code
 * 4. Codeman exchanges the code for tokens, reads identity from ID token claims
 * 5. Creates a session cookie with user identity
 *
 * Coexists with Basic Auth — OIDC takes priority when configured, Basic Auth
 * remains available as fallback (e.g., API clients, localhost dev).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import type { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import { AUTH_SESSION_TTL_MS, MAX_AUTH_SESSIONS } from '../../config/auth-config.js';
import { AUTH_COOKIE_NAME } from './auth.js';

/** OIDC state stored in a cookie during the authorization flow */
interface OidcFlowState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

// Short-lived map for in-flight OIDC flows (state → flow data).
// Keyed by the `state` parameter. TTL: 5 minutes (generous for slow providers).
const pendingFlows = new Map<string, OidcFlowState>();

// Cleanup stale flows every 5 minutes
setInterval(
  () => {
    // pendingFlows is small and short-lived, no TTL tracking needed — just cap size
    if (pendingFlows.size > 100) pendingFlows.clear();
  },
  5 * 60 * 1000
).unref();

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Full callback URL (e.g., https://myapp.example.com/auth/callback) */
  callbackUrl: string;
  /** Scopes to request (default: openid profile email) */
  scopes?: string[];
}

/** Read OIDC config from environment. Returns null if not configured. */
export function getOidcConfig(): OidcConfig | null {
  const issuer = process.env.CODEMAN_OIDC_ISSUER;
  const clientId = process.env.CODEMAN_OIDC_CLIENT_ID;
  const clientSecret = process.env.CODEMAN_OIDC_CLIENT_SECRET || '';
  const callbackUrl = process.env.CODEMAN_OIDC_CALLBACK_URL || '';

  if (!issuer || !clientId) return null;

  return {
    issuer,
    clientId,
    clientSecret,
    callbackUrl,
    scopes: process.env.CODEMAN_OIDC_SCOPES?.split(',').map((s) => s.trim()) || ['openid', 'profile', 'email'],
  };
}

/**
 * Register OIDC authentication routes and middleware.
 * Returns true if OIDC is active, false if not configured.
 */
export async function registerOidcAuth(
  app: FastifyInstance,
  authSessions: StaleExpirationMap<string, AuthSessionRecord>,
  https: boolean
): Promise<boolean> {
  const cfg = getOidcConfig();
  if (!cfg) return false;

  // Discover OIDC provider configuration
  let serverConfig: oidc.Configuration;
  try {
    serverConfig = await oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret);
    console.log(`[oidc] Provider discovered: ${cfg.issuer}`);
  } catch (err) {
    console.error(`[oidc] Failed to discover provider at ${cfg.issuer}:`, err);
    return false;
  }

  // Derive callback URL if not explicitly set
  const callbackPath = '/auth/callback';
  const callbackUrl = cfg.callbackUrl || `https://localhost:3000${callbackPath}`;

  // --- Login redirect ---
  app.get('/auth/login', async (req, reply) => {
    const returnTo = (req.query as Record<string, string>).returnTo || '/';
    const state = oidc.randomState();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    pendingFlows.set(state, { state, codeVerifier, returnTo });

    const authUrl = oidc.buildAuthorizationUrl(serverConfig, {
      redirect_uri: callbackUrl,
      scope: cfg.scopes!.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    reply.redirect(authUrl.href);
  });

  // --- Callback handler ---
  app.get(callbackPath, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const state = query.state;

    if (!state || !pendingFlows.has(state)) {
      reply.code(400).send('Invalid or expired OIDC state. Please try logging in again.');
      return;
    }

    const flow = pendingFlows.get(state)!;
    pendingFlows.delete(state);

    try {
      const callbackParams = new URL(req.url, `https://${req.hostname}`);
      const tokens = await oidc.authorizationCodeGrant(serverConfig, callbackParams, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
      });

      const claims = tokens.claims();
      if (!claims) {
        reply.code(500).send('OIDC token exchange succeeded but no claims returned.');
        return;
      }

      // Extract user identity from ID token claims
      const user = (claims.preferred_username as string) || (claims.email as string) || (claims.sub as string);
      const email = (claims.email as string) || undefined;
      const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : undefined;

      // Create session
      const token = randomBytes(32).toString('hex');
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }

      authSessions.set(token, {
        ip: req.ip,
        ua: req.headers['user-agent'] ?? '',
        createdAt: Date.now(),
        method: 'oidc',
        user,
        email,
        groups,
      });

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000,
        path: '/',
      });

      reply.redirect(flow.returnTo);
    } catch (err) {
      console.error('[oidc] Token exchange failed:', err);
      reply.code(500).send('OIDC authentication failed. Please try again.');
    }
  });

  // --- Logout ---
  app.get('/auth/logout', async (req, reply) => {
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken) {
      authSessions.delete(sessionToken);
    }
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    reply.redirect('/');
  });

  // --- Auth check hook: redirect unauthenticated browser requests to /auth/login ---
  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done) => {
    // Skip auth routes themselves
    if (req.url.startsWith('/auth/')) {
      done();
      return;
    }

    // Skip hook events (localhost Claude Code hooks)
    if (req.url === '/api/hook-event' && req.method === 'POST') {
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        done();
        return;
      }
    }

    // Skip QR auth paths
    if (req.url?.startsWith('/q/')) {
      done();
      return;
    }

    // Already authenticated via session cookie
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      done();
      return;
    }

    // API requests get 401 (not a redirect)
    if (req.url.startsWith('/api/')) {
      reply.code(401).send({ error: 'Unauthorized', loginUrl: '/auth/login' });
      return;
    }

    // Static assets — don't redirect (avoids redirect loops for CSS/JS)
    if (
      req.url.match(/\.(js|css|png|ico|svg|woff2?|map|gz|br)(\?|$)/) ||
      req.url.startsWith('/favicon') ||
      req.url === '/manifest.json' ||
      req.url === '/sw.js'
    ) {
      done();
      return;
    }

    // Browser navigation — redirect to OIDC login
    const returnTo = encodeURIComponent(req.url);
    reply.redirect(`/auth/login?returnTo=${returnTo}`);
  });

  console.log(`[oidc] Native OIDC auth active (issuer: ${cfg.issuer})`);
  return true;
}
