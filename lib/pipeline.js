/**
 * Progressive Processing Pipeline
 *
 * Implements the architectural rule: LOCAL → HOSTED → CLOUD
 *
 * For text: Local AI (Gemini Nano) → Regex+Vector → Hosted Model → Azure PII / Purview
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
      return _buildResult(result, provider.tier, steps, false);
    }

    // Force specific tier
    if (options.forceTier) {
      const provider = await registry.findBestProvider('text', { preferredTier: options.forceTier });
      if (!provider) throw new Error(`No available provider in tier '${options.forceTier}'`);

      steps.push(`tier:${options.forceTier}:${provider.id}`);
      result = await provider.redactText(text, piiTypes, settings);
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

    // Auto mode — progressive escalation: local → hosted → cloud
    // Step 1: Try local AI (Gemini Nano)
    const localAi = registry.get('local_ai');
    if (localAi && localAi.enabled) {
      const avail = await registry.checkAvailability('local_ai');
      if (avail.available) {
        try {
          steps.push('local_ai');
          result = await localAi.redactText(text, piiTypes, settings);

          // Belt-and-suspenders: also run regex
          if (settings.regexAfterAi) {
            result = await _applyRegexPass(result.redacted, registry, piiTypes, settings, result, steps);
          }
          return _buildResult(result, 'local', steps, false);
        } catch (err) {
          steps.push(`local_ai:failed:${err.message}`);
        }
      }
    }

    // Step 2: Try regex (always local, always available)
    const regexProvider = registry.get('regex');
    if (regexProvider && regexProvider.enabled) {
      steps.push('regex_fallback');
      result = await regexProvider.redactText(text, piiTypes, settings);
      escalated = true;
    }

    // Step 3: Try hosted models if available (for potentially better quality)
    const hostedProviders = registry.getByTier('hosted').filter(p => p.enabled && p.supports('text'));
    for (const hosted of hostedProviders) {
      const avail = await registry.checkAvailability(hosted.id);
      if (avail.available) {
        try {
          steps.push(`hosted:${hosted.id}`);
          const hostedResult = await hosted.redactText(
            result ? result.redacted : text,
            piiTypes,
            settings
          );
          // Merge matches
          if (result) {
            hostedResult.matches = [...(result.matches || []), ...(hostedResult.matches || [])];
          }
          result = hostedResult;
          escalated = true;
          break;
        } catch (err) {
          steps.push(`hosted:${hosted.id}:failed:${err.message}`);
        }
      }
    }

    // If we still have no result, try cloud providers
    if (!result) {
      const cloudProviders = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
      for (const cloud of cloudProviders) {
        const avail = await registry.checkAvailability(cloud.id);
        if (avail.available) {
          try {
            steps.push(`cloud:${cloud.id}`);
            result = await cloud.redactText(text, piiTypes, settings);
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

    return _buildResult(result, result.engine, steps, escalated);
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
        const result = await azureNativeDoc.redactDocument(
          content,
          options.fileName || `document.${contentType === 'text' ? 'txt' : contentType}`,
          mimeMap[contentType] || 'application/octet-stream',
          azurePiiConfig,
          {
            sourceContainerUrl: azurePiiConfig.sourceContainerUrl,
            targetContainerUrl: azurePiiConfig.targetContainerUrl,
            redactionPolicy: azurePiiConfig.redactionPolicy || 'entityMask',
          }
        );

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
          redactedFile: Array.from(new Uint8Array(result.redactedFile)),
          redactedFileFormat: result.contentType,
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
              docxOptions.redactFn = (text, types) => provider.redactText(text, types, settings);
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
        dbg.log('pipeline', `Text preview: "${extracted.text.substring(0, 300)}"`);
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
      return {
        ...textResult,
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
          fileData: Array.from(new Uint8Array(content)),
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

          // Map PII matches back to OCR bounding boxes per page
          const mapFn = globalThis.LLSS_mapMatchesToRegions || (typeof require !== 'undefined' ? require('./documents/pixel-redactor').mapMatchesToRegions : null);
          const pipeDbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

          if (pipeDbg) pipeDbg.log('pipeline', `OCR text PII: ${textResult.matches?.length || 0} matches, mapFn=${!!mapFn}, pages=${ocrResult.pages?.length}`);

          const pageRedactions = [];
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
                if (pipeDbg) pipeDbg.log('pipeline', `Page ${page.pageNumber}: ${regions?.length || 0} pixel regions mapped`);
                pageRedactions.push({ pageNumber: page.pageNumber, regions });
              }
            }
          } else if (pipeDbg) {
            pipeDbg.log('pipeline', `No pixel redaction: matches=${textResult.matches?.length || 0}, mapFn=${!!mapFn}`);
          }

          if (pipeDbg) pipeDbg.log('pipeline', `Total pageRedactions: ${pageRedactions.length} pages with regions`);

          // Check if we have actual pixel regions to redact
          const hasPixelRegions = pageRedactions.some(pr => pr.regions && pr.regions.length > 0);

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
            redactedFile: Array.from(redactedTextBytes),
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

            // If we have an offscreen processor, use it for pixel redaction
            if (options.offscreenProcessor) {
              const mapFn = globalThis.LLSS_mapMatchesToRegions || (typeof require !== 'undefined' ? require('./documents/pixel-redactor').mapMatchesToRegions : null);
              const pageRedactions = [];
              if (mapFn && textResult.matches && textResult.matches.length > 0) {
                for (const page of ocrResult.pages) {
                  const pageMatches = textResult.matches.filter(m =>
                    m.index >= page.charStart && m.index < page.charEnd
                  ).map(m => ({ ...m, index: m.index - page.charStart }));

                  if (pageMatches.length > 0) {
                    pageRedactions.push({
                      pageNumber: page.pageNumber,
                      regions: mapFn(page.text, page.blocks, pageMatches),
                    });
                  }
                }
              }

              // Render locally and apply redactions
              const renderOcr = await options.offscreenProcessor.renderAndOcr({
                fileData: Array.from(new Uint8Array(content)),
                contentType,
              });
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
        return _buildResult(result, 'local', steps, false);
      }
    }

    // Try hosted AI
    const hostedAi = registry.getByTier('hosted').filter(p => p.enabled && p.supports('text'));
    for (const provider of hostedAi) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        steps.push(`ai_only:hosted:${provider.id}`);
        const result = await provider.redactText(text, piiTypes, settings);
        return _buildResult(result, 'hosted', steps, true);
      }
    }

    // Try cloud AI
    const cloudAi = registry.getByTier('cloud').filter(p => p.enabled && p.supports('text'));
    for (const provider of cloudAi) {
      const avail = await registry.checkAvailability(provider.id);
      if (avail.available) {
        steps.push(`ai_only:cloud:${provider.id}`);
        const result = await provider.redactText(text, piiTypes, settings);
        return _buildResult(result, 'cloud', steps, true);
      }
    }

    throw new Error('AI mode selected but no AI providers are available');
  }

  /**
   * Cloud-only pipeline — sends text directly to cloud providers (Azure PII, Purview).
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

          // Belt-and-suspenders: also run regex if enabled
          if (settings.regexAfterAi) {
            const merged = await _applyRegexPass(result.redacted, registry, piiTypes, settings, result, steps);
            return _buildResult(merged, 'cloud', steps, false);
          }
          return _buildResult(result, 'cloud', steps, false);
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
   * Run regex as a second pass over already-redacted text (belt-and-suspenders).
   */
  async function _applyRegexPass(text, registry, piiTypes, settings, priorResult, steps) {
    const regexProvider = registry.get('regex');
    if (!regexProvider || !regexProvider.enabled) return priorResult;

    steps.push('regex_after_ai');
    const regexResult = await regexProvider.redactText(text, piiTypes, settings);

    return {
      redacted: regexResult.redacted,
      engine: `${priorResult.engine}+regex`,
      matches: [...(priorResult.matches || []), ...(regexResult.matches || [])],
      metadata: { ...priorResult.metadata, regexPassApplied: true },
    };
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
