// redact.js — Standalone document redaction tool.
// Opens as a full tab from the popup. Handles file selection, processing
// via REDACT_DOCUMENT messages, progress display, and file download.

(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  const files = [];     // { id, file, status, result, error }
  let processing = false;
  let nextId = 0;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_QUEUE_FILES = 50;

  // ── DOM refs ───────────────────────────────────────────────────────────

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const btnBrowse = document.getElementById('btn-browse');
  const btnProcess = document.getElementById('btn-process');
  const btnClear = document.getElementById('btn-clear');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const queueSection = document.getElementById('queue-section');
  const fileList = document.getElementById('file-list');
  const summarySection = document.getElementById('summary-section');
  const summaryContent = document.getElementById('summary-content');
  const providerStatus = document.getElementById('provider-status');
  const queueAnnouncement = document.getElementById('queue-announcement');

  function announce(message) {
    queueAnnouncement.textContent = '';
    requestAnimationFrame(() => { queueAnnouncement.textContent = message; });
  }

  // ── Provider status ────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response?.providers?.length) {
      providerStatus.textContent = 'Local protection available';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const provider of response.providers) {
      const tag = document.createElement('span');
      tag.className = 'provider-tag';
      tag.setAttribute('aria-label', `${provider.name || 'Provider'}: ${provider.available ? 'available' : 'unavailable'}`);
      const statusDot = document.createElement('span');
      statusDot.className = `dot ${provider.available ? 'on' : 'off'}`;
      statusDot.setAttribute('aria-hidden', 'true');
      tag.append(statusDot, document.createTextNode(provider.name || 'Provider'));
      fragment.appendChild(tag);
    }
    providerStatus.replaceChildren(fragment);
  });

  // ── File type helpers ──────────────────────────────────────────────────

  const TYPE_ICONS = {
    docx: '\u{1F4C4}', xlsx: '\u{1F4CA}', pdf: '\u{1F4D1}',
    image: '\u{1F5BC}', html: '\u{1F310}', markdown: '\u{1F4DD}', text: '\u{1F4C3}',
  };

  const MIME_EXT_MAP = {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/zip': '.zip',
  };

  function detectType(file) {
    if (typeof LLSS_detectContentType !== 'undefined') {
      return LLSS_detectContentType(file.name, file.type);
    }
    return null;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ── File management ────────────────────────────────────────────────────

  function addFiles(newFiles) {
    if (processing) {
      announce('Wait for the current redaction to finish before adding files.');
      return;
    }
    let added = 0;
    let unsupported = 0;
    let oversized = 0;
    let duplicates = 0;
    for (const file of newFiles) {
      if (files.length >= MAX_QUEUE_FILES) break;
      const contentType = detectType(file);
      if (!contentType) {
        unsupported++;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        oversized++;
        continue;
      }
      const duplicate = files.some((entry) => entry.file.name === file.name
        && entry.file.size === file.size
        && entry.file.lastModified === file.lastModified);
      if (duplicate) {
        duplicates++;
        continue;
      }
      files.push({
        id: nextId++,
        file,
        contentType,
        status: 'pending',
        result: null,
        error: null,
      });
      added++;
    }
    renderQueue();

    const notes = [];
    if (added) notes.push(`${added} ${added === 1 ? 'file' : 'files'} added`);
    if (oversized) notes.push(`${oversized} over the 25 MB limit`);
    if (unsupported) notes.push(`${unsupported} unsupported`);
    if (duplicates) notes.push(`${duplicates} already in the queue`);
    if (files.length >= MAX_QUEUE_FILES && added < newFiles.length) notes.push(`queue limited to ${MAX_QUEUE_FILES} files`);
    announce(notes.length ? notes.join('; ') : 'No supported files were added.');
  }

  function removeFile(id) {
    const idx = files.findIndex(f => f.id === id);
    if (idx >= 0 && files[idx].status === 'pending') {
      files.splice(idx, 1);
      renderQueue();
    }
  }

  function clearFiles() {
    if (processing) return;
    files.length = 0;
    renderQueue();
    summarySection.hidden = true;
    announce('File queue cleared.');
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderQueue() {
    queueSection.hidden = files.length === 0;
    btnProcess.disabled = processing || files.every(f => f.status !== 'pending');
    btnClear.disabled = processing;
    btnBrowse.disabled = processing;
    fileInput.disabled = processing;
    dropZone.setAttribute('aria-disabled', String(processing));
    dropZone.tabIndex = processing ? -1 : 0;

    fileList.innerHTML = files.map(f => {
      const icon = TYPE_ICONS[f.contentType] || '\u{1F4C4}';
      const statusCls = f.status;
      let statusText = '';
      let actions = '';
      let result = '';

      switch (f.status) {
        case 'pending':
          statusText = 'Pending';
          actions = `<button class="btn-sm" type="button" data-remove="${f.id}" aria-label="Remove ${escapeHtml(f.file.name)}">Remove</button>`;
          break;
        case 'processing':
          statusText = '<span class="spinner" aria-hidden="true"></span> Processing…';
          break;
        case 'done':
          statusText = `${f.result?.matchCount || 0} PII found`;
          if (f.result?.redactedFileBase64) {
            actions = `<button class="btn-sm btn-success" type="button" data-download="${f.id}" aria-label="Download redacted ${escapeHtml(f.file.name)}">Download</button>`;
          }
          result = renderResult(f);
          break;
        case 'error':
          statusText = 'Error';
          result = `<div class="file-result"><span class="result-error">${escapeHtml(f.error)}</span></div>`;
          break;
      }

      return `<li class="file-item" data-id="${f.id}">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.file.name)}</div>
          <div class="file-meta">${escapeHtml(f.contentType.toUpperCase())} &middot; ${formatSize(f.file.size)}</div>
          ${f.status === 'processing' ? '<div class="file-progress" role="progressbar" aria-label="Processing ' + escapeHtml(f.file.name) + '"><div class="file-progress-fill" id="progress-' + f.id + '"></div></div>' : ''}
          ${result}
        </div>
        <span class="file-status ${statusCls}">${statusText}</span>
        <div class="file-actions">${actions}</div>
      </li>`;
    }).join('');

    // Wire up buttons
    fileList.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.remove)));
    });
    fileList.querySelectorAll('[data-download]').forEach(btn => {
      btn.addEventListener('click', () => downloadFile(parseInt(btn.dataset.download)));
    });
    fileList.querySelectorAll('[data-toggle-preview]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pre = document.getElementById(`preview-${btn.dataset.togglePreview}`);
        if (pre) {
          pre.hidden = !pre.hidden;
          btn.setAttribute('aria-expanded', String(!pre.hidden));
          btn.textContent = pre.hidden ? 'Show preview' : 'Hide preview';
        }
      });
    });
  }

  function renderResult(f) {
    if (!f.result) return '';
    const r = f.result;
    const meta = [];
    if (r.engine) meta.push(`Engine: ${r.engine}`);
    if (r.tier) meta.push(`Tier: ${r.tier}`);
    if (r.pipelineSteps) meta.push(`Steps: ${r.pipelineSteps.join(' > ')}`);

    let preview = '';
    if (r.redacted) {
      preview = `<button class="btn-sm" type="button" data-toggle-preview="${f.id}" aria-controls="preview-${f.id}" aria-expanded="false">Show preview</button>
        <div class="file-result-preview" id="preview-${f.id}" hidden>${escapeHtml(r.redacted.substring(0, 2000))}${r.redacted.length > 2000 ? '\n...' : ''}</div>`;
    }

    return `<div class="file-result">
      <div class="file-result-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}</div>
      <p class="result-note">${escapeHtml(LLSS_ScanStatus.describe(r.coverage).detail)}</p>
      ${r.redactedFileBase64 ? '<span class="result-ready">Redacted file ready</span>' : '<span class="result-note">Text-only redaction (no file modification for this format)</span>'}
      ${preview}
    </div>`;
  }

  function renderSummary() {
    const done = files.filter(f => f.status === 'done');
    const errors = files.filter(f => f.status === 'error');
    const totalMatches = done.reduce((sum, f) => sum + (f.result?.matchCount || 0), 0);
    const withFiles = done.filter(f => f.result?.redactedFileBase64);

    summarySection.hidden = false;
    summaryContent.innerHTML = `
      <div class="summary-stat"><div class="value">${done.length}</div><div class="label">Processed</div></div>
      <div class="summary-stat"><div class="value">${totalMatches}</div><div class="label">PII Found</div></div>
      <div class="summary-stat"><div class="value">${errors.length}</div><div class="label">Errors</div></div>
    `;

    btnDownloadAll.hidden = withFiles.length < 2;
  }

  // ── Processing ─────────────────────────────────────────────────────────

  async function processAll() {
    if (processing) return;
    processing = true;
    btnProcess.disabled = true;
    summarySection.hidden = true;

    // Keep service worker alive via port
    let port = null;
    try {
      port = chrome.runtime.connect({ name: 'doc-processing' });
    } catch (_) {}

    const pending = files.filter(f => f.status === 'pending');

    try {
      for (const [index, entry] of pending.entries()) {
        entry.status = 'processing';
        announce(`Redacting ${entry.file.name}, file ${index + 1} of ${pending.length}.`);
        renderQueue();

        try {
          // Reject before reading the Blob so an unexpectedly large file cannot
          // cause a full in-memory allocation.
          if (entry.file.size > MAX_FILE_BYTES) throw new Error('File exceeds the 25 MB limit.');
          const buffer = await entry.file.arrayBuffer();
          const data = LLSS_BinaryTransfer.toBase64(buffer, MAX_FILE_BYTES);

          const response = await chrome.runtime.sendMessage({
            type: 'REDACT_DOCUMENT',
            fileDataBase64: data,
            fileName: entry.file.name,
            mimeType: entry.file.type,
          });

          if (!response?.success) {
            throw new Error(response?.error || 'Processing failed');
          }

          entry.status = 'done';
          entry.result = response;
          announce(`${entry.file.name} redacted. ${response.matchCount || 0} sensitive items found.`);
        } catch (err) {
          entry.status = 'error';
          entry.error = err?.message || String(err);
          announce(`${entry.file.name} could not be redacted.`);
        }

        renderQueue();
      }
    } finally {
      if (port) {
        try { port.disconnect(); } catch (_) {}
      }
      processing = false;
      renderQueue();
      renderSummary();
      const failed = pending.filter((entry) => entry.status === 'error').length;
      announce(`Redaction complete. ${pending.length - failed} succeeded${failed ? ` and ${failed} failed` : ''}.`);
    }
  }

  // ── Download ───────────────────────────────────────────────────────────

  function downloadFile(id) {
    const entry = files.find(f => f.id === id);
    if (!entry?.result?.redactedFileBase64) return;

    try {
      const r = entry.result;
      const bytes = LLSS_BinaryTransfer.fromBase64(r.redactedFileBase64, MAX_FILE_BYTES);
      const format = r.redactedFileFormat || entry.file.type;
      const ext = MIME_EXT_MAP[format] || entry.file.name.match(/\.[^.]+$/)?.[0] || '';
      const baseName = entry.file.name.replace(/\.[^.]+$/, '');

      const blob = new Blob([bytes], { type: format });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_redacted${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      announce(`Downloading redacted ${entry.file.name}.`);
    } catch {
      announce(`${entry.file.name} could not be downloaded. Redact it again and retry.`);
    }
  }

  function downloadAll() {
    const withFiles = files.filter(f => f.status === 'done' && f.result?.redactedFileBase64);
    for (const entry of withFiles) {
      downloadFile(entry.id);
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  // Drop zone
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
  });
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.target !== dropZone || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    fileInput.click();
  });
  btnBrowse.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  // Actions
  btnProcess.addEventListener('click', processAll);
  btnClear.addEventListener('click', clearFiles);
  btnDownloadAll.addEventListener('click', downloadAll);

  // ── On-device dictation ─────────────────────────────────────────────────
  // Transcribes microphone input locally, then redacts the transcript through
  // the normal pipeline. Audio stays on the device. Uses whichever on-device
  // engine is genuinely ready: Web Speech (streaming) when available, else
  // Prompt API audio (record-then-transcribe). Never the cloud.

  const dictationCard = document.getElementById('dictation-card');
  const btnDictate = document.getElementById('btn-dictate');
  const dictationStatus = document.getElementById('dictation-status');
  const dictationOutput = document.getElementById('dictation-output');
  const btnDictationCopy = document.getElementById('btn-dictation-copy');
  const transcriber = (typeof LLSS_voiceTranscriber !== 'undefined') ? LLSS_voiceTranscriber : null;

  let activeEngine = null;   // 'webspeech' | 'nano'
  let activeHandle = null;   // engine-specific session/recorder handle
  let dictationLang = 'en-US';

  function setDictationStatus(text) {
    if (dictationStatus) dictationStatus.textContent = text || '';
  }

  // Show the card if any local engine is present: Web Speech (streaming) or
  // Prompt API audio (record-then-transcribe).
  const canDictate = transcriber &&
    (transcriber.isSupported() || transcriber.nanoAudioSupported());

  if (canDictate) {
    dictationCard.hidden = false;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      const lang = response?.settings?.voiceDetection?.language;
      if (lang) dictationLang = lang;
    });
    btnDictate.addEventListener('click', toggleDictation);
    btnDictationCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(dictationOutput.value || '').then(
        () => setDictationStatus('Copied.'),
        () => setDictationStatus('Copy failed.')
      );
    });
  }

  async function toggleDictation() {
    if (activeHandle) { await stopDictation(); return; }
    await startDictationFlow();
  }

  // Pick the best genuinely-ready engine: Web Speech if it truly reports ready,
  // otherwise Nano audio. Never cloud (that would upload audio).
  async function selectEngine() {
    if (transcriber.isSupported()) {
      const ws = await transcriber.checkAvailability(dictationLang);
      if (ws.ready) return 'webspeech';
    }
    if (transcriber.nanoAudioSupported()) {
      const nano = await transcriber.nanoAudioAvailability();
      // Ready, or downloadable/downloading (create() will complete the fetch).
      if (nano.ready || nano.needsInstall || nano.downloading) return 'nano';
    }
    return null;
  }

  async function startDictationFlow() {
    btnDictate.disabled = true;
    try {
      setDictationStatus('Checking on-device engines…');
      const engine = await selectEngine();
      if (!engine) {
        setDictationStatus(
          "On-device dictation isn't available in this browser yet. Your audio is " +
          "never uploaded, so dictation stays disabled rather than using the cloud."
        );
        btnDictate.disabled = false;
        return;
      }

      dictationOutput.value = '';
      btnDictationCopy.hidden = true;
      activeEngine = engine;

      if (engine === 'webspeech') {
        setDictationStatus('Listening… speak now, then click Stop.');
        activeHandle = await transcriber.startDictation({
          lang: dictationLang,
          onPartial: (interim) => setDictationStatus('Listening… ' + interim),
          onError: (err) => setDictationStatus('Error: ' + err.message),
        });
      } else {
        setDictationStatus('Recording… speak now, then click Stop.');
        activeHandle = await transcriber.startRecording();
      }
      btnDictate.textContent = 'Stop dictation';
      btnDictate.disabled = false;
    } catch (err) {
      setDictationStatus('Could not start dictation: ' + (err?.message || err));
      resetDictationUi();
    }
  }

  async function stopDictation() {
    btnDictate.disabled = true;
    const engine = activeEngine;
    const handle = activeHandle;
    activeEngine = null;
    activeHandle = null;
    try {
      let transcript = '';
      if (engine === 'webspeech') {
        setDictationStatus('Finishing…');
        handle.stop();
        transcript = await handle.done;
      } else {
        const blob = await handle.stop();
        setDictationStatus('Transcribing on-device…');
        transcript = await transcriber.transcribeWithNano(blob);
      }
      await redactAndShowTranscript(transcript);
    } catch (err) {
      setDictationStatus('Transcription failed: ' + (err?.message || err));
    }
    resetDictationUi();
  }

  function resetDictationUi() {
    btnDictate.textContent = 'Start dictation';
    btnDictate.disabled = false;
    activeEngine = null;
    activeHandle = null;
  }

  async function redactAndShowTranscript(transcript) {
    if (!transcript) {
      setDictationStatus('No speech detected.');
      return;
    }
    setDictationStatus('Redacting…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REDACT', text: transcript });
      if (response?.success) {
        dictationOutput.value = response.redacted;
        btnDictationCopy.hidden = false;
        setDictationStatus(`Redacted — ${response.matchCount || 0} item(s) removed (${response.engine || 'local'}).`);
      } else {
        dictationOutput.value = transcript;
        setDictationStatus('Redaction failed; showing raw transcript. Review before use.');
      }
    } catch (err) {
      dictationOutput.value = transcript;
      setDictationStatus('Redaction unavailable; showing raw transcript. Review before use.');
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
})();
