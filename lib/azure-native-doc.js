/**
 * Azure Native Document PII Redaction.
 *
 * Uses the Azure Language analyze-documents API to redact PII from
 * PDF, DOCX, and TXT files server-side. Azure handles OCR, text
 * extraction, PII detection, and document reconstruction.
 *
 * Two storage auth patterns:
 *
 *   Direct mode (API key):
 *     - Extension uploads source file to blob via SAS token
 *     - Source blob URL with SAS passed to the job
 *     - Target container URL with SAS for results
 *     - Extension downloads redacted file via SAS
 *
 *   Enterprise mode (OAuth2 + managed identity):
 *     - Admin enables managed identity on the Language resource
 *     - Admin grants Language resource Storage Blob Data Reader on source
 *       and Storage Blob Data Contributor on target
 *     - Extension uploads source file using user's storage OAuth2 token
 *     - Job uses plain URLs (Language resource accesses storage via MI)
 *     - Extension downloads redacted file using user's storage token
 *
 * API version: 2024-11-15-preview
 */

(function () {
  'use strict';

  const API_VERSION = '2024-11-15-preview';
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_ATTEMPTS = 200; // ~10 minutes max
  const STORAGE_SCOPE = 'https://storage.azure.com/.default';

  // ── Auth helpers ──────────────────────────────────────────────────────────

  /**
   * Get auth headers for the Language API.
   */
  async function getLanguageHeaders(settings) {
    const headers = { 'Content-Type': 'application/json' };

    if (settings.connectionMode === 'enterprise') {
      const auth = globalThis.LLSS_AzureAuth;
      if (!auth) throw new Error('Azure Auth module not loaded');
      const token = await auth.getAccessToken(settings.tenantId, settings.clientId);
      if (!token) throw new Error('Not signed in to Azure AD');
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      if (!settings.apiKey) throw new Error('No API key configured');
      headers['Ocp-Apim-Subscription-Key'] = settings.apiKey;
    }

    return headers;
  }

  /**
   * Get auth headers for Azure Blob Storage.
   * Enterprise mode: uses OAuth2 token scoped to storage.azure.com
   * Direct mode: SAS token is in the URL, no auth header needed.
   */
  async function getStorageHeaders(settings) {
    if (settings.connectionMode === 'enterprise') {
      const auth = globalThis.LLSS_AzureAuth;
      if (!auth) throw new Error('Azure Auth module not loaded');

      // Get a storage-scoped token using the refresh token
      const token = await auth.getAccessToken(settings.tenantId, settings.clientId, STORAGE_SCOPE);
      if (!token) {
        // Fallback: if we can't get a storage token, SAS in the URL may still work
        return {};
      }
      return {
        'Authorization': `Bearer ${token}`,
        'x-ms-version': '2023-11-03',
      };
    }
    return {};
  }

  // ── Blob operations ───────────────────────────────────────────────────────

  /**
   * Upload a file to Azure Blob Storage.
   *
   * @param {string} containerUrl - Container URL (with SAS in direct mode, plain in enterprise)
   * @param {string} blobName - File name for the blob
   * @param {ArrayBuffer|Uint8Array} data - File content
   * @param {string} contentType - MIME type
   * @param {Object} settings - Provider settings (for auth mode)
   * @returns {Promise<string>} Full blob URL (with SAS if direct mode)
   */
  async function uploadToBlob(containerUrl, blobName, data, contentType, settings) {
    const url = new URL(containerUrl);
    const sasToken = url.search; // empty in enterprise mode
    const blobUrl = `${url.origin}${url.pathname}/${encodeURIComponent(blobName)}${sasToken}`;

    const storageHeaders = await getStorageHeaders(settings);

    const response = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'x-ms-blob-type': 'BlockBlob',
        ...storageHeaders,
      },
      body: data,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Blob upload failed: ${response.status} — ${errText.substring(0, 200)}`);
    }

    // Return URL without SAS for enterprise mode (Language resource uses managed identity)
    // Return URL with SAS for direct mode (Language resource reads via SAS)
    return blobUrl;
  }

  /**
   * Download a blob from Azure Blob Storage.
   */
  async function downloadBlob(blobUrl, settings, fallbackSas) {
    // If the URL doesn't have a SAS token and we have a fallback, append it
    const url = (!blobUrl.includes('?') && fallbackSas)
      ? `${blobUrl}?${fallbackSas.replace(/^\?/, '')}`
      : blobUrl;

    const storageHeaders = await getStorageHeaders(settings);

    const response = await fetch(url, { headers: storageHeaders });
    if (!response.ok) {
      throw new Error(`Blob download failed: ${response.status}`);
    }

    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  // ── Job management ────────────────────────────────────────────────────────

  /**
   * Submit a native document PII redaction job.
   */
  async function submitJob(options) {
    const {
      endpoint,
      settings,
      sourceBlobUrl,
      targetContainerUrl,
      language = 'en',
      redactionPolicy = 'entityMask',
      piiCategories,
    } = options;

    const url = `${endpoint.replace(/\/$/, '')}/language/analyze-documents/jobs?api-version=${API_VERSION}`;
    const headers = await getLanguageHeaders(settings);

    // For the job, use clean URLs (no SAS) in enterprise mode.
    // The Language resource's managed identity handles storage auth.
    // In direct mode, SAS tokens are included in the URLs.
    const cleanUrl = (u) => {
      if (settings.connectionMode === 'enterprise') {
        return u.split('?')[0]; // Strip SAS if accidentally included
      }
      return u;
    };

    const body = {
      displayName: 'LLSS Document PII Redaction',
      analysisInput: {
        documents: [
          {
            language,
            id: 'doc-1',
            source: { location: cleanUrl(sourceBlobUrl) },
            target: { location: cleanUrl(targetContainerUrl) },
          },
        ],
      },
      tasks: [
        {
          kind: 'PiiEntityRecognition',
          taskName: 'LLSS-PII-Redaction',
          parameters: {
            redactionPolicy: { policyKind: redactionPolicy },
            ...(piiCategories?.length ? { piiCategories } : {}),
            excludeExtractionData: false,
          },
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Job submission failed: ${response.status} — ${errText.substring(0, 300)}`);
    }

    const operationLocation = response.headers.get('operation-location');
    if (!operationLocation) {
      throw new Error('No operation-location header in response');
    }

    return operationLocation;
  }

  /**
   * Poll a job until completion.
   */
  async function pollJob(operationUrl, settings, onProgress) {
    const headers = await getLanguageHeaders(settings);
    delete headers['Content-Type'];

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await fetch(operationUrl, { headers });
      if (!response.ok) {
        throw new Error(`Job poll failed: ${response.status}`);
      }

      const result = await response.json();
      const status = result.status;

      if (onProgress) {
        onProgress({
          status,
          completed: result.tasks?.completed || 0,
          total: result.tasks?.total || 1,
        });
      }

      if (status === 'succeeded') return result;
      if (status === 'failed' || status === 'cancelled') {
        const errors = result.errors || [];
        throw new Error(
          errors.length > 0
            ? errors.map(e => e.message || JSON.stringify(e)).join('; ')
            : `Job ${status}`
        );
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error('Job polling timed out');
  }

  // ── Full pipeline ─────────────────────────────────────────────────────────

  /**
   * Full native document redaction: upload → submit → poll → download.
   *
   * @param {ArrayBuffer} fileData - Raw file bytes
   * @param {string} fileName - Original file name
   * @param {string} mimeType - File MIME type
   * @param {Object} providerSettings - Azure PII provider settings
   * @param {Object} nativeDocSettings - { sourceContainerUrl, targetContainerUrl, redactionPolicy }
   * @param {Function} [onProgress]
   */
  async function redactDocument(fileData, fileName, mimeType, providerSettings, nativeDocSettings, onProgress) {
    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    const sourceUrl = nativeDocSettings.sourceContainerUrl;
    const targetUrl = nativeDocSettings.targetContainerUrl;

    if (!sourceUrl || !targetUrl) {
      throw new Error('Azure Blob Storage source and target container URLs are required');
    }

    // Step 1: Upload source file
    if (dbg) dbg.log('azure-native-doc', `Uploading ${fileName} (${providerSettings.connectionMode} mode)...`);
    if (onProgress) onProgress({ status: 'uploading' });

    const sourceBlobUrl = await uploadToBlob(sourceUrl, fileName, fileData, mimeType, providerSettings);

    // Step 2: Submit redaction job
    if (dbg) dbg.log('azure-native-doc', 'Submitting PII redaction job...');
    if (onProgress) onProgress({ status: 'processing' });

    const operationUrl = await submitJob({
      endpoint: providerSettings.endpoint,
      settings: providerSettings,
      sourceBlobUrl,
      targetContainerUrl: targetUrl,
      language: providerSettings.language || 'en',
      redactionPolicy: nativeDocSettings.redactionPolicy || 'entityMask',
      piiCategories: providerSettings.categoriesFilter?.length > 0
        ? providerSettings.categoriesFilter
        : undefined,
    });

    // Step 3: Poll
    if (dbg) dbg.log('azure-native-doc', 'Polling for completion...');
    const jobResult = await pollJob(operationUrl, providerSettings, onProgress);

    // Step 4: Find redacted document in results
    const taskResult = jobResult.tasks?.items?.[0];
    if (!taskResult || taskResult.status !== 'succeeded') {
      throw new Error('PII task did not succeed');
    }

    const docResult = taskResult.results?.documents?.[0];
    if (!docResult) throw new Error('No document results returned');

    const targets = docResult.targets || [];
    const redactedTarget = targets.find(t => t.location && !t.location.endsWith('.result.json'));
    const jsonTarget = targets.find(t => t.location && t.location.endsWith('.result.json'));

    if (!redactedTarget) throw new Error('No redacted document found in job results');

    // Step 5: Download redacted document
    if (dbg) dbg.log('azure-native-doc', 'Downloading redacted document...');
    if (onProgress) onProgress({ status: 'downloading' });

    // For download: in direct mode, use target container's SAS. In enterprise mode, use storage OAuth2 token.
    const targetSas = new URL(targetUrl).search;
    const redactedDoc = await downloadBlob(redactedTarget.location, providerSettings, targetSas);

    // Step 6: Download entity results
    let entities = [];
    if (jsonTarget) {
      try {
        const jsonDoc = await downloadBlob(jsonTarget.location, providerSettings, targetSas);
        const jsonData = JSON.parse(new TextDecoder().decode(jsonDoc.data));
        entities = jsonData.entities || jsonData.results?.documents?.[0]?.entities || [];
      } catch (err) {
        if (dbg) dbg.warn('azure-native-doc', 'Could not download entity results:', err.message);
      }
    }

    const redactedUrl = new URL(redactedTarget.location);
    const redactedFileName = decodeURIComponent(redactedUrl.pathname.split('/').pop());

    if (dbg) dbg.log('azure-native-doc', `Complete: ${redactedFileName}, ${entities.length} entities, ${redactedDoc.data.byteLength} bytes`);

    return {
      redactedFile: redactedDoc.data,
      redactedFileName,
      contentType: redactedDoc.contentType,
      entities,
      jobId: jobResult.jobId,
    };
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_AzureNativeDoc = {
      uploadToBlob,
      downloadBlob,
      submitJob,
      pollJob,
      redactDocument,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uploadToBlob, downloadBlob, submitJob, pollJob, redactDocument };
  }
})();
