// ==UserScript==
// @name         NextGen Office: Auto-fill Copay from Eligibility PDF
// @namespace    https://pilatus.app/tm
// @version      1.1.0
// @description  Automatically extract copay from eligibility PDF and fill in insurance form
// @author       Your Name
// @match        https://*.healthfusionclaims.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// @updateURL    https://raw.githubusercontent.com/Saentis29/CMG/nextgen-copay-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/Saentis29/repo/main/nextgen-copay-autofill.user.js
// ==/UserScript==

(function(){
  'use strict';

  /** -----------------------------
   *  PDF.js worker setup
   *  ----------------------------- */
  try {
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    }
  } catch (_) {}

  /** -----------------------------
   *  CONFIG / CONSTANTS
   *  ----------------------------- */
  const NS = 'tmCopayAutofill';
  const BTN_ID = NS + '-btn';

  // Configurable search terms for primary care copay
  // Add more terms here as you discover different payer wordings
  const PRIMARY_CARE_TERMS = [
    'Professional (Physician) Visit - Office',
    'Professional (Physician) Visit-Office',
    'PRIMARY CARE',
    'PCP',
    'Office Visit',
    'Primary care'
  ];

  // Terms that indicate "preferred" or "in-network" (prioritize these)
  const PREFERRED_TERMS = [
    'PREFERRED',
    'PARTICIPATING',
    'IN NETWORK',
    'IN-NETWORK'
  ];

  const PDF_FETCH_OPTS = {
    attempts: 6,
    initialDelayMs: 500,
    backoff: 1.6,
    timeoutPerTryMs: 12000
  };

  const WAIT_FOR_ELEMENT_MS = 15000;
  const CHECK_INTERVAL_MS = 200;

  // State management keys
  const STATE_KEY = NS + ':state';
  const COPAY_KEY = NS + ':copay';
  const COINSURANCE_KEY = NS + ':coinsurance';

  /** -----------------------------
   *  UTIL + STATE
   *  ----------------------------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const getState = () => GM_getValue(STATE_KEY, 'idle');
  const setState = (s) => GM_setValue(STATE_KEY, s);
  const getCopay = () => GM_getValue(COPAY_KEY, null);
  const setCopay = (v) => GM_setValue(COPAY_KEY, v);
  const getCoinsurance = () => GM_getValue(COINSURANCE_KEY, null);
  const setCoinsurance = (v) => GM_setValue(COINSURANCE_KEY, v);
  const clearState = () => {
    GM_setValue(STATE_KEY, 'idle');
    GM_setValue(COPAY_KEY, null);
    GM_setValue(COINSURANCE_KEY, null);
  };

  function cacheBust(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.set('_tm', Date.now().toString(36));
      return u.href;
    } catch {
      return url;
    }
  }

  function syntheticClick(el) {
    try { if (typeof el.click === 'function') { el.click(); return; } } catch {}
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return; } catch {}
    try {
      const evt = document.createEvent('MouseEvents');
      evt.initMouseEvent('click', true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null);
      el.dispatchEvent(evt);
    } catch {}
  }

  function waitForElement(selector, timeoutMs = WAIT_FOR_ELEMENT_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for: ${selector}`));
        } else {
          setTimeout(check, CHECK_INTERVAL_MS);
        }
      };
      check();
    });
  }

  function waitForCondition(conditionFn, timeoutMs = WAIT_FOR_ELEMENT_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const result = conditionFn();
        if (result) {
          resolve(result);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Timeout waiting for condition'));
        } else {
          setTimeout(check, CHECK_INTERVAL_MS);
        }
      };
      check();
    });
  }

  /** -----------------------------
   *  PDF Fetching
   *  ----------------------------- */
  function isPdfBytes(u8) {
    return u8 && u8.length >= 5 &&
           u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2D;
  }

  async function fetchPdfTextRobust(url, { attempts = 6, initialDelayMs = 400, backoff = 1.6, timeoutPerTryMs = 12000 } = {}) {
    let delay = initialDelayMs;
    let lastErr;

    for (let i = 1; i <= attempts; i++) {
      try {
        const buf = await fetchArrayBufferWithTimeout(url, timeoutPerTryMs);
        const head = new Uint8Array(buf.slice(0, 5));
        if (!isPdfBytes(head)) throw new Error('Not a PDF yet');

        if (!window.pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
          throw new Error('PDF.js not available');
        }

        const doc = await pdfjsLib.getDocument({ data: buf, disableWorker: true }).promise;
        let text = '';
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          text += '\n' + content.items.map(i => i.str).join(' ');
        }
        return text;
      } catch (e) {
        lastErr = e;
        if (i < attempts) {
          await sleep(delay);
          delay = Math.floor(delay * backoff);
          continue;
        }
      }
    }
    throw lastErr || new Error('Failed to fetch PDF');
  }

  async function fetchArrayBufferWithTimeout(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('GM_xmlhttpRequest timeout'));
        }
      }, timeoutMs);

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (r) => {
          if (done) return;
          clearTimeout(timer);
          done = true;
          if (r.status >= 200 && r.status < 300 && r.response) {
            resolve(r.response);
          } else {
            reject(new Error(`HTTP ${r.status}`));
          }
        },
        onerror: (e) => {
          if (done) return;
          clearTimeout(timer);
          done = true;
          reject(e);
        }
      });
    });
  }

  /** -----------------------------
   *  PDF Parsing - Extract Copay/Coinsurance
   *  ----------------------------- */
  function extractCopayInfo(pdfText) {
    // Normalize whitespace
    const normalized = pdfText
      .replace(/\s+/g, ' ')
      .replace(/\n/g, ' ')
      .trim();

    // Pattern: Service[DETAILS]:$amount
    // Example: Professional (Physician) Visit - Office[PREFERRED PRIMARY CARE...]:$30.00
    const pattern = /([^[\]]+)\[([^\]]+)\]:\$?([\d,]+(?:\.\d{2})?)/g;

    let matches = [];
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const service = match[1].trim();
      const details = match[2].trim();
      const amount = match[3].replace(/,/g, '');

      matches.push({
        service,
        details,
        amount: parseFloat(amount)
      });
    }

    // Find primary care copay
    let copay = null;
    let bestMatch = null;
    let bestScore = -1;

    for (const m of matches) {
      // Check if this matches any primary care term
      const matchesPrimaryCare = PRIMARY_CARE_TERMS.some(term =>
        m.service.toUpperCase().includes(term.toUpperCase())
      );

      if (matchesPrimaryCare) {
        let score = 0;

        // Prefer "PREFERRED" over "PARTICIPATING"
        if (m.details.toUpperCase().includes('PREFERRED')) score += 10;
        else if (m.details.toUpperCase().includes('PARTICIPATING')) score += 5;

        // Additional bonus for explicit "PRIMARY CARE" in details
        if (m.details.toUpperCase().includes('PRIMARY CARE')) score += 5;

        if (score > bestScore || (score === bestScore && !bestMatch)) {
          bestScore = score;
          bestMatch = m;
          copay = m.amount;
        }
      }
    }

    // TODO: Extract coinsurance (not implemented yet, but parse it here)
    let coinsurance = null;

    return {
      copay: copay ? copay.toFixed(2) : null,
      coinsurance,
      allMatches: matches // For debugging
    };
  }

  /** -----------------------------
   *  Main Workflow - Step 1: Extract copay from PDF
   *  ----------------------------- */
  async function step1_extractCopay() {
    try {
      console.log('[Copay Autofill] Step 1: Starting');

      // Wait for PDF link to appear (already present if Verify was clicked)
      const pdfLinkSelector = 'td.patientData.patientLastChecked_0 a[onclick*="printpdf.do"]';
      const pdfLink = await waitForElement(pdfLinkSelector, 30000);

      // Extract PDF URL from onclick
      const onclick = pdfLink.getAttribute('onclick') || '';
      const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)/);
      if (!urlMatch) {
        throw new Error('Could not extract PDF URL');
      }

      let pdfUrl = urlMatch[1].replace(/&amp;/g, '&');
      pdfUrl = new URL(pdfUrl, location.href).href;

      // Fetch and parse PDF
      const pdfText = await fetchPdfTextRobust(cacheBust(pdfUrl), PDF_FETCH_OPTS);
      console.log('[Copay Autofill] PDF text length:', pdfText.length);
      console.log('[Copay Autofill] PDF text (first 500 chars):', pdfText.slice(0, 500));

      const { copay, coinsurance, allMatches } = extractCopayInfo(pdfText);

      console.log('[Copay Autofill] All matches found:', allMatches);
      console.log('[Copay Autofill] Found copay:', copay, 'coinsurance:', coinsurance);

      if (!copay) {
        console.error('[Copay Autofill] Could not find primary care copay. All matches:', allMatches);
        throw new Error('No primary care copay found in PDF. Check console for details.');
      }

      // Save values and set state
      setCopay(copay);
      setCoinsurance(coinsurance);
      setState('navigate_to_details');

      // Navigate to View/Edit Details
      if (typeof window.pchart_patient_information === 'function') {
        window.pchart_patient_information();
      } else {
        const detailsLink = document.querySelector('a[href*="pchart_patient_information"]');
        if (detailsLink) syntheticClick(detailsLink);
        else throw new Error('View/Edit Details link not found');
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 1 Error:', err);
      clearState();
      alert('Copay extraction failed: ' + (err?.message || String(err)));
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 2: Navigate to Insurance tab
   *  ----------------------------- */
  async function step2_navigateToInsurance() {
    try {
      console.log('[Copay Autofill] Step 2: Navigate to insurance');

      // Wait for the insurance information tab to be available
      const insLink = await waitForElement('a[href*="goto_insurance_information"]', 10000);

      setState('open_insurance_editor');

      // Click Insurance Information tab
      if (typeof window.goto_insurance_information === 'function') {
        window.goto_insurance_information();
      } else {
        syntheticClick(insLink);
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 2 Error:', err);
      clearState();
      alert('Navigation failed: ' + (err?.message || String(err)));
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 3: Open insurance editor
   *  ----------------------------- */
  async function step3_openEditor() {
    try {
      console.log('[Copay Autofill] Step 3: Open editor');

      // Wait for edit button and click it
      await sleep(500);
      const editBtn = await waitForElement('img[onclick*="insurance_edit"]', 10000);
      setState('fill_copay');
      syntheticClick(editBtn);

    } catch (err) {
      console.error('[Copay Autofill] Step 3 Error:', err);
      clearState();
      alert('Could not open insurance editor: ' + (err?.message || String(err)));
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 4: Fill and save copay
   *  ----------------------------- */
  async function step4_fillAndSave() {
    try {
      console.log('[Copay Autofill] Step 4: Fill and save');

      const copay = getCopay();
      if (!copay) {
        throw new Error('No copay value found in state');
      }

      // Wait for copay field
      await sleep(500);
      const copayField = await waitForElement('input#COPAY', 10000);

      // Fill copay
      copayField.value = copay;
      copayField.dispatchEvent(new Event('input', { bubbles: true }));
      copayField.dispatchEvent(new Event('change', { bubbles: true }));
      copayField.dispatchEvent(new Event('blur', { bubbles: true }));

      // Save
      await sleep(500);
      if (typeof window.insurance_save === 'function') {
        window.insurance_save();
      } else {
        const saveBtn = document.querySelector('input[onclick*="insurance_save"]');
        if (saveBtn) {
          syntheticClick(saveBtn);
        } else {
          throw new Error('Save button not found');
        }
      }

      // Success! Go back to patient chart
      console.log('[Copay Autofill] Complete! Copay:', copay);

      await sleep(1000);

      // Click the patient chart link to go back
      const patientLink = document.querySelector('#patientInfo a[href*="patient_chart.jsp"]');
      console.log('[Copay Autofill] Patient link found:', patientLink);

      if (patientLink) {
        console.log('[Copay Autofill] Clicking patient link:', patientLink.href);
        syntheticClick(patientLink);
      } else {
        console.warn('[Copay Autofill] Patient chart link not found, trying alternate selector');
        const altLink = document.querySelector('#patientInfo a');
        if (altLink) {
          console.log('[Copay Autofill] Found alternate link:', altLink.href);
          syntheticClick(altLink);
        }
      }

      clearState();

    } catch (err) {
      console.error('[Copay Autofill] Step 4 Error:', err);
      clearState();
      alert('Failed to fill copay: ' + (err?.message || String(err)));
    }
  }

  /** -----------------------------
   *  State machine auto-resume
   *  ----------------------------- */
  async function autoResumeWorkflow() {
    const state = getState();

    // Only log and proceed if we're in an active workflow
    if (state === 'idle' || !state) {
      return; // No active workflow, do nothing
    }

    console.log('[Copay Autofill] Resuming workflow. Current state:', state);

    try {
      if (state === 'navigate_to_details') {
        // We just landed on patient details page, go to insurance tab
        await step2_navigateToInsurance();
      } else if (state === 'open_insurance_editor') {
        // We're on insurance tab, open editor
        await step3_openEditor();
      } else if (state === 'fill_copay') {
        // We're in editor, fill and save
        await step4_fillAndSave();
      }
    } catch (err) {
      console.error('[Copay Autofill] Auto-resume error:', err);
      // Don't show alert for auto-resume errors, just clear state
      clearState();
    }
  }

  /** -----------------------------
   *  Button click handler - Start workflow
   *  ----------------------------- */
  async function startCopayWorkflow() {
    try {
      // Click the Verify button first
      const verifyLink = document.querySelector('a[href*="pchart_verify_insurance(\'Primary\')"]');
      if (!verifyLink) {
        throw new Error('Verify link not found');
      }

      // Execute the verify function
      if (typeof window.pchart_verify_insurance === 'function') {
        window.pchart_verify_insurance('Primary');
      } else {
        syntheticClick(verifyLink);
      }

      // Wait for page to reload and PDF to appear
      await sleep(2000);

      // Start extraction
      await step1_extractCopay();

    } catch (err) {
      console.error('[Copay Autofill] Start Error:', err);
      clearState();
      alert('Failed to start copay workflow: ' + (err?.message || String(err)));
    }
  }

  /** -----------------------------
   *  Button Management
   *  ----------------------------- */
  function hasVerifyLink() {
    return !!document.querySelector('a[href*="pchart_verify_insurance(\'Primary\')"]');
  }

  function findVerifyCell() {
    // Find the td containing the Verify link
    const verifyLink = document.querySelector('a[href*="pchart_verify_insurance(\'Primary\')"]');
    if (!verifyLink) return null;

    // Find parent td with align="right"
    let cell = verifyLink.closest('td[align="right"]');
    return cell;
  }

  function mountButton() {
    if (!hasVerifyLink()) return;
    if (document.getElementById(BTN_ID)) return;

    const verifyCell = findVerifyCell();
    if (!verifyCell) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML = '✅ CoPay';

    Object.assign(btn.style, {
      marginTop: '8px',
      padding: '6px 12px',
      borderRadius: '6px',
      border: '1px solid #22c55e',
      background: '#dcfce7',
      color: '#166534',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: '600',
      display: 'block',
      width: '100%'
    });

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Disable button during processing
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';

      await startCopayWorkflow();
    }, true);

    // Insert button below the verify link
    verifyCell.appendChild(btn);
  }

  function updateButtonStatus(text, keepEnabled = false) {
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.textContent = text;
      if (keepEnabled) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
      }
    }
  }

  function resetButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.innerHTML = '✅ CoPay';
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  }

  /** -----------------------------
   *  Initialize
   *  ----------------------------- */
  const observer = new MutationObserver(() => mountButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('load', () => {
    setTimeout(mountButton, 0);
    setTimeout(autoResumeWorkflow, 500);
  });

  setInterval(mountButton, 2000);

  // Also try to resume immediately on script start
  setTimeout(autoResumeWorkflow, 1000);

})();
