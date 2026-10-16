/**
 * Azure AD OAuth2 PKCE Authentication for Chrome MV3 Extensions.
 *
 * Provides secure token-based authentication to Azure Cognitive Services
 * without storing long-lived API keys. Uses chrome.identity.launchWebAuthFlow()
 * for the authorization flow and chrome.storage.session for token storage
 * (memory-only, cleared on browser close).
 *
 * Requires:
 *   - "identity" permission in manifest.json
 *   - Azure AD App Registration with redirect URI: chrome.identity.getRedirectURL()
 *   - API permission: Azure Cognitive Services > user_impersonation
 *   - Public client flow enabled in the App Registration
 *
 * Usage:
 *   const userInfo = await LLSS_AzureAuth.signIn(tenantId, clientId);
 *   const token = await LLSS_AzureAuth.getAccessToken(tenantId, clientId);
 *   await LLSS_AzureAuth.signOut();
 */

(function () {
  'use strict';

  const SESSION_KEY = 'llss_azure_oauth';
  const ALARM_NAME = 'llss-azure-token-refresh';
  const SCOPE = 'https://cognitiveservices.azure.com/.default offline_access openid profile';
  const STORAGE_SCOPE = 'https://storage.azure.com/.default';
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // ── PKCE helpers ──────────────────────────────────────────────────────────

  function generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
  }

  async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function base64UrlEncode(buffer) {
    let str = '';
    for (const byte of buffer) str += String.fromCharCode(byte);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── Token storage (chrome.storage.session — memory only) ──────────────────

  function secureFetch(url, init = {}) {
    return fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  }

  async function storeTokens(tokenResponse, tenantId, clientId, scope = SCOPE, previous = null) {
    const expiresIn = Number(tokenResponse.expires_in);
    const accessToken = tokenResponse.access_token;
    const refreshTokenValue = tokenResponse.refresh_token || previous?.refresh_token;
    if (typeof accessToken !== 'string' || !accessToken ||
        typeof refreshTokenValue !== 'string' || !refreshTokenValue ||
        !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Identity provider returned an invalid token response');
    }
    const data = {
      access_token: accessToken,
      refresh_token: refreshTokenValue,
      id_token: tokenResponse.id_token || previous?.id_token,
      expiresAt: Date.now() + (expiresIn * 1000),
      tenantId,
      clientId,
      scope,
      userInfo: previous?.userInfo,
    };

    // Extract user info from id_token
    if (tokenResponse.id_token) {
      try {
        data.userInfo = decodeJwtPayload(tokenResponse.id_token);
      } catch (_) {}
    }

    if (chrome.storage?.session) {
      await chrome.storage.session.set({ [SESSION_KEY]: data });
    }
    return data;
  }

  async function getStoredTokens() {
    if (!chrome.storage?.session) return null;
    return new Promise((resolve) => {
      chrome.storage.session.get(SESSION_KEY, (result) => {
        resolve(result[SESSION_KEY] || null);
      });
    });
  }

  async function clearStoredTokens() {
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(SESSION_KEY);
    }
  }

  // ── JWT decoding (for id_token user info) ─────────────────────────────────

  function decodeJwtPayload(jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - payload.length % 4) % 4);
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  function validateIdToken(idToken, { tenantId, clientId, nonce }) {
    if (!idToken) throw new Error('Identity provider did not return an ID token');
    const claims = decodeJwtPayload(idToken);
    const audience = (Array.isArray(claims.aud) ? claims.aud : [claims.aud])
      .map((value) => String(value || '').toLowerCase());
    if (!audience.includes(clientId.toLowerCase())) throw new Error('ID token audience mismatch');
    if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
    if (String(claims.tid || '').toLowerCase() !== tenantId.toLowerCase()) {
      throw new Error('ID token tenant mismatch');
    }
    const expectedIssuer = `https://login.microsoftonline.com/${tenantId.toLowerCase()}/v2.0`;
    if (String(claims.iss || '').toLowerCase().replace(/\/$/, '') !== expectedIssuer) {
      throw new Error('ID token issuer mismatch');
    }
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() - 60_000) {
      throw new Error('ID token is expired');
    }
    return claims;
  }

  // ── Core auth flow ────────────────────────────────────────────────────────

  /**
   * Sign in to Azure AD using OAuth2 PKCE.
   * Opens a browser popup for authentication.
   *
   * @param {string} tenantId - Azure AD tenant ID (GUID)
   * @param {string} clientId - App Registration client ID (GUID)
   * @returns {Promise<{name: string, email: string}>} User info
   */
  async function signIn(tenantId, clientId, scope = SCOPE) {
    if (!GUID_RE.test(tenantId || '') || !GUID_RE.test(clientId || '')) {
      throw new Error('Tenant ID and Client ID must be valid GUIDs');
    }
    tenantId = tenantId.toLowerCase();
    clientId = clientId.toLowerCase();
    if (scope !== SCOPE) throw new Error('Unsupported OAuth scope');

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const redirectUrl = chrome.identity.getRedirectURL();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('prompt', 'select_account');

    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (callbackUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(callbackUrl);
          }
        }
      );
    });

    // launchWebAuthFlow should only complete on the registered Chromium
    // callback. Verify that boundary again before accepting any parameters.
    const callback = new URL(responseUrl);
    const expectedCallback = new URL(redirectUrl);
    if (callback.origin !== expectedCallback.origin || callback.pathname !== expectedCallback.pathname) {
      throw new Error('Identity provider returned an unexpected redirect URL');
    }

    // Extract authorization code
    const params = callback.searchParams;
    const code = params.get('code');
    const returnedState = params.get('state');

    if (!code) {
      const error = params.get('error_description') || params.get('error') || 'No authorization code received';
      throw new Error(error);
    }

    if (returnedState !== state) {
      throw new Error('State mismatch — possible CSRF attack');
    }

    // Exchange code for tokens
    const tokenResponse = await exchangeCodeForTokens(tenantId, clientId, code, verifier, redirectUrl);
    validateIdToken(tokenResponse.id_token, { tenantId, clientId, nonce });
    const stored = await storeTokens(tokenResponse, tenantId, clientId, scope);

    // Schedule refresh
    scheduleRefresh(tokenResponse.expires_in);

    const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
    if (dbg) dbg.log('azure-auth', 'Interactive sign-in completed');

    return getUserInfoFromStored(stored);
  }

  /**
   * Exchange authorization code for tokens.
   */
  async function exchangeCodeForTokens(tenantId, clientId, code, verifier, redirectUrl) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUrl,
      code_verifier: verifier,
    });

    const response = await secureFetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }
    );

    if (!response.ok) {
      throw new Error(`Token exchange failed: HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async function refreshToken(tenantId, clientId) {
    const stored = await getStoredTokens();
    if (!stored?.refresh_token) {
      throw new Error('No refresh token available — sign in again');
    }

    const tid = (tenantId || stored.tenantId).toLowerCase();
    const cid = (clientId || stored.clientId).toLowerCase();
    if (tid !== stored.tenantId || cid !== stored.clientId) {
      throw new Error('Token refresh configuration does not match the signed-in account');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cid,
      refresh_token: stored.refresh_token,
      scope: stored.scope || SCOPE,
    });

    const response = await secureFetch(
      `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }
    );

    if (!response.ok) {
      // Refresh failed — clear tokens, user must sign in again
      await clearStoredTokens();
      throw new Error('Token refresh failed — sign in again');
    }

    const tokenResponse = await response.json();
    await storeTokens(tokenResponse, tid, cid, stored.scope || SCOPE, stored);
    scheduleRefresh(tokenResponse.expires_in);

    const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
    if (dbg) dbg.log('azure-auth', 'Token refreshed, expires in', tokenResponse.expires_in, 's');
  }

  // Cache for storage-scoped tokens (separate from the main Cognitive Services token)
  const STORAGE_TOKEN_KEY = 'llss_azure_storage_token';

  /**
   * Get a valid access token. Refreshes automatically if expiring soon.
   *
   * @param {string} [tenantId]
   * @param {string} [clientId]
   * @param {string} [scope] - Optional scope override (e.g., 'https://storage.azure.com/.default')
   * @returns {Promise<string|null>} Access token or null if not signed in
   */
  async function getAccessToken(tenantId, clientId, scope) {
    const stored = await getStoredTokens();
    if (!stored?.refresh_token) return null;
    if ((tenantId && tenantId.toLowerCase() !== stored.tenantId.toLowerCase()) ||
        (clientId && clientId.toLowerCase() !== stored.clientId.toLowerCase())) {
      return null;
    }

    const requestedScope = scope || SCOPE;
    if (![SCOPE, STORAGE_SCOPE].includes(requestedScope)) {
      throw new Error('Unsupported OAuth scope');
    }

    // If requesting a scope different from the interactive token, use the
    // refresh token and keep the resulting token in session storage only.
    if (requestedScope !== (stored.scope || SCOPE)) {
      return getAlternateScopeToken(
        tenantId || stored.tenantId,
        clientId || stored.clientId,
        stored.refresh_token,
        requestedScope
      );
    }

    if (!stored.access_token) return null;

    // Refresh if expiring within 5 minutes
    if (stored.expiresAt && Date.now() > stored.expiresAt - 300000) {
      try {
        await refreshToken(tenantId || stored.tenantId, clientId || stored.clientId);
        const refreshed = await getStoredTokens();
        return refreshed?.access_token || null;
      } catch {
        return null;
      }
    }

    return stored.access_token;
  }

  /**
   * Get an access token for an alternate scope (e.g., Azure Storage).
   * Uses the stored refresh token to obtain a new access token with
   * the requested scope. Cached in session storage.
   */
  async function getAlternateScopeToken(tenantId, clientId, refreshTokenValue, scope) {
    tenantId = tenantId.toLowerCase();
    clientId = clientId.toLowerCase();
    // Check cache
    if (chrome.storage?.session) {
      const cached = await new Promise(r => {
        chrome.storage.session.get(STORAGE_TOKEN_KEY, (res) => r(res[STORAGE_TOKEN_KEY]));
      });
      if (cached?.access_token && cached.scope === scope &&
          cached.tenantId === tenantId && cached.clientId === clientId &&
          cached.expiresAt > Date.now() + 60000) {
        return cached.access_token;
      }
    }

    // Request new token with the alternate scope
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshTokenValue,
      scope,
    });

    const response = await secureFetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }
    );

    if (!response.ok) return null;

    const tokenData = await response.json();
    if (typeof tokenData.access_token !== 'string' || !tokenData.access_token ||
        !Number.isFinite(Number(tokenData.expires_in)) || Number(tokenData.expires_in) <= 0) {
      throw new Error('Identity provider returned an invalid scoped token response');
    }

    // Cache it
    if (chrome.storage?.session) {
      await chrome.storage.session.set({
        [STORAGE_TOKEN_KEY]: {
          access_token: tokenData.access_token,
          scope,
          tenantId,
          clientId,
          expiresAt: Date.now() + (tokenData.expires_in * 1000),
        },
      });
    }

    return tokenData.access_token;
  }

  /**
   * Sign out — clear all stored tokens.
   */
  async function signOut() {
    await clearStoredTokens();
    if (chrome.storage?.session) await chrome.storage.session.remove(STORAGE_TOKEN_KEY);
    if (chrome.alarms) {
      chrome.alarms.clear(ALARM_NAME);
    }
    const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
    if (dbg) dbg.log('azure-auth', 'Signed out');
  }

  /**
   * Check if the user is currently signed in.
   */
  async function isSignedIn() {
    const stored = await getStoredTokens();
    return !!(stored?.access_token);
  }

  /**
   * Get the signed-in user's display info.
   */
  async function getUserInfo() {
    const stored = await getStoredTokens();
    return getUserInfoFromStored(stored);
  }

  function getUserInfoFromStored(stored) {
    if (!stored?.userInfo) return null;
    const info = stored.userInfo;
    return {
      name: info.name || info.preferred_username || 'Unknown',
      email: info.preferred_username || info.email || info.upn || '',
      tenantId: stored.tenantId,
    };
  }

  // ── Refresh scheduling ────────────────────────────────────────────────────

  function scheduleRefresh(expiresInSeconds) {
    if (!chrome.alarms) return;
    // Refresh 5 minutes before expiry
    const delayMs = Math.max((expiresInSeconds - 300) * 1000, 60000);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMs / 60000 });
  }

  // Handle refresh alarm (called from background.js alarm listener)
  async function handleRefreshAlarm() {
    const stored = await getStoredTokens();
    if (!stored) return;
    try {
      await refreshToken(stored.tenantId, stored.clientId);
    } catch (err) {
      const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
      if (dbg) dbg.warn('azure-auth', 'Auto-refresh failed:', err.message);
    }
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_AzureAuth = {
      signIn,
      signOut,
      getAccessToken,
      getUserInfo,
      isSignedIn,
      refreshToken,
      handleRefreshAlarm,
    };
  }
})();
