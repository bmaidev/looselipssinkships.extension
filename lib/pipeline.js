/**
 * Progressive Processing Pipeline
 *
 * Implements the architectural rule: LOCAL → HOSTED → CLOUD
 *
 * For text: Browser on-device AI → Regex+Vector → Hosted Model → Azure PII
 * For documents: Local text extraction → Local redaction → Hosted APIs → Cloud APIs
 *
 * The pipeline tries the highest-privacy tier first and only escalates when:
 * 1. The preferred provider is unavailable
 * 2. The content type requires capabilities only available at a higher tier
 * 3. The user has explicitly configured a specific provider/tier
 *
 * Belt-and-suspenders mode: optionally run regex after AI to catch anything missed.
 */

(function () {
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./providers/base-provider').PROVIDER_TIERS : { LOCAL: 'local', HOSTED: 'hosted', CLOUD: 'cloud' });

  async function _withTimeout(promise, timeoutMs) {
    let timeoutId;
    try {
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      });
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * @typedef {Object} PipelineResult
   * @property {string} redacted - The redacted content
   * @property {string} engine - Provider ID that performed primary redaction
   * @property {string} tier - Provider tier used
   * @property {Array} matches - PII matches found
   * @property {Object} metadata - Processing metadata
   * @property {Array<string>} pipelineSteps - Ordered list of steps taken
   * @property {boolean} escalated - Whether processing was escalated from local
   */

  /**
   * @typedef {Object} PipelineOptions
   * @property {Object} registry - ProviderRegistry instance
   * @property {Array} piiTypes - Enabled PII type definitions
   * @property {Object} settings - Current extension settings
   * @property {string} [forceTier] - Force a specific tier
   * @property {string} [forceProvider] - Force a specific provider ID
   * @property {boolean} [beltAndSuspenders] - Run regex after AI for extra safety
   */

  /**
   * Run the redaction pipeline for plain text.
   *
   * @param {string} text - Input text to redact
   * @param {PipelineOptions} options
   * @returns {Promise<PipelineResult>}
   */
  async function redactText(text, options) {
    const { registry, piiTypes, settings } = options;
    const steps = [];
    let result = null;
    let escalated = false;
    let resultTier = 'local';

    // Determine mode
    const mode = settings.detectionMode || 'auto';

    // Force specific provider if requested
    if (options.forceProvider) {
      const provider = registry.get(options.forceProvider);
      if (!provider) throw new Error(`Provider '${options.forceProvider}' not found`);
      const avail = await registry.checkAvailability(provider.id);
      if (!avail.available) throw new Error(`Provider '${options.forceProvider}' is not available: ${avail.detail}`);

      steps.push(`forced:${provider.id}`);
      result = await provider.redactText(text, piiTypes, settings);
      if (provider.id !== 'regex') {
        result = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
      }
      return _buildResult(result, provider.tier, steps, false);
    }

    // Force specific tier
    if (options.forceTier) {
      const provider = await registry.findBestProvider('text', { preferredTier: options.forceTier });
      if (!provider) throw new Error(`No available provider in tier '${options.forceTier}'`);

      steps.push(`tier:${options.forceTier}:${provider.id}`);
      result = await provider.redactText(text, piiTypes, settings);
      if (provider.id !== 'regex') {
        result = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
      }
      return _buildResult(result, provider.tier, steps, false);
    }

    // Mode-specific routing
    if (mode === 'regex_only') {
      return _runRegexPipeline(text, registry, piiTypes, settings, steps);
    }

    if (mode === 'ai_only') {
      return _runAiOnlyPipeline(text, registry, piiTypes, settings, steps);
    }

    if (mode === 'cloud_only') {
      return _runCloudOnlyPipeline(text, registry, piiTypes, settings, steps);
    }

    if (mode === 'hosted_only') {
      return _runHostedOnlyPipeline(text, registry, piiTypes, settings, steps);
    }

    // Auto mode — regex-first with AI enhancement
    //
    // Architecture: regex runs FIRST (instant), then AI runs with a timeout
    // to catch entities regex missed. This ensures the user always gets
    // fast results, with optional AI refinement.
    //
    // Short text (<200 chars): regex only (AI overhead not worth it)
    // Medium text (200-1000): regex + AI with 3s timeout
    // Long text (>1000): regex only (AI too slow, chunk support TBD)

    const AI_TIMEOUT_MS = 3000;
    const AI_SHORT_THRESHOLD = 200;
    const AI_LONG_THRESHOLD = 1000;

    // Step 1: Always run regex first (instant)
    const regexProvider = registry.get('regex');
    if (regexProvider && regexProvider.enabled) {
      steps.push('regex_first');
      result = await regexProvider.redactText(text, piiTypes, settings);
    }

    // Step 2: For medium-length text, try AI enhancement with timeout
    if (text.length >= AI_SHORT_THRESHOLD && text.length <= AI_LONG_THRESHOLD) {
      const localAi = registry.get('local_ai');
      if (localAi && localAi.enabled) {
        const avail = await registry.checkAvailability('local_ai');
        if (avail.available) {
          try {
            steps.push('ai_enhance');
            const aiResult = await _withTimeout(
              localAi.redactText(text, piiTypes, settings),
              AI_TIMEOUT_MS
            );

            if (aiResult && aiResult.matches && aiResult.matches.length > 0) {
              result = await _applyRegexPass(text, registry, piiTypes, settings, aiResult, steps);
              result.engine = `regex+${aiResult.engine}`;
              result.metadata = { ...result.metadata, aiEnhanced: true };
              steps.push(`ai_enhanced:${aiResult.matches.length}_entities`);
            } else if (aiResult === null) {
              steps.push('ai_enhance:timeout');
            }
          } catch (err) {
            steps.push(`ai_enhance:failed:${err.message}`);
          }
        }
      }

      // Also try hosted models with timeout if available
      if (!result?.metadata?.aiEnhanced) {
        const hostedProviders = registry.getByTier('hosted').filter(p => p.enabled && p.supports('text'));
        for (const hosted of hostedProviders) {
          const avail = await registry.checkAvailability(hosted.id);
          if (avail.available) {
            try {
              steps.push(`hosted_enhance:${hosted.id}`);
              const hostedResult = await _withTimeout(
                hosted.redactText(text, piiTypes, settings),
                AI_TIMEOUT_MS
              );

              if (hostedResult && hostedResult.matches && hostedResult.matches.length > 0) {
                result = await _applyRegexPass(text, registry, piiTypes, settings, hostedResult, steps);
                result.engine = `regex+${hostedResult.engine}`;
                result.metadata = { ...result.metadata, hostedEnhanced: true };
                resultTier = 'hosted';
                escalated = true;
                steps.push(`hosted_enhanced:${hostedResult.matches.length}_entities`);
              } else if (hostedResult === null) {
                steps.push(`hosted_enhance:${hosted.id}:timeout`);
              }
              break;
            } catch (err) {
              steps.push(`hosted_enhance:${hosted.id}:failed:${err.message}`);
            }
          }
        }
      }
    }

    // Step 3: If regex found nothing and we have cloud providers, try those
    if ((!result || (result.matches || []).length === 0) && text.length < AI_LONG_THRESHOLD) {
      const cloudProviders = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
      for (const cloud of cloudProviders) {
        const avail = await registry.checkAvailability(cloud.id);
        if (avail.available) {
          try {
            steps.push(`cloud:${cloud.id}`);
            result = await cloud.redactText(text, piiTypes, settings);
            result = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
            resultTier = 'cloud';
            escalated = true;
            break;
          } catch (err) {
            steps.push(`cloud:${cloud.id}:failed:${err.message}`);
          }
        }
      }
    }

    if (!result) {
      throw new Error('No redaction providers available. Configure at least one provider.');
    }

    return _buildResult(result, resultTier, steps, escalated);
  }

  /**
   * Run the redaction pipeline for a document (file upload).
   *
   * @param {ArrayBuffer|string} content - Document content
   * @param {string} contentType - Document type (docx, xlsx, image, html, markdown, pdf)
   * @param {PipelineOptions} options
   * @returns {Promise<PipelineResult>}
   */
  async function redactDocument(content, contentType, options) {
    const { registry, piiTypes, settings } = options;
    const mode = settings.detectionMode || 'auto';
    const steps = [];
    const processDoc = globalThis.LLSS_processDocument || (typeof require !== 'undefined' ? require('./documents/document-processor').processDocument : null);

    if (!processDoc) throw new Error('Document processor not available');

    // Step 0: Try Azure native document redaction (server-side PDF/DOCX/TXT)
    // This bypasses local OCR entirely — Azure handles everything.
    const nativeDocSupported = ['pdf', 'docx', 'text'];
    const azureNativeDoc = globalThis.LLSS_AzureNativeDoc;
    const azurePiiConfig = settings.providers?.azure_pii;
    if (
      azureNativeDoc &&
      azurePiiConfig?.nativeDocEnabled &&
      azurePiiConfig?.enabled &&
      azurePiiConfig?.endpoint &&
      azurePiiConfig?.sourceContainerUrl &&
      azurePiiConfig?.targetContainerUrl &&
      nativeDocSupported.includes(contentType)
    ) {
      try {
        steps.push(`azure_native_doc:${contentType}`);
        const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;
        if (dbg) dbg.log('pipeline', `Azure native document redaction for ${contentType}`);

        const mimeMap = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: 'text/plain' };
        const selectedRedactionPolicy = ['entityMask', 'characterMask'].includes(azurePiiConfig.redactionPolicy)
          ? azurePiiConfig.redactionPolicy
          : 'entityMask';
        const result = await azureNativeDoc.redactDocument(
          content,
          options.fileName || `document.${contentType === 'text' ? 'txt' : contentType}`,
          mimeMap[contentType] || 'application/octet-stream',
          azurePiiConfig,
          {
            sourceContainerUrl: azurePiiConfig.sourceContainerUrl,
            targetContainerUrl: azurePiiConfig.targetContainerUrl,
            redactionPolicy: selectedRedactionPolicy,
          }
        );

        const resultBytes = new Uint8Array(result.redactedFile);
        if (resultBytes.byteLength === 0 || resultBytes.byteLength > 25 * 1024 * 1024) {
          throw new Error('Azure returned an empty or oversized redacted document');
        }
        if (contentType === 'pdf' && !_hasBytePrefix(resultBytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
          throw new Error('Azure returned an invalid redacted PDF');
        }
        if (contentType === 'docx' && !_hasBytePrefix(resultBytes, [0x50, 0x4b, 0x03, 0x04])) {
          throw new Error('Azure returned an invalid redacted DOCX');
        }
        if (contentType === 'text') {
          if (resultBytes.includes(0)) throw new Error('Azure returned binary data for a text document');
          new TextDecoder('utf-8', { fatal: true }).decode(resultBytes);
        }

        const entities = result.entities || [];
        const matches = entities.map(e => ({
          typeId: `azure_${(e.category || 'unknown').toLowerCase()}`,
          token: `[REDACTED_${(e.category || 'PII').toUpperCase()}]`,
          original: e.text || '',
          index: e.offset || 0,
          confidence: e.confidenceScore,
        }));

        if (dbg) dbg.log('pipeline', `Azure native doc complete: ${matches.length} entities, ${result.redactedFile.byteLength} bytes`);

        steps.push('azure_native_doc_complete');
        return {
          redacted: `[Azure native document redaction: ${matches.length} entities redacted]`,
          redactedFile: resultBytes,
          redactedFileFormat: mimeMap[contentType],
          engine: 'azure_pii_native',
          tier: 'cloud',
          matches,
          metadata: {
            documentType: contentType,
            extractionMethod: 'azure_native_document',
            jobId: result.jobId,
            redactedFileName: result.redactedFileName,
          },
          pipelineSteps: steps,
          escalated: false,
        };
      } catch (err) {
        steps.push(`azure_native_doc:failed:${err.message}`);
        const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;
        if (dbg) dbg.warn('pipeline', 'Azure native doc failed, falling back to local:', err.message);
        // Fall through to local processing
      }
    }

    // Step 1: Try local text extraction
    steps.push(`extract:${contentType}`);
    const extracted = await processDoc(content, contentType);

    // ZIP archive: extract entries, process each supported file, repack
    if (extracted.requiresZipProcessing) {
      return _processZipArchive(content, options, steps);
    }

    if (!extracted.requiresOffscreen && extracted.text) {
      const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

      // DOCX: use the dedicated redactor that modifies the XML in-place
      // and produces a redacted .docx file (not just redacted text).
      const docxRedact = globalThis.LLSS_redactDocx;
      if (contentType === 'docx' && docxRedact) {
        steps.push('docx_xml_redaction');

        // In cloud_only mode, use the cloud provider for PII detection
        // while still using the DOCX redactor for XML replacement.
        const docxOptions = {};
        if (mode === 'cloud_only') {
          const cloudProviders = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
          for (const provider of cloudProviders) {
            const avail = await registry.checkAvailability(provider.id);
            if (avail.available) {
              docxOptions.redactFn = (text) => redactText(text, {
                ...options,
                forceProvider: provider.id,
              });
              steps.push(`docx_cloud:${provider.id}`);
              break;
            }
          }
        }

        if (dbg) dbg.log('pipeline', `DOCX redactor: processing ${contentType}, mode=${mode}`);
        const docxResult = await docxRedact(content, piiTypes, settings, docxOptions);
        if (dbg) dbg.log('pipeline', `DOCX redactor: ${docxResult.matches?.length} matches, ${docxResult.metadata?.replacements} replacements`);
        return {
          redacted: docxResult.redacted,
          redactedFile: docxResult.redactedFile,
          redactedFileFormat: docxResult.redactedFileFormat,
          engine: docxResult.engine,
          tier: 'local',
          matches: docxResult.matches || [],
          metadata: { ...docxResult.metadata, documentType: contentType },
          pipelineSteps: steps,
          escalated: false,
        };
      }

      // Other text-based formats (XLSX, HTML, Markdown, TXT): text-only redaction.
      // Need structured matches with character positions for match counting.
      steps.push('local_text_extraction');
      if (dbg) {
        dbg.log('pipeline', `Extracted ${extracted.text.length} chars from ${contentType}`);
        dbg.log('pipeline', `PII types: ${options.piiTypes?.length}, mode: ${mode}`);
      }
      const docTextOptions = { ...options };
      if (mode === 'cloud_only') {
        // Let cloud_only mode flow through to the cloud provider
      } else {
        // Default: force regex for structured matches
        docTextOptions.forceProvider = 'regex';
      }
      const textResult = await redactText(extracted.text, docTextOptions);
      if (dbg) dbg.log('pipeline', `Regex result: ${textResult.matches?.length} matches, engine=${textResult.engine}`);
      const outputFormat = contentType === 'xlsx' || contentType === 'csv'
        ? 'text/csv'
        : 'text/plain';
      return {
        ...textResult,
        redactedFile: new TextEncoder().encode(textResult.redacted),
        redactedFileFormat: outputFormat,
        pipelineSteps: [...steps, ...textResult.pipelineSteps],
        metadata: {
          ...textResult.metadata,
          documentType: contentType,
          extractionMethod: 'local',
        },
      };
    }

    // Step 2: Document requires OCR-based processing (PDFs, images)
    // Try local offscreen processing first, then hosted container, then cloud providers
    if (extracted.requiresOffscreen && !options.offscreenProcessor) {
      steps.push('offscreen_ocr:failed:offscreenProcessor not provided to pipeline');
    }
    if (extracted.requiresOffscreen && options.offscreenProcessor) {
      try {
        steps.push(`offscreen_ocr:${contentType}`);
        const ocrResult = await options.offscreenProcessor.renderAndOcr({
          fileData: content,
          contentType,
        });

        if (!ocrResult || !ocrResult.fullText || !ocrResult.fullText.trim()) {
          steps.push(`offscreen_ocr:failed:OCR returned empty text (pages: ${ocrResult?.pages?.length || 0})`);
        } else {
          // Run PII detection on OCR text. Need structured matches with
          // character positions for pixel redaction mapping. Use regex unless
          // cloud_only mode (Azure PII also returns structured matches).
          const ocrTextOptions = { ...options };
          if (mode !== 'cloud_only') {
            ocrTextOptions.forceProvider = 'regex';
          }
          const textResult = await redactText(ocrResult.fullText, ocrTextOptions);

          // A successful inspection with no configured matches can preserve
          // the original file byte-for-byte. Errors and incomplete mappings
          // still fail closed elsewhere in this pipeline.
          if ((textResult.matches || []).length === 0) {
            steps.push('inspection_complete:no_matches');
            return {
              ..._buildResult(textResult, textResult.tier || 'local', steps, false),
              redactedFile: new Uint8Array(content),
              redactedFileFormat: options.verifiedMimeType || (contentType === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
              metadata: {
                ...textResult.metadata,
                documentType: contentType,
                extractionMethod: 'offscreen_ocr',
                inspectedOriginalReleased: true,
                ocrPages: ocrResult.pages.length,
              },
            };
          }

          // Map PII matches back to OCR bounding boxes per page
          const mapFn = globalThis.LLSS_mapMatchesToRegions || (typeof require !== 'undefined' ? require('./documents/pixel-redactor').mapMatchesToRegions : null);
          const pipeDbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

          if (pipeDbg) pipeDbg.log('pipeline', `OCR text PII: ${textResult.matches?.length || 0} matches, mapFn=${!!mapFn}, pages=${ocrResult.pages?.length}`);

          const pageRedactions = [];
          let mappedMatchCount = 0;
          if (mapFn && textResult.matches && textResult.matches.length > 0) {
            for (const page of ocrResult.pages) {
              // Find matches that fall within this page's character range
              const pageMatches = textResult.matches.filter(m =>
                m.index >= page.charStart && m.index < page.charEnd
              ).map(m => ({
                ...m,
                index: m.index - page.charStart, // Make page-relative
              }));

              if (pipeDbg) pipeDbg.log('pipeline', `Page ${page.pageNumber}: ${pageMatches.length} matches in range [${page.charStart},${page.charEnd}), blocks=${page.blocks?.length}`);

              if (pageMatches.length > 0) {
                const regions = mapFn(page.text, page.blocks, pageMatches);
                mappedMatchCount += regions?.length || 0;
                if (pipeDbg) pipeDbg.log('pipeline', `Page ${page.pageNumber}: ${regions?.length || 0} pixel regions mapped`);
                pageRedactions.push({ pageNumber: page.pageNumber, regions });
              }
            }
          } else if (pipeDbg) {
            pipeDbg.log('pipeline', `No pixel redaction: matches=${textResult.matches?.length || 0}, mapFn=${!!mapFn}`);
          }

          if (pipeDbg) pipeDbg.log('pipeline', `Total pageRedactions: ${pageRedactions.length} pages with regions`);

          // Check if we have actual pixel regions to redact
          const hasPixelRegions = textResult.metadata?.hasUnmappableMatches !== true &&
            textResult.matches.length > 0 &&
            mappedMatchCount === textResult.matches.length &&
            pageRedactions.some(pr => pr.regions && pr.regions.length > 0);

          if (hasPixelRegions) {
            // Apply pixel redactions and reconstruct the document
            const outputFormat = contentType === 'pdf' ? 'pdf' : 'image/png';
            const redactedDoc = await options.offscreenProcessor.applyRedactions({
              pageRedactions,
              outputFormat,
            });

            steps.push('offscreen_redaction_applied');
            return {
              redacted: textResult.redacted,
              redactedFile: redactedDoc.file,
              redactedFileFormat: redactedDoc.format,
              engine: textResult.engine,
              tier: 'local',
              matches: textResult.matches || [],
              metadata: {
                ...textResult.metadata,
                documentType: contentType,
                extractionMethod: 'offscreen_ocr',
                pageCount: redactedDoc.pageCount,
                ocrPages: ocrResult.pages.length,
              },
              pipelineSteps: steps,
              escalated: false,
            };
          }

          // No pixel regions (e.g., PDF text extraction without bounding boxes)
          // — return redacted text as a .txt file so the upload flow has a file object
          steps.push('text_redaction_only');
          const redactedTextBytes = new TextEncoder().encode(textResult.redacted);
          return {
            redacted: textResult.redacted,
            redactedFile: redactedTextBytes,
            redactedFileFormat: 'text/plain',
            engine: textResult.engine,
            tier: 'local',
            matches: textResult.matches || [],
            metadata: {
              ...textResult.metadata,
              documentType: contentType,
              extractionMethod: 'text_extraction',
              ocrPages: ocrResult.pages.length,
            },
            pipelineSteps: steps,
            escalated: false,
          };
        }
      } catch (err) {
        steps.push(`offscreen_ocr:failed:${err.message}`);
        // Fall through to hosted/cloud providers
      }
    }

    // Step 3: Try hosted container OCR or hosted/cloud document providers
    steps.push(`provider_required:${contentType}`);

    // Try hosted OCR extract providers first
    const hostedOcr = registry.getByTier('hosted').filter(p =>
      p.enabled && p.settings?.apiMode === 'ocr_extract'
    );
    for (const provider of hostedOcr) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        try {
          steps.push(`hosted_ocr:${provider.id}`);
          const ocrResult = await provider.extractOcr(content, contentType);

          if (ocrResult.fullText && ocrResult.fullText.trim()) {
            // PII detection on extracted text
            const textResult = await redactText(ocrResult.fullText, options);

            if ((textResult.matches || []).length === 0) {
              steps.push('inspection_complete:no_matches');
              return {
                ..._buildResult(textResult, 'hosted', steps, true),
                redactedFile: new Uint8Array(content),
                redactedFileFormat: options.verifiedMimeType || (contentType === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
                metadata: {
                  ...textResult.metadata,
                  documentType: contentType,
                  extractionMethod: 'hosted_ocr',
                  inspectedOriginalReleased: true,
                },
              };
            }

            // If we have an offscreen processor, use it for pixel redaction
            if (options.offscreenProcessor) {
              const mapFn = globalThis.LLSS_mapMatchesToRegions || (typeof require !== 'undefined' ? require('./documents/pixel-redactor').mapMatchesToRegions : null);
              // Render locally first. Hosted OCR coordinates can use a
              // different DPI, so every region must be scaled into the exact
              // canvas dimensions that will receive the redaction.
              const renderOcr = await options.offscreenProcessor.renderAndOcr({
                fileData: content,
                contentType,
              });
              const targetPages = new Map((renderOcr.pages || []).map((page) => [page.pageNumber, page]));
              const pageRedactions = [];
              let mappedMatchCount = 0;
              let mappingUnsafe = false;
              if (mapFn && textResult.matches && textResult.matches.length > 0) {
                for (const page of ocrResult.pages) {
                  const pageMatches = textResult.matches.filter(m =>
                    m.index >= page.charStart && m.index < page.charEnd
                  ).map(m => ({ ...m, index: m.index - page.charStart }));

                  if (pageMatches.length > 0) {
                    const regions = mapFn(page.text, page.blocks, pageMatches);
                    const targetPage = targetPages.get(page.pageNumber);
                    const sourceWidth = Number(page.width);
                    const sourceHeight = Number(page.height);
                    const targetWidth = Number(targetPage?.width);
                    const targetHeight = Number(targetPage?.height);
                    if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 ||
                        !Number.isFinite(sourceHeight) || sourceHeight <= 0 ||
                        !Number.isFinite(targetWidth) || targetWidth <= 0 ||
                        !Number.isFinite(targetHeight) || targetHeight <= 0) {
                      mappingUnsafe = true;
                      continue;
                    }
                    const scaledRegions = (regions || []).map((region) => {
                      const x1 = Math.max(0, Math.floor(Number(region.x) * targetWidth / sourceWidth));
                      const y1 = Math.max(0, Math.floor(Number(region.y) * targetHeight / sourceHeight));
                      const x2 = Math.min(targetWidth, Math.ceil((Number(region.x) + Number(region.w)) * targetWidth / sourceWidth));
                      const y2 = Math.min(targetHeight, Math.ceil((Number(region.y) + Number(region.h)) * targetHeight / sourceHeight));
                      if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
                      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
                    }).filter(Boolean);
                    if (scaledRegions.length !== (regions || []).length) mappingUnsafe = true;
                    mappedMatchCount += scaledRegions.length;
                    pageRedactions.push({
                      pageNumber: page.pageNumber,
                      regions: scaledRegions,
                    });
                  }
                }
              }

              if (mappingUnsafe || textResult.metadata?.hasUnmappableMatches === true ||
                  (textResult.matches?.length > 0 && mappedMatchCount !== textResult.matches.length)) {
                const redactedTextBytes = new TextEncoder().encode(textResult.redacted);
                return {
                  ..._buildResult(textResult, 'hosted', [...steps, 'text_redaction_only'], true),
                  redactedFile: redactedTextBytes,
                  redactedFileFormat: 'text/plain',
                  metadata: { documentType: contentType, extractionMethod: 'hosted_text_fallback' },
                };
              }
              const outputFormat = contentType === 'pdf' ? 'pdf' : 'image/png';
              const redactedDoc = await options.offscreenProcessor.applyRedactions({
                pageRedactions,
                outputFormat,
              });

              return {
                redacted: textResult.redacted,
                redactedFile: redactedDoc.file,
                redactedFileFormat: redactedDoc.format,
                engine: textResult.engine,
                tier: 'hosted',
                matches: textResult.matches || [],
                metadata: { documentType: contentType, extractionMethod: 'hosted_ocr', pageCount: redactedDoc.pageCount },
                pipelineSteps: steps,
                escalated: true,
              };
            }

            // No offscreen processor — return text-only result
            return _buildResult(textResult, 'hosted', steps, true);
          }
        } catch (err) {
          steps.push(`hosted_ocr:${provider.id}:failed:${err.message}`);
        }
      }
    }

    // Try other hosted/cloud providers that support document redaction directly
    const candidates = registry.getForContentType(contentType)
      .filter(p => p.enabled && p.tier !== 'local' && p.settings?.apiMode !== 'ocr_extract');

    for (const provider of candidates) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        try {
          steps.push(`document:${provider.id}`);
          const result = await provider.redactDocument(content, contentType, piiTypes, settings);
          return _buildResult(result, provider.tier, steps, true);
        } catch (err) {
          steps.push(`document:${provider.id}:failed:${err.message}`);
        }
      }
    }

    // Include the actual failure reasons and full pipeline trace
    const failures = steps.filter(s => s.includes(':failed:'));
    const reason = failures.length > 0
      ? failures.map(f => f.split(':failed:')[1]).join('; ')
      : 'No provider could process the document';
    throw new Error(`Document processing failed (${contentType}): ${reason}. Steps: [${steps.join(' → ')}]`);
  }

  /**
   * Regex-only pipeline.
   */
  async function _runRegexPipeline(text, registry, piiTypes, settings, steps) {
    const regexProvider = registry.get('regex');
    if (!regexProvider) throw new Error('Regex provider not available');

    steps.push('regex_only');
    const result = await regexProvider.redactText(text, piiTypes, settings);
    return _buildResult(result, 'local', steps, false);
  }

  /**
   * AI-only pipeline — tries all AI providers in tier order.
   */
  async function _runAiOnlyPipeline(text, registry, piiTypes, settings, steps) {
    // Try local AI first
    const localAi = registry.get('local_ai');
    if (localAi && localAi.enabled) {
      const avail = await registry.checkAvailability('local_ai');
      if (avail.available) {
        steps.push('ai_only:local_ai');
        const result = await localAi.redactText(text, piiTypes, settings);
        const safeResult = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
        return _buildResult(safeResult, 'local', steps, false);
      }
    }

    // Try hosted AI
    const hostedAi = registry.getByTier('hosted').filter(p => p.enabled && p.supports('text'));
    for (const provider of hostedAi) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        steps.push(`ai_only:hosted:${provider.id}`);
        const result = await provider.redactText(text, piiTypes, settings);
        const safeResult = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
        return _buildResult(safeResult, 'hosted', steps, true);
      }
    }

    // Try cloud AI
    const cloudAi = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
    for (const provider of cloudAi) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        steps.push(`ai_only:cloud:${provider.id}`);
        const result = await provider.redactText(text, piiTypes, settings);
        const safeResult = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
        return _buildResult(safeResult, 'cloud', steps, true);
      }
    }

    throw new Error('AI mode selected but no AI providers are available');
  }

  /**
   * Cloud-only pipeline — sends text directly to enabled cloud providers (Azure PII).
   * Falls back to regex if no cloud providers are available.
   */
  async function _runCloudOnlyPipeline(text, registry, piiTypes, settings, steps) {
    const cloudProviders = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
    for (const provider of cloudProviders) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        try {
          steps.push(`cloud_only:${provider.id}`);
          const result = await provider.redactText(text, piiTypes, settings);

          const merged = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
          return _buildResult(merged, 'cloud', steps, false);
        } catch (err) {
          steps.push(`cloud_only:${provider.id}:failed:${err.message}`);
        }
      }
    }

    // Fallback to regex if no cloud providers available
    steps.push('cloud_unavailable:regex_fallback');
    return _runRegexPipeline(text, registry, piiTypes, settings, steps);
  }

  /**
   * Hosted-only pipeline — sends text to organisation-hosted models.
   * Falls back to regex if no hosted providers are available.
   */
  async function _runHostedOnlyPipeline(text, registry, piiTypes, settings, steps) {
    const hostedProviders = registry.getByTier('hosted').filter(p => p.enabled && p.supports('text'));
    for (const provider of hostedProviders) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        try {
          steps.push(`hosted_only:${provider.id}`);
          const result = await provider.redactText(text, piiTypes, settings);

          const merged = await _applyRegexPass(text, registry, piiTypes, settings, result, steps);
          return _buildResult(merged, 'hosted', steps, false);
        } catch (err) {
          steps.push(`hosted_only:${provider.id}:failed:${err.message}`);
        }
      }
    }

    // Fallback to regex
    steps.push('hosted_unavailable:regex_fallback');
    return _runRegexPipeline(text, registry, piiTypes, settings, steps);
  }

  /**
   * Run regex independently against the original text, keeping coordinates
   * suitable for document redaction. If a provider supplies an unlocatable
   * match, keep its already-redacted output but mark the result so visual-file
   * pipelines fall back to text instead of releasing partial pixel redaction.
   */
  async function _applyRegexPass(originalText, registry, piiTypes, settings, priorResult, steps) {
    const regexProvider = registry.get('regex');
    if (!regexProvider || !regexProvider.enabled) return priorResult;

    steps.push('regex_after_ai');
    const regexResult = await regexProvider.redactText(originalText, piiTypes, settings);
    const rawMatches = [...(priorResult.matches || []), ...(regexResult.matches || [])];
    const locatableMatches = rawMatches.filter((match) =>
      Number.isInteger(match?.index) &&
      match.index >= 0 &&
      typeof match.original === 'string' &&
      match.original.length > 0 &&
      originalText.slice(match.index, match.index + match.original.length) === match.original
    );
    const deduped = _deduplicateMatches(locatableMatches);
    const priorUnmappable = Number(priorResult.metadata?.unmappableMatchCount) || 0;
    const unmappableMatchCount = priorUnmappable + (rawMatches.length - locatableMatches.length);

    let redacted;
    let appliedMatches = deduped;
    const applyFn = globalThis.LLSS_applyEntityMatches;
    if (unmappableMatchCount === 0 && applyFn) {
      const applied = applyFn(originalText, deduped);
      redacted = applied.redacted;
      appliedMatches = applied.matches;
    } else {
      // Preserve the provider's redactions, then catch deterministic patterns
      // it missed. Coordinates are retained from the original-text pass above.
      const cascaded = await regexProvider.redactText(priorResult.redacted, piiTypes, settings);
      redacted = cascaded.redacted;
    }

    return {
      redacted,
      engine: `${priorResult.engine}+regex`,
      matches: appliedMatches,
      metadata: {
        ...priorResult.metadata,
        regexPassApplied: true,
        hasUnmappableMatches: unmappableMatchCount > 0,
        unmappableMatchCount,
      },
    };
  }

  /**
   * Process a ZIP archive: extract entries, redact each supported file,
   * repack with redacted contents.
   */
  async function _processZipArchive(content, options, steps) {
    const parseZip = globalThis.LLSS_parseZipEntries;
    const buildZipFn = globalThis.LLSS_buildZip;
    const detectType = globalThis.LLSS_detectContentType;
    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    if (!parseZip || !buildZipFn) throw new Error('ZIP processing not available');

    steps.push('zip_extract');
    const entries = await parseZip(content);

    if (dbg) dbg.log('pipeline', `ZIP archive: ${entries.length} entries`);

    const allMatches = [];
    const redactedEntries = [];
    let totalRedacted = 0;
    const safeTextTypes = new Set(['text', 'csv', 'html', 'markdown']);

    for (const entry of entries) {
      if (entry.name.endsWith('/')) {
        redactedEntries.push(entry);
        continue;
      }
      const entryType = detectType ? detectType(entry.name) : null;

      if (safeTextTypes.has(entryType)) {
        // Text-based file — redact it
        try {
          if (entry.data.includes(0)) throw new Error('binary content detected');
              const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
          const textResult = await redactText(text, {
            ...options,
            forceProvider: 'regex',
          });

          if (textResult.matches && textResult.matches.length > 0) {
            totalRedacted++;
            for (const m of textResult.matches) {
              allMatches.push({ ...m, zipEntry: entry.name });
            }
          }

          // Store redacted content
          redactedEntries.push({
            name: entry.name,
            data: new TextEncoder().encode(textResult.redacted),
          });

          if (dbg) dbg.log('pipeline', `  ${entry.name}: ${textResult.matches?.length || 0} matches`);
        } catch (err) {
          throw new Error(`Could not safely process ZIP entry "${entry.name}": ${err.message}`);
        }
      } else {
        throw new Error(`ZIP entry "${entry.name}" uses an unsupported format`);
      }
    }

    // Rebuild ZIP
    const redactedZip = await buildZipFn(redactedEntries);

    if (dbg) dbg.log('pipeline', `ZIP complete: ${allMatches.length} total matches across ${totalRedacted} files`);

    steps.push('zip_repack');
    return {
      redacted: `[ZIP archive: ${allMatches.length} PII items redacted across ${totalRedacted} files]`,
      redactedFile: redactedZip,
      redactedFileFormat: 'application/zip',
      engine: 'regex',
      tier: 'local',
      matches: allMatches,
      metadata: {
        documentType: 'zip',
        extractionMethod: 'zip_archive',
        entriesTotal: entries.length,
        entriesRedacted: totalRedacted,
      },
      pipelineSteps: steps,
      escalated: false,
    };
  }

  /**
   * Deduplicate overlapping matches from merged provider results.
   * Keeps the first match at each position (higher priority from earlier providers).
   */
  function _deduplicateMatches(matches) {
    if (!matches || matches.length === 0) return [];
    const sorted = [...matches].sort((a, b) => (a.index || 0) - (b.index || 0));
    const result = [];
    let lastEnd = -1;
    for (const m of sorted) {
      const start = m.index || 0;
      const end = start + (m.original?.length || 0);
      if (start >= lastEnd) {
        result.push(m);
        lastEnd = end;
      }
    }
    return result;
  }

  function _hasBytePrefix(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
  }

  function _buildResult(providerResult, tier, steps, escalated) {
    return {
      redacted: providerResult.redacted,
      engine: providerResult.engine,
      tier: tier,
      matches: providerResult.matches || [],
      metadata: providerResult.metadata || {},
      pipelineSteps: steps,
      escalated,
    };
  }

  // Exports
  const exports = { redactText, redactDocument };

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_pipelineRedactText = redactText;
    globalThis.LLSS_pipelineRedactDocument = redactDocument;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
