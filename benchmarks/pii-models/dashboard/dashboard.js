/* Offline-capable, dependency-free view over generated aggregate evidence. */
'use strict';
(() => {
  const data = globalThis.LLSS_EVIDENCE;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const pct = (x, places = 3) => Number.isFinite(x) ? `${(100 * x).toFixed(places)}%` : 'Not reported';
  const num = (x, places = 2) => Number.isFinite(x) ? x.toLocaleString('en-AU', { maximumFractionDigits: places, minimumFractionDigits: places }) : 'Not reported';
  const pp = x => Number.isFinite(x) ? `${x > 0 ? '+' : ''}${(100 * x).toFixed(4)} pp` : 'Not reported';
  const source = row => data.sources.find(item => item.id === row.source);
  const metrics = ['weighted_recall', 'document_full_protection_rate', 'clean_negative_document_rate', 'over_redaction_rate'];
  const metricNames = { weighted_recall: 'Weighted recall', document_full_protection_rate: 'Full-document protection',
    clean_negative_document_rate: 'Clean negatives', over_redaction_rate: 'Over-redaction' };
  let group, rows;
  function link(text, href, download = false) {
    const node = el('a', text); node.href = href;
    if (download) node.setAttribute('download', '');
    return node;
  }
  function options(select, values) {
    select.replaceChildren(...values.map(([value, label]) => {
      const option = el('option', label); option.value = value; return option;
    }));
  }
  function showPanel(id, updateHash = true) {
    for (const button of document.querySelectorAll('[data-panel]')) {
      const active = button.dataset.panel === id;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      $(button.dataset.panel).hidden = !active;
    }
    if (updateHash) history.replaceState(null, '', `#${id}`);
  }
  function thresholds(row) {
    if (row.threshold && typeof row.threshold === 'object') {
      return Object.entries(row.threshold).map(([name, value]) => `${name}: ${value}`).join('; ');
    }
    return Number.isFinite(row.threshold) ? `Threshold ${row.threshold.toFixed(2)}` : 'Threshold not reported';
  }
  function setGroup() {
    group = data.groups.find(item => item.id === $('cohort-select').value);
    const operating = [...new Set(group.rows.map(row => row.operating))];
    operating.sort((a, b) => ['primary', 'diagnostic', 'historical'].indexOf(a) - ['primary', 'diagnostic', 'historical'].indexOf(b));
    const names = { primary: 'Primary · selected on calibration', diagnostic: 'Diagnostic · fixed 0.10, not deployable',
      historical: 'Historical · see calibration limitations' };
    options($('operating-select'), operating.map(key => [key, names[key]]));
    renderDetection();
  }
  function renderDetection() {
    rows = group.rows.filter(row => row.operating === $('operating-select').value);
    const first = rows[0], evaluation = first.evaluation, counts = first.counts;
    const info = $('cohort-info'); info.replaceChildren(el('span', 'EXPLORATORY', 'chip'),
      document.createTextNode(`${group.scope} · ${evaluation.records?.toLocaleString() || 'Unknown'} documents · ` +
        `${counts.positive_docs ?? '?'} positive / ${counts.negative_docs ?? '?'} negative · ` +
        `${evaluation.independent_bootstrap_clusters ?? 'Unknown'} source/text clusters`),
      el('br'), el('span', `Dataset SHA-256 ${first.dataset_sha256}`, 'hash'), el('br'),
      el('span', `Partition: ${evaluation.partition} · Scheme: ${evaluation.partition_scheme || 'not reported'}`, 'hash'));
    const warnings = [...group.limitations];
    if ($('operating-select').value === 'diagnostic') warnings.unshift('Diagnostic operating point: chosen to expose model behaviour, not evidence of release suitability.');
    const list = el('ul'); for (const warning of warnings) list.append(el('li', warning));
    $('limitations').replaceChildren(el('strong', 'Read before comparing'), list);
    renderChart();
    const body = $('scores').tBodies[0]; body.replaceChildren();
    for (const row of rows) {
      const tr = el('tr'), name = el('td');
      const inspect = el('button', row.label, 'button secondary');
      inspect.addEventListener('click', () => { $('candidate-select').value = row.id; renderCandidate(); });
      name.append(inspect, el('span', thresholds(row), 'candidate-threshold'));
      tr.append(name);
      for (const key of metrics) {
        const score = row.scores[key], td = el('td');
        td.append(el('span', pct(score.value), 'metric-value'),
          el('span', score.low === null || score.high === null ? '95% interval not reported' :
            `${pct(score.low)}–${pct(score.high)}`, 'metric-ci'),
          el('span', { 'meets-bound': 'MEETS NUMERICAL BOUND ONLY', 'fails-bound': 'BELOW REQUIRED QUALITY', unknown: 'BOUND UNKNOWN' }[score.bound_status], `bound ${score.bound_status}`));
        tr.append(td);
      }
      body.append(tr);
    }
    options($('candidate-select'), rows.map(row => [row.id, row.label]));
    renderCandidate(); renderPairs();
  }
  function svgNode(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }
  function renderChart() {
    const chart = $('recall-chart'); chart.replaceChildren();
    for (const row of rows) {
      const container = el('div', undefined, 'chart-row'), score = row.scores.weighted_recall;
      const svg = svgNode('svg', { viewBox: '0 0 1000 28', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      svg.append(svgNode('line', { x1: 0, x2: 1000, y1: 14, y2: 14, stroke: '#e5ecee', 'stroke-width': 6 }),
        svgNode('line', { x1: 995, x2: 995, y1: 0, y2: 28, stroke: '#ab6a20', 'stroke-width': 2, 'stroke-dasharray': '3 3' }));
      if (Number.isFinite(score.low) && Number.isFinite(score.high)) {
        svg.append(svgNode('line', { x1: 1000 * score.low, x2: 1000 * score.high, y1: 14, y2: 14, stroke: '#076b68', 'stroke-width': 4 }));
        for (const bound of [score.low, score.high]) svg.append(svgNode('line', { x1: 1000 * bound, x2: 1000 * bound, y1: 7, y2: 21, stroke: '#076b68', 'stroke-width': 2 }));
      }
      if (Number.isFinite(score.value)) svg.append(svgNode('circle', { cx: score.value * 1000, cy: 14, r: 5, fill: '#076b68' }));
      container.append(el('span', row.label, 'chart-label'), svg, el('span', pct(score.value), 'chart-number'));
      chart.append(container);
    }
    const axis = el('div', undefined, 'chart-axis');
    for (const tick of [0, 25, 50, 75, 100]) axis.append(el('span', `${tick}%`));
    chart.append(axis);
  }
  function renderPairs() {
    const container = $('paired-effects'); container.replaceChildren();
    const active = $('operating-select').value;
    const pairs = group.pairs.filter(pair => active === 'historical' || pair.name.endsWith(':' + active));
    if (!pairs.length) { container.append(el('p', 'No paired comparison retained for this operating point. No significance claim is inferred.')); return; }
    for (const pair of pairs) {
      const block = el('div', undefined, 'pair');
      block.append(el('strong', pair.name.replaceAll(':', ' / ')));
      const result = pair.result;
      block.append(el('p', `${result.direction} · ${result.rounds} rounds · ${result.bootstrap_clusters} source/text clusters`));
      for (const [key, effect] of Object.entries(result.paired_differences || {})) {
        block.append(el('p', `${metricNames[key] || key}: ${pp(effect.difference)} [${pp(effect.low_95)}, ${pp(effect.high_95)}]`));
      }
      block.append(el('p', result.minimum_scores ? `Thresholds: first ${result.minimum_scores.first}; second ${result.minimum_scores.second}.` :
        'Separate thresholds not retained in this historical paired metadata. Inspect source operating points.'));
      container.append(block);
    }
  }
  function renderCandidate() {
    const row = rows.find(item => item.id === $('candidate-select').value), audit = $('candidate-audit');
    const src = source(row), counts = row.counts, guard = row.cluster_guardrails;
    const dl = el('dl', undefined, 'audit-dl');
    const entries = [
      ['Operating point', thresholds(row)], ['Candidate ID', row.candidate_id],
      ['Positive documents', counts.positive_docs], ['Fully protected', counts.fully_protected_docs],
      ['Negative documents', counts.negative_docs], ['Clean negatives', counts.clean_negative_docs],
      ['Negative clusters', guard.clean_negative?.trials ?? 'Not reported'],
      ['Positive clusters', guard.full_protection?.trials ?? 'Not reported'],
      ['Negative-cluster 95% interval', guard.clean_negative ? `${pct(guard.clean_negative.low_95)}–${pct(guard.clean_negative.high_95)} (Wilson)` : 'Not reported'],
      ['Gold sensitive characters', counts.gold_chars], ['Non-sensitive characters', counts.non_pii_chars],
      ['Artifact SHA-256', row.artifact_sha256 ?? 'Not reported'], ['Prediction SHA-256', row.prediction_sha256 ?? 'Not reported'],
    ];
    for (const [name, value] of entries) dl.append(el('dt', name), el('dd', value ?? 'Not reported'));
    const summary = el('div', undefined, 'audit-summary'); summary.append(el('span', 'NOT RELEASE QUALIFIED', 'chip'));
    audit.replaceChildren(summary, dl, link('Download exact source JSON ↗', `evidence/${src.file}`, true),
      el('p', `JSON Pointer: ${row.pointer}`, 'hash'), el('p', `Source SHA-256: ${src.sha256}`, 'hash'));
    const detail = el('details'); detail.append(el('summary', `${row.partial_gate_audit.failed_gates.length} unmet or missing release checks`),
      el('p', 'Partial audit using retained metrics and an empty review/browser dossier. Missing evidence is not a measured security failure. Passing a numerical bound is not release approval.'));
    const list = el('ul');
    for (const check of row.partial_gate_audit.checks.filter(item => !item.passed)) {
      list.append(el('li', `${check.gate}: actual ${JSON.stringify(check.actual)}; required ${JSON.stringify(check.required)}`));
    }
    detail.append(list); audit.append(detail);
    const tbody = $('label-table').tBodies[0]; tbody.replaceChildren();
    for (const label of data.labels) {
      const stat = row.by_label[label.id], evaluated = stat?.gold_entities > 0;
      const tr = el('tr');
      for (const value of [`${label.id} · risk ${label.risk}`, evaluated ? pct(stat.character_recall) : 'Not evaluated',
        evaluated ? pct(stat.full_entity_protection_rate) : 'Not evaluated', evaluated ? stat.gold_entities : '—',
        evaluated ? stat.independent_clusters ?? 'Not reported' : '—']) tr.append(el('td', value));
      tbody.append(tr);
    }
  }
  function renderRuntime() {
    const runtime = data.runtime, host = runtime.host;
    $('runtime-host').textContent = `${host.cpu} · ${host.cpu_count} CPU cores · ${num(host.memory_bytes / 2 ** 30, 0)} GiB · ${host.os} · Node ${host.node} · not the low-spec reference device`;
    const variants = [...new Set(runtime.runs.map(run => run.variant))];
    for (const variant of variants) {
      const runs = runtime.runs.filter(row => row.variant === variant), values = runs.map(row => row.peak_rss_mib);
      const card = el('div', undefined, 'runtime-stat');
      card.append(el('p', variant, 'eyebrow'), el('strong', `${num(Math.min(...values), 1)}–${num(Math.max(...values), 1)}`),
        el('span', 'MiB · observed OS peak RSS range, n = 3'),
        el('p', `Runtime assets ${num(runs[0].runtime_bytes / 1e6, 3)} MB. Model/tokenizer not included.`));
      $('runtime-summary').append(card);
    }
    const tbody = $('runtime-table').tBodies[0];
    for (const run of runtime.runs) {
      const tr = el('tr');
      for (const value of [run.variant, run.repetition, num(run.peak_rss_mib, 3), num(run.cold_start_ms, 3), num(run.p95_256_ms, 3), num(run.runtime_bytes / 1e6, 6)]) tr.append(el('td', value));
      tbody.append(tr);
    }
    const parity = runtime.span_parity;
    $('runtime-parity').append(el('p', `${parity.records.toLocaleString()} documents: identical span boundaries and labels at the tested operating point. No detection changes at the seven tested thresholds.`),
      el('p', `${parity.exact_span_and_score_match_records.toLocaleString()} exact span/score matches; ${parity.records - parity.exact_span_and_score_match_records} documents differ in confidence. Maximum aligned score difference: ${parity.maximum_aligned_score_difference}. Not bit-identical or proof for unseen inputs.`),
      el('p', 'Reduced runtime inference is slower: inspect all 256-token p95 measurements above. MB = 1,000,000 bytes; MiB = 1,048,576 bytes.'));
    for (const blocker of runtime.blockers) $('runtime-blockers').append(el('li', blocker));
    const rules = data.rules_coverage;
    $('rules-fix').append(el('p', `${rules.records.toLocaleString()} documents checked · ${rules.lost_coverage_records} previous-coverage losses`),
      el('p', `${rules.additional_sensitive_characters} additional sensitive characters protected in ${rules.added_coverage_records} documents; ${rules.additional_non_sensitive_characters} additional harmless characters redacted.`));
  }
  function exportCSV() {
    const columns = ['comparison_group', 'operating_point', 'candidate', 'dataset_sha256', 'partition', 'partition_scheme', 'threshold', 'documents', 'source_text_clusters'];
    for (const name of metrics) columns.push(`${name}_fraction`, `${name}_low_95_fraction`, `${name}_high_95_fraction`);
    columns.push('source_json', 'source_sha256', 'json_pointer', 'release_eligible');
    const quote = value => {
      let text = value === null || value === undefined ? '' : String(value);
      if (/^[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const lines = [columns];
    for (const row of rows) {
      const values = [group.id, row.operating, row.label, row.dataset_sha256, row.evaluation.partition, row.evaluation.partition_scheme,
        JSON.stringify(row.threshold), row.evaluation.records, row.evaluation.independent_bootstrap_clusters];
      for (const name of metrics) values.push(row.scores[name].value, row.scores[name].low, row.scores[name].high);
      values.push(source(row).file, source(row).sha256, row.pointer, false); lines.push(values);
    }
    const blob = new Blob([lines.map(line => line.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = link('', url, true); a.download = `llss-${group.id}-${$('operating-select').value}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderSources() {
    for (const item of data.sources) {
      const block = el('div', undefined, 'source');
      block.append(link(item.file + ' ↓', `evidence/${item.file}`, true), el('p', `${num(item.bytes, 0)} bytes`, 'footnote'), el('p', item.sha256, 'hash'));
      $('sources').append(block);
    }
    $('protocol-hash').textContent = `Protocol SHA-256: ${data.protocol_sha256}`;
    $('catalog-hash').textContent = `Catalog SHA-256: ${data.catalog_sha256}`;
    const tbody = $('catalog-table').tBodies[0];
    for (const item of data.catalog) {
      const tr = el('tr');
      for (const text of [`${item.name} / ${item.repository || 'local production source'}`, item.tier, item.license, item.rationale]) tr.append(el('td', text));
      tbody.append(tr);
    }
  }
  async function verifySources() {
    const status = $('source-verification'), button = $('verify-sources'); button.disabled = true;
    status.textContent = 'Checking exact source bytes…';
    try {
      if (!globalThis.crypto?.subtle || location.protocol === 'file:') throw new Error('This browser context cannot verify downloads. Serve the dashboard over localhost/HTTPS or verify the published SHA-256 hashes independently.');
      for (const item of data.sources) {
        const response = await fetch(`evidence/${item.file}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error('A source artifact could not be retrieved. No verification claim made.');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
        if (hash !== item.sha256) throw new Error('Source checksum mismatch. Do not rely on this snapshot.');
      }
      status.textContent = `All ${data.sources.length} source downloads match their recorded hashes. This checks byte integrity, not scientific validity or authorship.`;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  }
  try {
    if (!data || data.schema_version !== 1 || data.release_eligible !== false) throw new Error('Missing or unreviewed evidence payload. No results can be displayed.');
    $('group-count').textContent = data.groups.length;
    options($('cohort-select'), data.groups.map(item => [item.id, item.title]));
    $('cohort-select').value = 'compact-capacity-test';
    $('cohort-select').addEventListener('change', setGroup);
    $('operating-select').addEventListener('change', renderDetection);
    $('candidate-select').addEventListener('change', renderCandidate);
    $('export-csv').addEventListener('click', exportCSV);
    $('verify-sources').addEventListener('click', verifySources);
    for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel));
    for (const anchor of document.querySelectorAll('[data-open-methods]')) anchor.addEventListener('click', event => { event.preventDefault(); showPanel('methods'); $('methods-heading').scrollIntoView({ block: 'start' }); });
    renderRuntime(); renderSources(); setGroup();
    showPanel(['runtime', 'methods'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'detection', false);
  } catch (error) {
    $('error').hidden = false; $('error').textContent = 'Evidence dashboard failed to initialise. Do not rely on incomplete results. ' + error.message;
  }
})();
