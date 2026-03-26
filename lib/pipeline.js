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
    const steps = [];
    const processDoc = globalThis.LLSS_processDocument || (typeof require !== 'undefined' ? require('./documents/document-processor').processDocument : null);

    if (!processDoc) throw new Error('Document processor not available');

    // Step 1: Try local text extraction
    steps.push(`extract:${contentType}`);
    const extracted = await processDoc(content, contentType);

    if (!extracted.requiresOffscreen && extracted.text) {
      // Text was extracted locally — now redact the text through the text pipeline
      steps.push('local_text_extraction');
      const textResult = await redactText(extracted.text, options);
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
          // Run PII detection on the extracted text.
          // IMPORTANT: Force regex provider for document processing because we
          // need structured matches with character positions (index) to map PII
          // back to bounding boxes for pixel redaction. Nano/AI providers return
          // matches: [] (no position data), which makes pixel redaction impossible.
          const textResult = await redactText(ocrResult.fullText, {
            ...options,
            forceProvider: 'regex',
          });

          // Map PII matches back to OCR bounding boxes per page
          const mapFn = globalThis.LLSS_mapMatchesToRegions || (typeof require !== 'undefined' ? require('./documents/pixel-redactor').mapMatchesToRegions : null);

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

              if (pageMatches.length > 0) {
                const regions = mapFn(page.text, page.blocks, pageMatches);
                pageRedactions.push({ pageNumber: page.pageNumber, regions });
              }
            }
          }

          // Apply pixel redactions and reconstruct the document
          const outputFormat = contentType === 'pdf' ? 'pdf' : 'image/png';
          const redactedDoc = await options.offscreenProcessor.applyRedactions({
            pageRedactions,
            outputFormat,
          });

          steps.push('offscreen_redaction_applied');
          return {
            redacted: textResult.redacted, // Redacted text for display
            redactedFile: redactedDoc.file, // Redacted file bytes
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
