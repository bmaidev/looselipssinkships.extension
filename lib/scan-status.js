(function () {
  'use strict';
  // Fixed copy only: do not display provider errors or raw content in notices.
  function describe(coverage) {
    if (!coverage || coverage.rules?.status !== 'processed') {
      return { label: 'Coverage unconfirmed', limited: true,
        detail: 'The full scan coverage was not confirmed. Review the output before sharing sensitive information.' };
    }
    const reasons = {
      skipped_length: 'The contextual model was not run for this text length.',
      unavailable: 'The contextual model was unavailable.',
      failed: 'The contextual model failed.',
      timeout: 'The contextual model did not finish in time.',
      not_requested: 'Only rule-based detection was requested.',
      unverified: 'The contextual model output could not be verified.',
    };
    const status = coverage.contextual?.status;
    if (status === 'processed') {
      return { label: 'Model checked · review', limited: false,
        detail: 'Rules and a contextual model ran. Detection can still miss sensitive information; review the output before sharing.' };
    }
    return { label: 'Limited scan · review', limited: true,
      detail: `${reasons[status] || 'Contextual scanning was not confirmed.'} Local rules ran, but sensitive personal circumstances may remain. Review before sharing.` };
  }
  globalThis.LLSS_ScanStatus = { describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = { describe };
})();
