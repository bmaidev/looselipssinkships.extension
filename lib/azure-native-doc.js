/**
 * Azure Native Document PII Redaction.
 *
 * Uses the Azure Language analyze-documents API to redact PII from
 * PDF, DOCX, and TXT files server-side. Azure handles OCR, text
 * extraction, PII detection, and document reconstruction.
 *
 * Flow:
 *   1. Upload source file to Azure Blob Storage (source container + SAS)
 *   2. POST job to {endpoint}/language/analyze-documents/jobs
 *   3. Poll operation-location until status is 'succeeded'
 *   4. Download redacted document from target container
 *
 * Requirements:
 *   - Azure Language resource (single-service, not multi-service)
 *   - Azure Blob Storage account with source + target containers
 *   - SAS tokens with appropriate permissions:
 *       source: read + list
 *       target: write + list
 *
 * API version: 2024-11-15-preview
 */

(function () {
  'use strict';

  const API_VERSION = '2024-11-15-preview';
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_ATTEMPTS = 200; // ~10 minutes max

  /**
   * Get auth headers based on connection mode (direct API key or OAuth2 Bearer).
   */
  async function getHeaders(settings) {
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
   * Upload a file to Azure Blob Storage via PUT with SAS token.
   *
   * @param {string} containerSasUrl - Container URL with SAS token (e.g., https://account.blob.core.windows.net/source?sv=...)
   * @param {string} blobName - File name for the blob
   * @param {ArrayBuffer|Uint8Array} data - File content
   * @param {string} contentType - MIME type
   * @returns {Promise<string>} Full blob URL with SAS token
   */
  async function uploadToBlob(containerSasUrl, blobName, data, contentType) {
    // Parse container URL and SAS token
    const url = new URL(containerSasUrl);
    const sasToken = url.search; // includes the ?
    const blobUrl = `${url.origin}${url.pathname}/${encodeURIComponent(blobName)}${sasToken}`;

    const response = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'x-ms-blob-type': 'BlockBlob',
      },
      body: data,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Blob upload failed: ${response.status} — ${errText.substring(0, 200)}`);
    }

    return blobUrl;
  }

  /**
   * Download a blob from Azure Blob Storage.
   *
   * @param {string} blobUrl - Full blob URL (with or without SAS token)
   * @param {string} [sasToken] - Optional SAS token if not in the URL
   * @returns {Promise<{data: ArrayBuffer, contentType: string}>}
   */
  async function downloadBlob(blobUrl, sasToken) {
    const url = sasToken && !blobUrl.includes('?')
      ? `${blobUrl}?${sasToken.replace(/^\?/, '')}`
      : blobUrl;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Blob download failed: ${response.status}`);
    }

    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  /**
   * Submit a native document PII redaction job to Azure.
   *
   * @param {Object} options
   * @param {string} options.endpoint - Azure Language endpoint
   * @param {Object} options.settings - Provider settings (apiKey, connectionMode, etc.)
   * @param {string} options.sourceBlobUrl - Source blob URL with SAS token
   * @param {string} options.targetContainerUrl - Target container URL with SAS token
   * @param {string} [options.language] - Document language (default: 'en')
   * @param {string} [options.redactionPolicy] - 'characterMask' | 'entityMask' | 'noMask'
   * @param {string[]} [options.piiCategories] - Specific categories to detect
   * @returns {Promise<string>} Operation location URL for polling
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
    const headers = await getHeaders(settings);

    const body = {
      displayName: 'LLSS Document PII Redaction',
      analysisInput: {
        documents: [
          {
            language,
            id: 'doc-1',
            source: { location: sourceBlobUrl },
            target: { location: targetContainerUrl },
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
   *
   * @param {string} operationUrl - Operation location URL
   * @param {Object} settings - Provider settings for auth headers
   * @param {Function} [onProgress] - Progress callback ({status, completed, total})
   * @returns {Promise<Object>} Completed job result
   */
  async function pollJob(operationUrl, settings, onProgress) {
    const headers = await getHeaders(settings);
    delete headers['Content-Type']; // GET request, no body

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await fetch(operationUrl, { headers });
      if (!response.ok) {
        throw new Error(`Job poll failed: ${response.status}`);
      }

      const result = await response.json();
      const status = result.status;

      if (onProgress) {
        const tasks = result.tasks || {};
        onProgress({
          status,
          completed: tasks.completed || 0,
          total: tasks.total || 1,
        });
      }

      if (status === 'succeeded') return result;
      if (status === 'failed' || status === 'cancelled') {
        const errors = result.errors || [];
        const msg = errors.length > 0
          ? errors.map(e => e.message || JSON.stringify(e)).join('; ')
          : `Job ${status}`;
        throw new Error(msg);
      }

      // Wait before next poll
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error('Job polling timed out');
  }

  /**
   * Full native document redaction pipeline:
   *   upload → submit → poll → download redacted file
   *
   * @param {ArrayBuffer} fileData - Raw file bytes
   * @param {string} fileName - Original file name
   * @param {string} mimeType - File MIME type
   * @param {Object} providerSettings - Azure PII provider settings
   * @param {Object} nativeDocSettings - Native document settings:
   *   { sourceContainerSas, targetContainerSas, redactionPolicy }
   * @param {Function} [onProgress] - Progress callback
   * @returns {Promise<{redactedFile: ArrayBuffer, redactedFileName: string, contentType: string, entities: Array}>}
   */
  async function redactDocument(fileData, fileName, mimeType, providerSettings, nativeDocSettings, onProgress) {
    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    if (!nativeDocSettings?.sourceContainerSas || !nativeDocSettings?.targetContainerSas) {
      throw new Error('Azure Blob Storage source and target container SAS URLs are required for native document redaction');
    }

    // Step 1: Upload source file
    if (dbg) dbg.log('azure-native-doc', `Uploading ${fileName} to source container...`);
    if (onProgress) onProgress({ status: 'uploading' });

    const sourceBlobUrl = await uploadToBlob(
      nativeDocSettings.sourceContainerSas,
      fileName,
      fileData,
      mimeType
    );

    // Step 2: Submit redaction job
    if (dbg) dbg.log('azure-native-doc', 'Submitting PII redaction job...');
    if (onProgress) onProgress({ status: 'processing' });

    const operationUrl = await submitJob({
      endpoint: providerSettings.endpoint,
      settings: providerSettings,
      sourceBlobUrl,
      targetContainerUrl: nativeDocSettings.targetContainerSas,
      language: providerSettings.language || 'en',
      redactionPolicy: nativeDocSettings.redactionPolicy || 'entityMask',
      piiCategories: providerSettings.categoriesFilter?.length > 0
        ? providerSettings.categoriesFilter
        : undefined,
    });

    // Step 3: Poll for completion
    if (dbg) dbg.log('azure-native-doc', 'Polling for job completion...');
    const jobResult = await pollJob(operationUrl, providerSettings, onProgress);

    // Step 4: Find the redacted document in the results
    const taskResult = jobResult.tasks?.items?.[0];
    if (!taskResult || taskResult.status !== 'succeeded') {
      throw new Error('PII task did not succeed');
    }

    const docResult = taskResult.results?.documents?.[0];
    if (!docResult) {
      throw new Error('No document results returned');
    }

    // Find the redacted document target (not the .result.json)
    const targets = docResult.targets || [];
    const redactedTarget = targets.find(t =>
      t.location && !t.location.endsWith('.result.json')
    );
    const jsonTarget = targets.find(t =>
      t.location && t.location.endsWith('.result.json')
    );

    if (!redactedTarget) {
      throw new Error('No redacted document found in job results');
    }

    // Step 5: Download the redacted document
    if (dbg) dbg.log('azure-native-doc', 'Downloading redacted document from:', redactedTarget.location);
    if (onProgress) onProgress({ status: 'downloading' });

    // The target URLs may already include SAS tokens from the job result,
    // or we may need to use the target container SAS
    const targetSas = new URL(nativeDocSettings.targetContainerSas).search;
    const redactedDoc = await downloadBlob(redactedTarget.location, targetSas);

    // Step 6: Optionally download the entity results JSON
    let entities = [];
    if (jsonTarget) {
      try {
        const jsonDoc = await downloadBlob(jsonTarget.location, targetSas);
        const jsonText = new TextDecoder().decode(jsonDoc.data);
        const jsonData = JSON.parse(jsonText);
        entities = jsonData.entities || jsonData.results?.documents?.[0]?.entities || [];
      } catch (err) {
        if (dbg) dbg.warn('azure-native-doc', 'Could not download entity results:', err.message);
      }
    }

    // Determine the output file name
    const redactedUrl = new URL(redactedTarget.location);
    const redactedFileName = decodeURIComponent(redactedUrl.pathname.split('/').pop());

    if (dbg) dbg.log('azure-native-doc', `Redaction complete: ${redactedFileName}, ${entities.length} entities, ${redactedDoc.data.byteLength} bytes`);

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
