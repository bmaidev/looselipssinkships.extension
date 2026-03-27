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

  async function storeTokens(tokenResponse, tenantId, clientId) {
    const data = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      id_token: tokenResponse.id_token,
      expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
      tenantId,
      clientId,
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
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload);
    return JSON.parse(decoded);
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
  async function signIn(tenantId, clientId) {
    if (!tenantId || !clientId) {
      throw new Error('Tenant ID and Client ID are required');
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const redirectUrl = chrome.identity.getRedirectURL();
    const state = crypto.randomUUID();

    const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
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

    // Extract authorization code
    const params = new URL(responseUrl).searchParams;
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
    const stored = await storeTokens(tokenResponse, tenantId, clientId);

    // Schedule refresh
    scheduleRefresh(tokenResponse.expires_in);

    const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
    if (dbg) dbg.log('azure-auth', 'Signed in:', stored.userInfo?.name || 'unknown');

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

    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || `Token exchange failed: HTTP ${response.status}`);
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

    const tid = tenantId || stored.tenantId;
    const cid = clientId || stored.clientId;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cid,
      refresh_token: stored.refresh_token,
      scope: SCOPE,
    });

    const response = await fetch(
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
    await storeTokens(tokenResponse, tid, cid);
    scheduleRefresh(tokenResponse.expires_in);

    const dbg = typeof globalThis !== 'undefined' && globalThis.LLSS_debug;
    if (dbg) dbg.log('azure-auth', 'Token refreshed, expires in', tokenResponse.expires_in, 's');
  }

  /**
   * Get a valid access token. Refreshes automatically if expiring soon.
   *
   * @param {string} [tenantId] - Optional, read from stored tokens if not provided
   * @param {string} [clientId] - Optional, read from stored tokens if not provided
   * @returns {Promise<string|null>} Access token or null if not signed in
   */
  async function getAccessToken(tenantId, clientId) {
    const stored = await getStoredTokens();
    if (!stored?.access_token) return null;

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
   * Sign out — clear all stored tokens.
   */
  async function signOut() {
    await clearStoredTokens();
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
