/**
 * @fileoverview Auth port — capabilities for authentication state.
 * Route modules that need access to auth sessions or QR rate limiting depend on this port.
 */

import type { StaleExpirationMap } from '../../utils/index.js';

/** Enhanced session record with device context for audit logging */
export interface AuthSessionRecord {
  ip: string;
  ua: string;
  createdAt: number;
  method: 'qr' | 'basic' | 'oidc';
  /** Authenticated user identity (email or username from OIDC proxy headers) */
  user?: string;
  /** User email from OIDC proxy headers */
  email?: string;
  /** User groups from OIDC proxy headers (comma-separated in header, parsed to array) */
  groups?: string[];
}

export interface AuthPort {
  readonly authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  readonly qrAuthFailures: StaleExpirationMap<string, number> | null;
  readonly https: boolean;
}
