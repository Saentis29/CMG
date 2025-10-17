// ==UserScript==
// @name         NextGen Insurance Verification - individual
// @namespace    https://pilatus.app/tm
// @version      2.7.0
// @description  Automatically extract copay from eligibility PDF, check secondary if needed, create alert, and fill in insurance form
// @author       David Luebbert, MD
// @match        https://*.healthfusionclaims.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// @updateURL    https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20Insurance%20Verification%20-%20individual.js
// @downloadURL  https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20Insurance%20Verification%20-%20individual.js
// ==/UserScript==

/**
 * ============================================================================
 * NextGen Insurance Verification Automation Script
 * ============================================================================
 *
 * Copyright (c) 2025 David Luebbert, MD
 * All Rights Reserved
 *
 * This software is the proprietary property of David Luebbert, MD.
 *
 * Unauthorized copying, distribution, modification, or use of this software,
 * via any medium, is strictly prohibited without explicit written permission
 * from the copyright holder.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHOR OR COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * For licensing inquiries, contact: David Luebbert, MD
 * ============================================================================
 */

(function(){
  'use strict';

  // Only run in top window, not in iframes
  if (window !== window.top) {
    return;
  }

  console.log('[Copay Autofill] Script loading...');

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

  // Alert configuration
  const ALERT_CONFIG = {
    ENABLE_ALERT_NOTES: true,
    ALERT_ON_SCHEDULING: true,
    ALERT_ON_BILLING: true
  };

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
  const PRIMARY_COPAY_KEY = NS + ':primaryCopay';
  const PRIMARY_COINS_KEY = NS + ':primaryCoins';
  const URGENT_COPAY_KEY = NS + ':urgentCopay';
  const URGENT_COINS_KEY = NS + ':urgentCoins';
  const GUARANTOR_BALANCE_KEY = NS + ':guarantorBalance';
  const NEXT_APPOINTMENT_KEY = NS + ':nextAppointment';
  const INSURANCE_LEVEL_KEY = NS + ':insuranceLevel'; // 'primary' or 'secondary'
  const DEBUG_LOG_KEY = NS + ':debugLog';

  // Debug log helpers
  const getDebugLog = () => {
    try {
      const saved = GM_getValue(DEBUG_LOG_KEY, null);
      return saved ? JSON.parse(saved) : {
        matches: [],
        primaryCandidates: [],
        urgentCandidates: [],
        finalValues: {},
        parseTime: 0,
        fetchTime: 0
      };
    } catch {
      return {
        matches: [],
        primaryCandidates: [],
        urgentCandidates: [],
        finalValues: {},
        parseTime: 0,
        fetchTime: 0
      };
    }
  };

  const saveDebugLog = (log) => {
    GM_setValue(DEBUG_LOG_KEY, JSON.stringify(log));
  };

  // Debug log collector (load from storage)
  let debugLog = getDebugLog();

  /** -----------------------------
   *  PDF Parsing Configuration
   *  ----------------------------- */
  const PRIMARY_CARE_TERMS = [
    'Professional (Physician) Visit - Office',
    'Professional (Physician) Visit-Office',
    'PRIMARY CARE',
    'PCP',
    'Office Visit',
    'Primary care',
    'Physician Visit',
    'PHYSICIAN OFFICE VISIT PCP',
    'Primary Care Physician',
    'PRIMARY CARE PHYSICIAN SERVICES',
    'PHYSICIAN SERVICES'
  ];

  const URGENT_CARE_TERMS = [
    'Emergency Room',
    'Urgent Care',
    'URGENT CARE',
    'PHYSICIAN OFFICE URGENT CARE'
  ];

  const IN_NETWORK_TERMS = [
    'PREFERRED',
    'PARTICIPATING',
    'IN NETWORK',
    'IN-NETWORK',
    'BCBS PROVIDERS',
    'IN NET',
    'UHC CHOICE',
    'JOHNS HOPKINS',
    'VARIES BY LOCATION',
    'VARIES BY PRACTITIONER'
  ];

  // Insurance-specific pattern configuration
  const INSURANCE_PATTERNS = {
    'ALLEGIANCE': {
      patterns: [
        /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['JOHNS HOPKINS', 'IN NETWORK'],
      primaryCareKeywords: ['PCP', 'Office Visit', 'Professional (Physician) Visit - Office'],
      urgentCareKeywords: ['Urgent Care']
    },

    'UNITED': {
      patterns: [
        /([^[\]]+)\[([^\]]+UHC[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^[\]]+)\[([^\]]+OFFICE VISIT[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['UHC CHOICE', 'IN NETWORK'],
      primaryCareKeywords: ['PCP OFFICE VISIT', 'Professional (Physician) Visit - Office', 'OFFICE VISIT PRIMARY'],
      urgentCareKeywords: ['Urgent Care']
    },

    'CIGNA': {
      patterns: [
        /([^[\]]+)\[Seq#\d+\s+([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['IN NETWORK', 'PARTICIPATING'],
      primaryCareKeywords: ['PHYSICIAN OFFICE VISIT PCP', 'PRIMARY CARE', 'PCP'],
      urgentCareKeywords: ['PHYSICIAN OFFICE URGENT CARE', 'URGENT CARE']
    },

    'HUMANA': {
      patterns: [
        /([^[\]]+)\[Seq#\d+\s+([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['IN NETWORK', 'PARTICIPATING'],
      primaryCareKeywords: ['PHYSICIAN OFFICE VISIT PCP', 'PRIMARY CARE'],
      urgentCareKeywords: ['PHYSICIAN OFFICE URGENT CARE', 'URGENT CARE']
    },

    'CAREFIRST': {
      patterns: [
        /([^[\]]+)\[([^\]]+BCBS PROVIDERS[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^[\]]+)\[([^\]]+)\s+\((\d+)\)[^\]]*IN NETWORK[^\]]*\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^[\]:]+):\s*[^[\]]*\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['BCBS PROVIDERS', 'IN NETWORK', 'BLUECHOICE'],
      primaryCareKeywords: ['Physician Visit - Office', 'Professional (Physician) Visit - Office', 'PRIMARY CARE PHYSICIAN', 'PCP', 'OFFICE VISIT'],
      urgentCareKeywords: ['Urgent Care', 'URGENT CARE']
    },

    'SUREST': {
      patterns: [
        /([^:[\]]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^[\]]+)\[([^\]]+VARIES BY[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['VARIES BY LOCATION', 'VARIES BY PRACTITIONER'],
      primaryCareKeywords: ['Physician Visit - Office: Sick', 'Physician Visit - Office: Well', 'Office Visit'],
      urgentCareKeywords: ['Urgent Care']
    },

    'TRICARE': {
      patterns: [
        /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['IN NETWORK'],
      primaryCareKeywords: ['Professional (Physician) Visit - Office'],
      urgentCareKeywords: ['Urgent Care']
    },

    'AETNA': {
      patterns: [
        /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
        /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g
      ],
      networkIndicators: ['IN NETWORK', 'PARTICIPATING'],
      primaryCareKeywords: ['PCP', 'Primary Care', 'Professional (Physician) Visit - Office'],
      urgentCareKeywords: ['Urgent Care']
    }
  };

  const DEFAULT_PATTERN_CONFIG = {
    patterns: [
      /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
      /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g
    ],
    networkIndicators: IN_NETWORK_TERMS,
    primaryCareKeywords: PRIMARY_CARE_TERMS,
    urgentCareKeywords: URGENT_CARE_TERMS
  };

  /** -----------------------------
   *  UTIL + STATE
   *  ----------------------------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const getState = () => GM_getValue(STATE_KEY, 'idle');
  const setState = (s) => GM_setValue(STATE_KEY, s);

  const getPrimaryCopay = () => GM_getValue(PRIMARY_COPAY_KEY, null);
  const setPrimaryCopay = (v) => GM_setValue(PRIMARY_COPAY_KEY, v);

  const getPrimaryCoins = () => GM_getValue(PRIMARY_COINS_KEY, null);
  const setPrimaryCoins = (v) => GM_setValue(PRIMARY_COINS_KEY, v);

  const getUrgentCopay = () => GM_getValue(URGENT_COPAY_KEY, null);
  const setUrgentCopay = (v) => GM_setValue(URGENT_COPAY_KEY, v);

  const getUrgentCoins = () => GM_getValue(URGENT_COINS_KEY, null);
  const setUrgentCoins = (v) => GM_setValue(URGENT_COINS_KEY, v);

  const getGuarantorBalance = () => GM_getValue(GUARANTOR_BALANCE_KEY, '');
  const setGuarantorBalance = (v) => GM_setValue(GUARANTOR_BALANCE_KEY, v);

  const getNextAppointment = () => GM_getValue(NEXT_APPOINTMENT_KEY, 'No appointment found');
  const setNextAppointment = (v) => GM_setValue(NEXT_APPOINTMENT_KEY, v);

  const getInsuranceLevel = () => GM_getValue(INSURANCE_LEVEL_KEY, 'primary');
  const setInsuranceLevel = (v) => GM_setValue(INSURANCE_LEVEL_KEY, v);

  const clearState = () => {
    console.log('🗑️🗑️🗑️ CLEARING ALL STATE AND COPAY DATA 🗑️🗑️🗑️');
    GM_setValue(STATE_KEY, 'idle');
    GM_setValue(PRIMARY_COPAY_KEY, null);
    GM_setValue(PRIMARY_COINS_KEY, null);
    GM_setValue(URGENT_COPAY_KEY, null);
    GM_setValue(URGENT_COINS_KEY, null);
    GM_setValue(GUARANTOR_BALANCE_KEY, '');
    GM_setValue(NEXT_APPOINTMENT_KEY, 'No appointment found');
    GM_setValue(INSURANCE_LEVEL_KEY, 'primary');
    GM_setValue(DEBUG_LOG_KEY, null);
    console.log('✅ State cleared - all copay values set to null');
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

  // Debug mode - pause before navigation
  const DEBUG_MODE = false;

  async function syntheticClick(el, description = 'element') {
    if (DEBUG_MODE) {
      console.log(`[DEBUG] About to click: ${description}`);
      console.log(`[DEBUG] Current state: ${getState()}`);
      console.log(`[DEBUG] Element:`, el);

      // Show alert and wait for user
      const proceed = confirm(`DEBUG: About to click "${description}"\n\nCurrent state: ${getState()}\n\nClick OK to continue, Cancel to stop.`);
      if (!proceed) {
        console.log('[DEBUG] User cancelled navigation');
        clearState();
        isWorkflowRunning = false;
        hideStatusPanel();
        return;
      }
    }

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

  /**
   * Extract next appointment info from appointments table
   */
  function extractNextAppointment() {
    try {
      console.log('[Copay Autofill] Looking for appointments...');
      const appointmentsDiv = document.getElementById('patient_chart_appointment');
      console.log('[Copay Autofill] Appointments div found?', !!appointmentsDiv);

      if (!appointmentsDiv) {
        console.log('[Copay Autofill] Appointments div not found');
        return 'No appointment found';
      }

      const rows = appointmentsDiv.querySelectorAll('tr.datacell, tr.datacell2');
      console.log('[Copay Autofill] Found', rows.length, 'appointment rows');

      const today = new Date();
      today.setHours(0, 0, 0, 0); // Reset time to midnight for date comparison
      console.log('[Copay Autofill] Today:', today);

      let closestAppt = null;
      let closestDate = null;

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) {
          console.log('[Copay Autofill] Row has less than 4 cells, skipping');
          continue;
        }

        const typeCell = cells[2]; // Appointment type is 3rd column
        const apptType = typeCell.textContent.trim();
        const apptTypeUpper = apptType.toUpperCase();
        console.log('[Copay Autofill] Checking appointment type:', apptType);

        // Only look for specific appointment types
        const validTypes = [
          'ESTABLISHED',
          'PHYSICAL',
          'MEDICARE WELLNESS VISIT',
          'ER FU',
          'HOSPITAL FU',
          'NEW PATIENT'
        ];

        const isValid = validTypes.some(type => apptTypeUpper.includes(type));
        if (!isValid) {
          console.log('[Copay Autofill] Type does not match, skipping');
          continue;
        }

        // Get appointment date/time from 2nd column
        const dateLink = cells[1].querySelector('a');
        if (!dateLink) {
          console.log('[Copay Autofill] No date link found, skipping');
          continue;
        }

        const dateTimeText = dateLink.textContent.trim(); // e.g., "11/25/2025 12:15 PM"
        const apptDate = new Date(dateTimeText);
        apptDate.setHours(0, 0, 0, 0); // Reset to midnight for fair comparison
        console.log('[Copay Autofill] Appointment date:', dateTimeText, '→', apptDate);

        // Only consider today or future appointments
        if (apptDate < today) {
          console.log('[Copay Autofill] Appointment is in the past, skipping');
          continue;
        }

        // Find the closest future appointment
        if (!closestDate || apptDate < closestDate) {
          closestDate = apptDate;
          const resource = cells[3].textContent.trim(); // Resource is 4th column

          // Shorten appointment type (order matters - do specific replacements first)
          let shortType = apptType
            .replace(/MEDICARE WELLNESS VISIT/gi, 'MWV')
            .replace(/HOSPITAL FU/gi, 'Hosp FU')
            .replace(/ER FU/gi, 'ER FU')
            .replace(/PHYSICAL EXAM/gi, 'PE')
            .replace(/OVER 40/gi, '>40')
            .replace(/NEW PATIENT/gi, 'New Pt')
            .replace(/ESTABLISHED/gi, 'Est')
            .replace(/PATIENT/gi, 'Pt');

          closestAppt = `${dateTimeText} - ${shortType} - ${resource}`;
          console.log('[Copay Autofill] New closest appointment:', closestAppt);
        }
      }

      console.log('[Copay Autofill] Final appointment:', closestAppt || 'No appointment found');
      return closestAppt || 'No appointment found';
    } catch (err) {
      console.error('[Copay Autofill] Error extracting appointment:', err);
      return 'No appointment found';
    }
  }

  /**
   * Format copay/coinsurance data for alert message
   */
  function formatCopayAlert(copayData) {
    const today = new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric'
    });

    const pc = copayData.primaryCopay ? `$${copayData.primaryCopay}` : 'N/A';
    const pci = copayData.primaryCoins ? `${copayData.primaryCoins}%` : 'N/A';
    const uc = copayData.urgentCopay ? `$${copayData.urgentCopay}` : 'N/A';
    const uci = copayData.urgentCoins ? `${copayData.urgentCoins}%` : 'N/A';
    // Don't use || because empty string is falsy - check explicitly for null/undefined
    const balance = (copayData.guarantorBalance !== null && copayData.guarantorBalance !== undefined && copayData.guarantorBalance !== '')
      ? copayData.guarantorBalance
      : 'N/A';

    // Get next appointment from storage (extracted earlier on patient chart page)
    const nextAppt = copayData.nextAppointment || 'No appointment found';

    return `PRIMARY CARE  | Copay: ${pc} | Coinsurance: ${pci}
URGENT CARE   | Copay: ${uc} | Coinsurance: ${uci}

Patient Balance: ${balance}

Next Appt: ${nextAppt}

        ** Insurance verified: ${today} **`;
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
   *  (Complete insurance-aware version from batch script)
   *  ----------------------------- */
  function detectInsuranceCompany(pdfText) {
    const upperText = pdfText.toUpperCase();

    // Check for specific insurance companies
    if (upperText.includes('CIGNA HEALTHSPRING') || (upperText.includes('CIGNA') && upperText.includes('Seq#'))) {
      return INSURANCE_PATTERNS['CIGNA'];
    }
    if (upperText.includes('HUMANA') && upperText.includes('Seq#')) {
      return INSURANCE_PATTERNS['HUMANA'];
    }
    if (upperText.includes('CAREFIRST') || upperText.includes('BCBS PROVIDERS')) {
      return INSURANCE_PATTERNS['CAREFIRST'];
    }
    if (upperText.includes('UNITED HEALTHCARE') || upperText.includes('UHC CHOICE') || upperText.includes('ALL SAVERS')) {
      return INSURANCE_PATTERNS['UNITED'];
    }
    if (upperText.includes('SUREST') || upperText.includes('VARIES BY LOCATION')) {
      return INSURANCE_PATTERNS['SUREST'];
    }
    if (upperText.includes('TRICARE')) {
      return INSURANCE_PATTERNS['TRICARE'];
    }
    if (upperText.includes('AETNA')) {
      return INSURANCE_PATTERNS['AETNA'];
    }
    if (upperText.includes('ALLEGIANCE')) {
      return INSURANCE_PATTERNS['ALLEGIANCE'];
    }

    // Default fallback
    return DEFAULT_PATTERN_CONFIG;
  }

  /**
   * Extract copay/coinsurance information from PDF text
   * @param {string} pdfText - Full PDF text content
   * @returns {object} - Extracted copay/coinsurance values
   */
  function extractCopayInfo(pdfText) {
    // Normalize whitespace
    const normalized = pdfText
      .replace(/\s+/g, ' ')
      .replace(/\n/g, ' ')
      .trim();

    // Detect insurance company and get appropriate pattern config
    const patternConfig = detectInsuranceCompany(pdfText);

    console.log('[Copay Autofill] Using pattern config:', patternConfig.networkIndicators);

    let matches = [];

    // Try all patterns for this insurance type
    for (const pattern of patternConfig.patterns) {
      let match;
      // Reset regex state
      pattern.lastIndex = 0;

      let iterationCount = 0;
      const maxIterations = 500; // Prevent infinite loops

      while ((match = pattern.exec(normalized)) !== null) {
        if (++iterationCount > maxIterations) {
          console.warn('[Copay Autofill] Pattern exceeded max iterations, skipping');
          break;
        }
        let service, details, amountStr;

        // Handle different match group structures
        if (match.length === 3) {
          // Simple format: Service:$amount
          service = match[1].trim();
          details = '';
          amountStr = match[2].replace(/,/g, '');
        } else if (match.length === 4) {
          // Bracket format: Service[Details]:$amount
          service = match[1].trim();
          details = match[2].trim();
          amountStr = match[3].replace(/,/g, '');
        } else if (match.length === 5) {
          // CareFirst benefit code format: Service[Details (Code)]:$amount
          service = match[1].trim();
          details = match[2].trim() + ' (' + match[3] + ')';
          amountStr = match[4].replace(/,/g, '');
        } else {
          continue;
        }

        const isPercentage = amountStr.endsWith('%');
        const amount = parseFloat(amountStr.replace('%', ''));

        // Skip invalid amounts or amounts that are clearly wrong
        if (isNaN(amount) || amount < 0 || amount > 10000) {
          continue;
        }

        matches.push({
          service,
          details,
          amount,
          isPercentage
        });
      }
    }

    console.log('[Copay Autofill] Found matches:', matches.length);

    // Store matches in debug log
    debugLog.matches = matches.map(m => ({
      service: m.service,
      amount: m.isPercentage ? m.amount + '%' : '$' + m.amount,
      details: m.details
    }));

    // Log all matches for debugging
    if (matches.length > 0) {
      console.table(matches.map(m => ({
        service: m.service,
        amount: m.isPercentage ? m.amount + '%' : '$' + m.amount,
        details: m.details.substring(0, 50) + (m.details.length > 50 ? '...' : '')
      })));
    }

    // If no matches with detected insurance pattern, try default pattern
    if (matches.length === 0 && patternConfig !== DEFAULT_PATTERN_CONFIG) {
      console.log('[Copay Autofill] No matches with detected insurance pattern, trying default pattern...');
      const defaultConfig = DEFAULT_PATTERN_CONFIG;

      for (const pattern of defaultConfig.patterns) {
        let match;
        pattern.lastIndex = 0;

        let iterationCount = 0;
        const maxIterations = 500;

        while ((match = pattern.exec(normalized)) !== null) {
          if (++iterationCount > maxIterations) {
            console.warn('[Copay Autofill] Default pattern exceeded max iterations, skipping');
            break;
          }
          let service, details, amountStr;

          if (match.length === 3) {
            service = match[1].trim();
            details = '';
            amountStr = match[2].replace(/,/g, '');
          } else if (match.length === 4) {
            service = match[1].trim();
            details = match[2].trim();
            amountStr = match[3].replace(/,/g, '');
          } else if (match.length === 5) {
            service = match[1].trim();
            details = match[2].trim() + ' (' + match[3] + ')';
            amountStr = match[4].replace(/,/g, '');
          } else {
            continue;
          }

          const isPercentage = amountStr.endsWith('%');
          const amount = parseFloat(amountStr.replace('%', ''));

          if (isNaN(amount) || amount < 0 || amount > 10000) {
            continue;
          }

          matches.push({
            service,
            details,
            amount,
            isPercentage
          });
        }
      }

      console.log('[Copay Autofill] Found matches with default pattern:', matches.length);

      // Use default config for scoring too
      if (matches.length > 0) {
        console.log('[Copay Autofill] Switching to default pattern config for scoring');
        Object.assign(patternConfig, defaultConfig);
      }
    }

    // Find primary care copay
    let primaryCopay = null;
    let primaryCoins = null;
    let bestPrimaryCopay = null;
    let bestPrimaryScore = -1;

    for (const m of matches) {
      const matchesPrimaryCare = patternConfig.primaryCareKeywords.some(term =>
        m.service.toUpperCase().includes(term.toUpperCase())
      );

      if (matchesPrimaryCare) {
        let score = 0;

        // STRONGLY prioritize exact keyword matches in service name
        const serviceUpper = m.service.toUpperCase();
        let hasExactMatch = false;
        for (const keyword of patternConfig.primaryCareKeywords) {
          if (serviceUpper === keyword.toUpperCase()) {
            score += 100; // Exact match gets highest priority
            hasExactMatch = true;
            break;
          }
        }

        // Check for network indicators in details
        const detailsUpper = m.details.toUpperCase();
        for (const indicator of patternConfig.networkIndicators) {
          if (detailsUpper.includes(indicator.toUpperCase())) {
            score += 10;
            break;
          }
        }

        // Prioritize explicit primary care mentions
        if (detailsUpper.includes('PRIMARY CARE') || detailsUpper.includes('PCP')) {
          score += 5;
        }

        // EXCLUDE infusion therapy - not a regular office visit
        if (detailsUpper.includes('INFUSION')) {
          score -= 50; // Heavy penalty for infusion therapy
        }

        // BOOST regular office visit/clinic/home visit
        if (detailsUpper.includes('OFFICE VISIT') || detailsUpper.includes('CLINIC') || detailsUpper.includes('HOME VISIT')) {
          score += 20; // Boost for actual office visits
        }

        // Prefer PREFERRED over PARTICIPATING
        if (detailsUpper.includes('PREFERRED')) {
          score += 3;
        } else if (detailsUpper.includes('PARTICIPATING')) {
          score += 1;
        }

        console.log(`[Copay Autofill] Primary care candidate: ${m.service} | Score: ${score}${hasExactMatch ? ' (EXACT MATCH)' : ''} | Amount: ${m.isPercentage ? m.amount + '%' : '$' + m.amount}`);

        // Store in debug log
        debugLog.primaryCandidates.push({
          service: m.service,
          score: score,
          exactMatch: hasExactMatch,
          amount: m.isPercentage ? m.amount + '%' : '$' + m.amount,
          details: m.details
        });

        if (score > bestPrimaryScore || (score === bestPrimaryScore && !bestPrimaryCopay)) {
          bestPrimaryScore = score;
          bestPrimaryCopay = m;
          if (m.isPercentage) {
            primaryCoins = m.amount.toFixed(0);
          } else {
            primaryCopay = m.amount.toFixed(2);
          }
          console.log(`[Copay Autofill] ✅ New best primary care match: $${primaryCopay || 'N/A'} (score: ${score})`);
        }
      }
    }

    // Find urgent care copay
    let urgentCopay = null;
    let urgentCoins = null;
    let bestUrgentCopay = null;
    let bestUrgentScore = -1;

    for (const m of matches) {
      const matchesUrgentCare = patternConfig.urgentCareKeywords.some(term =>
        m.service.toUpperCase().includes(term.toUpperCase())
      );

      if (matchesUrgentCare) {
        let score = 0;

        // Check for network indicators in details
        const detailsUpper = m.details.toUpperCase();
        for (const indicator of patternConfig.networkIndicators) {
          if (detailsUpper.includes(indicator.toUpperCase())) {
            score += 10;
            break;
          }
        }

        // Prefer PREFERRED over PARTICIPATING
        if (detailsUpper.includes('PREFERRED')) {
          score += 3;
        } else if (detailsUpper.includes('PARTICIPATING')) {
          score += 1;
        }

        if (score > bestUrgentScore || (score === bestUrgentScore && !bestUrgentCopay)) {
          bestUrgentScore = score;
          bestUrgentCopay = m;
          if (m.isPercentage) {
            urgentCoins = m.amount.toFixed(0);
          } else {
            urgentCopay = m.amount.toFixed(2);
          }
        }
      }
    }

    console.log('[Copay Autofill] Primary care:', { copay: primaryCopay, coinsurance: primaryCoins });
    console.log('[Copay Autofill] Urgent care:', { copay: urgentCopay, coinsurance: urgentCoins });

    return {
      primaryCopay,
      primaryCoins,
      urgentCopay,
      urgentCoins,
      allMatches: matches
    };
  }

  /** -----------------------------
   *  Main Workflow - Step 1: Extract copay from PDF
   *  ----------------------------- */
  async function step1_extractPrimaryCopay() {
    try {
      checkIfStopped(); // Check if user stopped workflow
      console.log('[Copay Autofill] Step 1: Starting primary extraction');
      updateStatus('Primary Insurance', 'Waiting for PDF generation...');

      // Check if PDF.js loaded
      if (!window.pdfjsLib) {
        console.error('[Copay Autofill] PDF.js not loaded yet, waiting...');
        await sleep(2000);
        if (!window.pdfjsLib) {
          throw new Error('PDF.js failed to load. Please refresh the page and try again.');
        }
      }

      // Wait for primary PDF link (might need to wait longer for PDF generation)
      const pdfLinkSelector = 'td.patientData.patientLastChecked_0 a[onclick*="printpdf.do"]';
      console.log('[Copay Autofill] Waiting for PDF link...');
      const pdfLink = await waitForElement(pdfLinkSelector, 45000); // Increased timeout

      updateStatus('Primary Insurance', 'Parsing PDF...');

      // Extract PDF URL
      const onclick = pdfLink.getAttribute('onclick') || '';
      const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)/);
      if (!urlMatch) {
        throw new Error('Could not extract PDF URL');
      }

      let pdfUrl = urlMatch[1].replace(/&amp;/g, '&');
      pdfUrl = new URL(pdfUrl, location.href).href;

      // Reset debug log
      debugLog = {
        matches: [],
        primaryCandidates: [],
        urgentCandidates: [],
        finalValues: {},
        parseTime: 0,
        fetchTime: 0
      };

      // Fetch and parse PDF
      const pdfFetchStart = Date.now();
      const pdfText = await fetchPdfTextRobust(cacheBust(pdfUrl), PDF_FETCH_OPTS);
      debugLog.fetchTime = Date.now() - pdfFetchStart;
      console.log('[Copay Autofill] PDF fetch took:', debugLog.fetchTime, 'ms');
      console.log('[Copay Autofill] PDF text length:', pdfText.length);

      const parseStart = Date.now();
      const { primaryCopay, primaryCoins, urgentCopay, urgentCoins } = extractCopayInfo(pdfText);
      debugLog.parseTime = Date.now() - parseStart;
      console.log('[Copay Autofill] PDF parsing took:', debugLog.parseTime, 'ms');

      // Store final values
      debugLog.finalValues = { primaryCopay, primaryCoins, urgentCopay, urgentCoins };

      // Save debug log to storage so it persists across page refreshes
      saveDebugLog(debugLog);

      console.log('[Copay Autofill] Extracted:', { primaryCopay, primaryCoins, urgentCopay, urgentCoins });

      // Output debug summary after extraction
      console.log('\n\n========== STEP 1 COMPLETE - PDF EXTRACTION ==========');
      console.log('COPY THIS IF SCRIPT FAILS LATER:');
      console.log('---START---');
      console.log(JSON.stringify(debugLog, null, 2));
      console.log('---END---');
      console.log('======================================================\n\n');

      // Update status with what we found
      const foundItems = [];
      if (primaryCopay) foundItems.push(`Primary Copay: $${primaryCopay}`);
      if (primaryCoins) foundItems.push(`Primary Coinsurance: ${primaryCoins}%`);
      if (urgentCopay) foundItems.push(`Urgent Copay: $${urgentCopay}`);
      if (urgentCoins) foundItems.push(`Urgent Coinsurance: ${urgentCoins}%`);

      updateStatus('PDF Parsed', foundItems.length > 0 ? foundItems.join(', ') : 'No copay/coinsurance found');

      // Save values
      setPrimaryCopay(primaryCopay);
      setPrimaryCoins(primaryCoins);
      setUrgentCopay(urgentCopay);
      setUrgentCoins(urgentCoins);

      // If we found ANY values in primary PDF, mark that we should edit primary insurance
      if (primaryCopay || primaryCoins || urgentCopay || urgentCoins) {
        setInsuranceLevel('primary');
        console.log('[Copay Autofill] Values found in PRIMARY PDF - will edit Primary insurance');
      }

      // Check if we need to verify secondary insurance
      const needsSecondary = !primaryCopay && !primaryCoins;

      if (needsSecondary) {
        console.log('[Copay Autofill] Primary has no copay/coinsurance, checking secondary...');
        updateStatus('Secondary Insurance', 'Triggering verification...');

        // Check if secondary verify link exists
        const secondaryVerifyLink = document.querySelector('a[href*="pchart_verify_insurance(\'Secondary\')"]');
        if (secondaryVerifyLink) {
          // Set state BEFORE triggering verification (page will refresh)
          setState('verify_secondary');

          // Trigger secondary verification - page will refresh, autoResumeWorkflow will continue
          if (typeof window.pchart_verify_insurance === 'function') {
            window.pchart_verify_insurance('Secondary');
          } else {
            await syntheticClick(secondaryVerifyLink, 'Secondary Insurance Verify button');
          }
          // Don't call step1b here - let autoResumeWorkflow handle it after page refresh
          return;
        } else {
          console.log('[Copay Autofill] No secondary insurance found');
          // Continue with primary values (even if empty)
          await proceedToAlert();
        }
      } else {
        // Primary has values, proceed
        await proceedToAlert();
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 1 Error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
      // Don't show alert - error is already displayed in status panel
    }
  }

  async function step1b_extractSecondaryCopay() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 1b: Extracting secondary');
      updateStatus('Secondary Insurance', 'Waiting for PDF...');

      // Wait for secondary PDF link
      const secondaryPdfSelector = 'td.patientData.patientLastChecked_1 a[onclick*="printpdf.do"]';
      const pdfLink = await waitForElement(secondaryPdfSelector, 30000);

      updateStatus('Secondary Insurance', 'Parsing PDF...');

      // Extract PDF URL
      const onclick = pdfLink.getAttribute('onclick') || '';
      const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)/);
      if (!urlMatch) {
        throw new Error('Could not extract secondary PDF URL');
      }

      let pdfUrl = urlMatch[1].replace(/&amp;/g, '&');
      pdfUrl = new URL(pdfUrl, location.href).href;

      // Fetch and parse PDF
      const pdfText = await fetchPdfTextRobust(cacheBust(pdfUrl), PDF_FETCH_OPTS);

      const { primaryCopay: secCopay, primaryCoins: secCoins } = extractCopayInfo(pdfText);

      console.log('[Copay Autofill] Secondary extracted:', { copay: secCopay, coinsurance: secCoins });

      // Use secondary values if primary didn't have them
      const currentCopay = getPrimaryCopay();
      const currentCoins = getPrimaryCoins();

      let usedSecondaryValues = false;

      if (!currentCopay && secCopay) {
        setPrimaryCopay(secCopay);
        console.log('[Copay Autofill] Using secondary copay:', secCopay);
        usedSecondaryValues = true;
      }
      if (!currentCoins && secCoins) {
        setPrimaryCoins(secCoins);
        console.log('[Copay Autofill] Using secondary coinsurance:', secCoins);
        usedSecondaryValues = true;
      }

      // If we used ANY values from secondary PDF, mark that we should edit secondary insurance
      if (usedSecondaryValues) {
        setInsuranceLevel('secondary');
        console.log('[Copay Autofill] Values found in SECONDARY PDF - will edit Secondary insurance');
      }

      await proceedToAlert();

    } catch (err) {
      console.error('[Copay Autofill] Secondary extraction error:', err);
      // Continue anyway with what we have
      await proceedToAlert();
    }
  }

  async function proceedToAlert() {
    const primaryCopay = getPrimaryCopay();
    const primaryCoins = getPrimaryCoins();

    // Continue even if no values found - alert will show N/A
    if (!primaryCopay && !primaryCoins) {
      console.warn('[Copay Autofill] No copay or coinsurance found, but continuing to create alert with N/A values');
    }

    if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
      // Scrape guarantor balance from iframe
      console.log('[Copay Autofill] Looking for Guarantor Balance...');

      let balance = '$0.00'; // Default

      try {
        // Try iframe first
        const balancesFrame = document.getElementById('balances') || document.querySelector('iframe[name="balances"]');

        if (balancesFrame && balancesFrame.contentDocument) {
          const iframeDoc = balancesFrame.contentDocument;
          const allRows = iframeDoc.querySelectorAll('tr');
          console.log('[Copay Autofill] Searching iframe, found', allRows.length, 'rows');

          for (const row of allRows) {
            if (row.textContent.includes('Guarantor Balance')) {
              console.log('[Copay Autofill] Found Guarantor Balance row in iframe');
              const balanceCell = row.querySelector('td.dataTotal');
              if (balanceCell) {
                const cellText = balanceCell.textContent.trim();
                const match = cellText.match(/\$\d+(?:,\d{3})*(?:\.\d{2})?/);
                if (match) {
                  balance = match[0];
                  console.log('[Copay Autofill] ✓ Extracted balance from iframe:', balance);
                  break;
                }
              }
            }
          }
        } else {
          console.warn('[Copay Autofill] Balances iframe not found, trying main document');
          // Fallback to main document
          const allRows = document.querySelectorAll('tr');
          for (const row of allRows) {
            if (row.textContent.includes('Guarantor Balance')) {
              const balanceCell = row.querySelector('td.dataTotal');
              if (balanceCell) {
                const match = balanceCell.textContent.trim().match(/\$\d+(?:,\d{3})*(?:\.\d{2})?/);
                if (match) {
                  balance = match[0];
                  console.log('[Copay Autofill] ✓ Extracted balance from main document:', balance);
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[Copay Autofill] Error extracting balance:', err);
      }

      setGuarantorBalance(balance);
      console.log('[Copay Autofill] Final guarantor balance:', balance);

      // Extract next appointment while we're still on the patient chart page
      const nextAppt = extractNextAppointment();
      setNextAppointment(nextAppt);
      console.log('[Copay Autofill] Next appointment:', nextAppt);

      updateStatus('Balance Found', `Patient Balance: ${balance}`);
      await sleep(500);

      // Set state and let current execution continue to next step
      setState('create_alert');
      await step2_createAlert();
    } else {
      // Skip alert, go straight to insurance form
      setState('navigate_to_details');
      await step3_navigateToDetails();
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 2: Create alert note
   *  ----------------------------- */
  async function step2_createAlert() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 2: Creating alert');
      updateStatus('Alert Note', 'Creating alert...');

      // Click "New Alert"
      const alertLink = document.querySelector('a[href*="new_pat_msg"]');
      if (!alertLink) {
        throw new Error('New Alert link not found');
      }

      setState('fill_alert');

      if (typeof window.new_pat_msg === 'function') {
        window.new_pat_msg('Alert');
      } else {
        await syntheticClick(alertLink, 'New Alert button');
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 2 Error:', err);
      // Continue without alert
      setState('navigate_to_details');
      await step3_navigateToDetails();
    }
  }

  async function step2b_fillAlert() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 2b: Filling alert');
      updateStatus('Alert Note', 'Filling alert form...');

      // Wait for message field to be ready
      const messageTextarea = await waitForElement('textarea[name="MESSAGE"], textarea#MESSAGE', 5000);

      // Format alert message
      const copayData = {
        primaryCopay: getPrimaryCopay(),
        primaryCoins: getPrimaryCoins(),
        urgentCopay: getUrgentCopay(),
        urgentCoins: getUrgentCoins(),
        guarantorBalance: getGuarantorBalance(),
        nextAppointment: getNextAppointment()
      };

      const alertMessage = formatCopayAlert(copayData);
      if (messageTextarea) {
        messageTextarea.value = alertMessage;
        console.log('[Copay Autofill] Set alert message');
      }

      // Set TYPE to Alert
      const typeSelect = document.querySelector('select[name="TYPE"], select#TYPE');
      if (typeSelect) {
        typeSelect.value = 'Alert';
        typeSelect.dispatchEvent(new Event('change'));
        await sleep(300);
      }

      // Set checkboxes
      if (ALERT_CONFIG.ALERT_ON_SCHEDULING) {
        const schedulingCheckbox = document.querySelector('input[name="FOR_SCHEDULING"]');
        if (schedulingCheckbox) schedulingCheckbox.checked = true;
      }
      if (ALERT_CONFIG.ALERT_ON_BILLING) {
        const billingCheckbox = document.querySelector('input[name="FOR_BILLING"]');
        if (billingCheckbox) billingCheckbox.checked = true;
      }

      await sleep(500);

      // Click Save
      setState('navigate_to_details');

      if (typeof window.save_message === 'function') {
        window.save_message();
      } else {
        const saveBtn = document.querySelector('input[onclick*="save_message"]');
        if (saveBtn) await syntheticClick(saveBtn, 'Save Alert button');
        else throw new Error('Save button not found');
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 2b Error:', err);
      // Continue without alert
      setState('navigate_to_details');
      await step3_navigateToDetails();
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 3: Navigate to insurance
   *  ----------------------------- */
  async function step3_navigateToDetails() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 3: Navigate to details');
      updateStatus('Insurance Form', 'Navigating...');

      // Check if we're already on insurance page (from alert flow)
      const insuranceLink = document.querySelector('a[href*="goto_insurance_information"]');

      if (insuranceLink) {
        // We're on a page with insurance tab, click it
        setState('open_insurance_editor');

        if (typeof window.goto_insurance_information === 'function') {
          window.goto_insurance_information();
        } else {
          await syntheticClick(insuranceLink, 'Insurance Information link (from alert page)');
        }
      } else {
        // Need to go to patient details first
        const detailsLink = document.querySelector('a[href*="pchart_patient_information"]');
        if (detailsLink) {
          setState('navigate_to_insurance');

          if (typeof window.pchart_patient_information === 'function') {
            window.pchart_patient_information();
          } else {
            await syntheticClick(detailsLink, 'View/Edit Details link');
          }
        } else {
          throw new Error('Could not find navigation link');
        }
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 3 Error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
    }
  }

  async function step3b_navigateToInsurance() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 3b: Navigate to insurance');
      updateStatus('Insurance Form', 'Navigating to insurance tab...');

      const insLink = await waitForElement('a[href*="goto_insurance_information"]', 10000);
      setState('open_insurance_editor');

      if (typeof window.goto_insurance_information === 'function') {
        window.goto_insurance_information();
      } else {
        await syntheticClick(insLink, 'Insurance Information link');
      }

    } catch (err) {
      console.error('[Copay Autofill] Step 3b Error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
    }
  }

  /** -----------------------------
   *  Main Workflow - Step 4: Open editor and fill
   *  ----------------------------- */
  async function step4_openEditor() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 4: Open editor');
      updateStatus('Insurance Form', 'Opening editor...');

      await sleep(500);

      // Determine which insurance level to edit based on which PDF the values came from
      const insuranceLevel = getInsuranceLevel(); // 'primary' or 'secondary'
      console.log('[Copay Autofill] Insurance level to edit:', insuranceLevel);

      let targetRow = null;

      if (insuranceLevel === 'secondary') {
        // Look for secondary insurance row
        targetRow = document.getElementById('tr_Secondary');
        if (targetRow) {
          console.log('[Copay Autofill] ✓ Editing Secondary insurance (values came from secondary PDF)');
        } else {
          console.warn('[Copay Autofill] Secondary PDF had values but tr_Secondary not found, falling back to primary');
          targetRow = document.getElementById('tr_Primary');
        }
      } else {
        // Edit primary insurance
        targetRow = document.getElementById('tr_Primary');
        console.log('[Copay Autofill] ✓ Editing Primary insurance (values came from primary PDF)');
      }

      if (!targetRow) {
        throw new Error('Could not find insurance row to edit');
      }

      // Find edit button within the target row
      const editBtn = targetRow.querySelector('img[onclick*="insurance_edit"]');
      if (!editBtn) {
        throw new Error('Could not find edit button in insurance row');
      }

      setState('fill_copay');
      await syntheticClick(editBtn, 'Edit Insurance button');

    } catch (err) {
      console.error('[Copay Autofill] Step 4 Error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
    }
  }

  async function step5_fillAndSave() {
    try {
      checkIfStopped();
      console.log('[Copay Autofill] Step 5: Fill and save');
      updateStatus('Insurance Form', 'Checking copay values...');

      const primaryCopay = getPrimaryCopay();
      const primaryCoins = getPrimaryCoins();

      console.log('[Copay Autofill] ========================================');
      console.log('[Copay Autofill] Retrieved from storage:');
      console.log('[Copay Autofill] Primary Copay:', primaryCopay);
      console.log('[Copay Autofill] Primary Coinsurance:', primaryCoins);
      console.log('[Copay Autofill] Urgent Copay:', getUrgentCopay());
      console.log('[Copay Autofill] Urgent Coinsurance:', getUrgentCoins());
      console.log('[Copay Autofill] ========================================');

      // If no values, clear the fields and save
      if (!primaryCopay && !primaryCoins) {
        console.log('[Copay Autofill] No copay or coinsurance values found, clearing fields');
        updateStatus('No Values Found', 'Clearing copay fields...');

        await sleep(500);

        // Clear copay field
        const copayField = await waitForElement('input#COPAY', 10000);
        copayField.value = '';
        copayField.dispatchEvent(new Event('input', { bubbles: true }));
        copayField.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Copay Autofill] Cleared copay field');

        // Clear coinsurance field
        const coinsField = document.querySelector('input#CO_INS');
        if (coinsField) {
          coinsField.value = '';
          coinsField.dispatchEvent(new Event('input', { bubbles: true }));
          coinsField.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[Copay Autofill] Cleared coinsurance field');
        }

        // Continue to required fields check and save (don't return early)
      } else {
        // We have values to fill
        await sleep(500);

        const fillItems = [];
        if (primaryCopay) fillItems.push(`Copay: $${primaryCopay}`);
        if (primaryCoins) fillItems.push(`Coinsurance: ${primaryCoins}%`);

        updateStatus('Filling Form', fillItems.join(', '));

        // Fill copay
        if (primaryCopay) {
          const copayField = await waitForElement('input#COPAY', 10000);
          copayField.value = primaryCopay;
          copayField.dispatchEvent(new Event('input', { bubbles: true }));
          copayField.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[Copay Autofill] Set copay:', primaryCopay);
        }

        // Fill coinsurance
        if (primaryCoins) {
          const coinsField = document.querySelector('input#CO_INS');
          if (coinsField) {
            coinsField.value = primaryCoins;
            coinsField.dispatchEvent(new Event('input', { bubbles: true }));
            coinsField.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('[Copay Autofill] Set coinsurance:', primaryCoins);
          }
        }
      }

      // Output debug summary BEFORE clicking save (in case page refreshes)
      // Debug summary available in storage if needed
      // console.log('\n\n========== COPAY AUTOFILL DEBUG SUMMARY (BEFORE SAVE) ==========');
      // console.log('COPY AND PASTE THIS ENTIRE BLOCK:');
      // console.log('---START---');
      // console.log(JSON.stringify(debugLog, null, 2));
      // console.log('---END---');
      // console.log('=================================================================\n\n');

      // Save (form will validate required fields itself)
      await sleep(1000); // Give form time to settle
      updateStatus('Insurance Form', 'Saving...');
      console.log('[Copay Autofill] ============ ATTEMPTING TO SAVE ============');
      console.log('[Copay Autofill] Current page URL:', window.location.href);
      console.log('[Copay Autofill] Page title:', document.title);
      console.log('[Copay Autofill] Looking for form:', !!document.querySelector('form[name="insurance_information_form"]'));
      console.log('[Copay Autofill] COPAY field exists:', !!document.getElementById('COPAY'));
      console.log('[Copay Autofill] COPAY field value:', document.getElementById('COPAY')?.value);
      console.log('[Copay Autofill] CO_INS field exists:', !!document.getElementById('CO_INS'));
      console.log('[Copay Autofill] CO_INS field value:', document.getElementById('CO_INS')?.value);
      console.log('[Copay Autofill] Checking for insurance_save function:', typeof window.insurance_save);
      console.log('[Copay Autofill] Checking for save button with onclick:', !!document.querySelector('input[onclick*="insurance_save"]'));
      console.log('[Copay Autofill] Checking for save button by ID:', !!document.getElementById('Submit'));
      console.log('[Copay Autofill] Checking for save button by value:', !!document.querySelector('input[value="Save Changes"]'));

      console.warn('⏸️⏸️⏸️ ABOUT TO CLICK SAVE - PAGE MAY REFRESH - CHECK CONSOLE NOW ⏸️⏸️⏸️');
      console.warn('Scroll up to see DEBUG SUMMARY');

      // Set state so after page refresh, we navigate home
      setState('navigate_home');

      // Try multiple methods to find and click the save button
      let saved = false;

      // Method 1: Call function directly
      if (typeof window.insurance_save === 'function') {
        console.log('[Copay Autofill] Method 1: Calling window.insurance_save()');
        try {
          window.insurance_save();
          saved = true;
        } catch (e) {
          console.error('[Copay Autofill] insurance_save() threw error:', e);
        }
      }

      // Method 2: Click button by onclick attribute
      if (!saved) {
        const saveBtn = document.querySelector('input[onclick*="insurance_save"]');
        if (saveBtn) {
          console.log('[Copay Autofill] Method 2: Clicking save button by onclick attribute');
          await syntheticClick(saveBtn, 'Save Insurance button (onclick)');
          saved = true;
        }
      }

      // Method 3: Click button by ID
      if (!saved) {
        const saveBtn = document.getElementById('Submit');
        if (saveBtn) {
          console.log('[Copay Autofill] Method 3: Clicking save button by ID');
          await syntheticClick(saveBtn, 'Save Insurance button (ID)');
          saved = true;
        }
      }

      // Method 4: Click button by value
      if (!saved) {
        const saveBtn = document.querySelector('input[value="Save Changes"]');
        if (saveBtn) {
          console.log('[Copay Autofill] Method 4: Clicking save button by value');
          await syntheticClick(saveBtn, 'Save Insurance button (value)');
          saved = true;
        }
      }

      if (!saved) {
        console.error('[Copay Autofill] Could not find or click save button!');
        throw new Error('Save button not found');
      }

      console.log('[Copay Autofill] Save button clicked successfully');
      console.log('[Copay Autofill] Page will refresh, then navigate home...');

      // Page will refresh here, autoResumeWorkflow('navigate_home') will handle navigation

    } catch (err) {
      console.error('[Copay Autofill] Step 5 Error:', err);

      // Output debug summary even on error
      console.log('\n\n========== COPAY AUTOFILL DEBUG SUMMARY (ERROR) ==========');
      console.log('COPY AND PASTE THIS ENTIRE BLOCK:');
      console.log('---START---');
      console.log(JSON.stringify(debugLog, null, 2));
      console.log('---END---');
      console.log('Error:', err?.message || String(err));
      console.log('==========================================================\n\n');

      // Clear state FIRST to prevent re-entry
      clearState();
      isWorkflowRunning = false;

      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      hideStatusPanel();
    }
  }

  /** -----------------------------
   *  State machine auto-resume
   *  ----------------------------- */
  let autoResumeAttempts = 0;
  const MAX_AUTO_RESUME_ATTEMPTS = 3;

  let isWorkflowRunning = false;

  async function autoResumeWorkflow() {
    const state = getState();

    if (state === 'idle' || !state) {
      autoResumeAttempts = 0;
      isWorkflowRunning = false;
      return;
    }

    // Prevent concurrent execution
    if (isWorkflowRunning) {
      console.log('[Copay Autofill] Workflow already running, skipping auto-resume');
      return;
    }

    isWorkflowRunning = true;

    // Prevent infinite loops
    autoResumeAttempts++;
    if (autoResumeAttempts > MAX_AUTO_RESUME_ATTEMPTS) {
      console.error('[Copay Autofill] Too many auto-resume attempts, stopping workflow');
      updateStatus('Max Retries Reached', 'Workflow stopped after 3 attempts');
      await sleep(3000);
      clearState();
      hideStatusPanel();
      autoResumeAttempts = 0;
      isWorkflowRunning = false;
      return;
    }

    console.log('[Copay Autofill] Resuming workflow. State:', state, '(Attempt', autoResumeAttempts, ')');
    updateStatus('Resuming workflow...', `State: ${state}`);

    try {
      if (state === 'waiting_for_pdf') {
        // Page refreshed after clicking Verify, now extract from PDF
        await step1_extractPrimaryCopay();
      } else if (state === 'verify_secondary') {
        // Page refreshed after triggering secondary, now extract from secondary PDF
        await step1b_extractSecondaryCopay();
      } else if (state === 'create_alert') {
        await step2_createAlert();
      } else if (state === 'fill_alert') {
        await step2b_fillAlert();
      } else if (state === 'navigate_to_details') {
        await step3_navigateToDetails();
      } else if (state === 'navigate_to_insurance') {
        await step3b_navigateToInsurance();
      } else if (state === 'open_insurance_editor') {
        await step4_openEditor();
      } else if (state === 'fill_copay') {
        await step5_fillAndSave();
      } else if (state === 'navigate_home') {
        // Navigate back to patient chart
        console.log('[Copay Autofill] Navigating back to patient chart...');
        console.log('[Copay Autofill] Current URL:', window.location.href);
        updateStatus('Complete!', 'Returning to patient chart');

        // Wait for any link to appear on the page (means page has loaded)
        try {
          await waitForElement('a', 5000);
          console.log('[Copay Autofill] Page loaded, links found');
        } catch (e) {
          console.warn('[Copay Autofill] Timeout waiting for links to load');
        }

        // Method 1: Find "View Patient Chart" link with goto_patient_chart onclick
        const allLinks = Array.from(document.querySelectorAll('a'));
        console.log('[Copay Autofill] Total links on page:', allLinks.length);

        const viewPatientLink = allLinks.find(a =>
          a.textContent.includes('View Patient Chart') &&
          a.getAttribute('onclick')?.includes('goto_patient_chart')
        );

        console.log('[Copay Autofill] Found View Patient Chart link?', !!viewPatientLink);

        if (viewPatientLink) {
          console.log('[Copay Autofill] ✅ Clicking View Patient Chart link');
          clearState();
          isWorkflowRunning = false;
          syntheticClick(viewPatientLink, 'View Patient Chart');
          return;
        }

        // Method 2: Call goto_patient_chart function directly
        console.log('[Copay Autofill] Checking for goto_patient_chart function:', typeof window.goto_patient_chart);

        if (typeof window.goto_patient_chart === 'function') {
          console.log('[Copay Autofill] ✅ Calling goto_patient_chart()');
          clearState();
          isWorkflowRunning = false;
          window.goto_patient_chart();
          return;
        }

        console.error('[Copay Autofill] ❌ Could not find navigation method!');
        console.log('[Copay Autofill] Sample links:', allLinks.slice(0, 5).map(a => ({
          text: a.textContent.trim().substring(0, 30),
          onclick: a.getAttribute('onclick')
        })));
        clearState();
        isWorkflowRunning = false;
        hideStatusPanel();
      }

      // Reset counter on successful step
      autoResumeAttempts = 0;
      isWorkflowRunning = false;

    } catch (err) {
      console.error('[Copay Autofill] Auto-resume error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
      autoResumeAttempts = 0;
      isWorkflowRunning = false;
    }
  }

  /** -----------------------------
   *  Button click handler - Start workflow
   *  ----------------------------- */
  async function startCopayWorkflow() {
    try {
      console.log('[Copay Autofill] Starting workflow...');

      // Clear any previous state first
      clearState();

      updateStatus('Starting workflow...', 'Triggering insurance verification');

      // Set state BEFORE clicking verify (so we resume after page refresh)
      setState('waiting_for_pdf');

      // Click the Verify button - this will trigger page refresh
      const verifyLink = document.querySelector('a[href*="pchart_verify_insurance"]');
      if (!verifyLink) {
        throw new Error('Verify link not found');
      }

      console.log('[Copay Autofill] Clicking Verify button...');

      if (typeof window.pchart_verify_insurance === 'function') {
        window.pchart_verify_insurance('Primary');
      } else {
        await syntheticClick(verifyLink, 'Primary Insurance Verify button');
      }

      // Note: Page will refresh here, workflow will resume via autoResumeWorkflow()

    } catch (err) {
      console.error('[Copay Autofill] Start Error:', err);
      updateStatus('Error', err?.message || String(err));
      await sleep(3000);
      clearState();
      hideStatusPanel();
    }
  }

  /** -----------------------------
   *  Status Panel Management
   *  ----------------------------- */
  let statusPanel = null;

  function createStatusPanel() {
    // Only create in top window, not in iframes
    if (window !== window.top) return null;

    // If panel already exists, return it
    if (statusPanel && document.body.contains(statusPanel)) {
      return statusPanel;
    }

    // Remove ALL existing panels from DOM to prevent duplicates
    const allExistingPanels = document.querySelectorAll('#copayAutofillStatus');
    allExistingPanels.forEach(p => p.remove());

    const panel = document.createElement('div');
    panel.id = 'copayAutofillStatus';
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 320px;
      background: white;
      border: 2px solid #22c55e;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 10000;
      font-family: Arial, sans-serif;
      font-size: 13px;
      display: none;
    `;

    panel.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <strong style="color: #22c55e; font-size: 14px;">Copay Autofill</strong>
        <button id="closeStatusPanel" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #999;">&times;</button>
      </div>
      <div id="statusContent" style="font-size: 12px; line-height: 1.6;">
        <div id="currentTask" style="color: #666; margin-bottom: 8px; min-height: 18px;"></div>
        <div id="currentStatus" style="color: #333; margin-bottom: 8px; font-weight: 500; min-height: 18px;"></div>
        <button id="stopWorkflow" style="
          margin-top: 12px;
          width: 100%;
          padding: 8px;
          background-color: #f44336;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          font-weight: bold;
        ">⛔ Stop Workflow</button>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('closeStatusPanel').addEventListener('click', hideStatusPanel);

    const stopBtn = document.getElementById('stopWorkflow');
    stopBtn.addEventListener('click', stopWorkflow);
    stopBtn.addEventListener('mouseover', function() {
      this.style.backgroundColor = '#da190b';
    });
    stopBtn.addEventListener('mouseout', function() {
      this.style.backgroundColor = '#f44336';
    });

    statusPanel = panel;
    return panel;
  }

  function showStatusPanel() {
    const panel = createStatusPanel();
    if (panel) {
      panel.style.display = 'block';
    }
  }

  function hideStatusPanel() {
    // Hide the panel we have reference to
    if (statusPanel) {
      statusPanel.style.display = 'none';
    }

    // Also hide any orphaned panels in the DOM
    const allPanels = document.querySelectorAll('#copayAutofillStatus');
    allPanels.forEach(panel => {
      panel.style.display = 'none';
    });
  }

  function updateStatus(task, status) {
    if (!statusPanel || !document.body.contains(statusPanel)) {
      createStatusPanel();
    }

    console.log('[Copay Autofill] updateStatus:', task, '|', status);

    // Make sure panel exists before trying to update
    if (!statusPanel) {
      console.warn('[Copay Autofill] Status panel could not be created (may be in iframe)');
      return;
    }

    const taskEl = document.getElementById('currentTask');
    const statusEl = document.getElementById('currentStatus');

    console.log('[Copay Autofill] Found elements - taskEl:', !!taskEl, 'statusEl:', !!statusEl);

    if (task !== undefined && taskEl) {
      taskEl.textContent = task;
      console.log('[Copay Autofill] Set task to:', task);
    } else {
      console.warn('[Copay Autofill] Could not update task, element not found');
    }

    if (status !== undefined && statusEl) {
      statusEl.textContent = status;
      console.log('[Copay Autofill] Set status to:', status);
    } else {
      console.warn('[Copay Autofill] Could not update status, element not found');
    }

    showStatusPanel();
  }

  function stopWorkflow() {
    console.log('[Copay Autofill] 🛑 Stop button clicked - halting workflow');
    clearState();
    isWorkflowRunning = false;
    hideStatusPanel();

    // Re-enable main button if it exists
    const mainBtn = document.getElementById(BTN_ID);
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.style.opacity = '1';
      mainBtn.style.cursor = 'pointer';
    }

    console.log('[Copay Autofill] ✅ Workflow stopped successfully');
  }

  // Helper to check if workflow was stopped
  function checkIfStopped() {
    if (!isWorkflowRunning) {
      throw new Error('Workflow stopped by user');
    }
  }

  /** -----------------------------
   *  Button Management
   *  ----------------------------- */
  function hasVerifyLink() {
    return !!document.querySelector('a[href*="pchart_verify_insurance"]');
  }

  function findVerifyCell() {
    const verifyLink = document.querySelector('a[href*="pchart_verify_insurance"]');
    if (!verifyLink) return null;

    let cell = verifyLink.closest('td[align="right"]');
    return cell;
  }

  function mountButton() {
    try {
      const hasLink = hasVerifyLink();
      if (!hasLink) return;

      const existingBtn = document.getElementById(BTN_ID);
      if (existingBtn) return;

      const verifyCell = findVerifyCell();
      if (!verifyCell) return;

      // Main button
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

        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';

        await startCopayWorkflow();
      }, true);

      verifyCell.appendChild(btn);
    } catch (err) {
      console.error('[Copay Autofill] mountButton ERROR:', err);
      console.error('[Copay Autofill] Stack:', err.stack);
    }
  }

  /** -----------------------------
   *  Initialize
   *  ----------------------------- */
  const observer = new MutationObserver(() => mountButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('load', () => {
    try {
      setTimeout(mountButton, 0);
      setTimeout(() => {
        try {
          autoResumeWorkflow();
        } catch (err) {
          console.error('[Copay Autofill] FATAL - autoResumeWorkflow error:', err);
          console.error('[Copay Autofill] Stack:', err.stack);
        }
      }, 1000);
    } catch (err) {
      console.error('[Copay Autofill] FATAL - load event error:', err);
      console.error('[Copay Autofill] Stack:', err.stack);
    }
  });

  // Clean up any orphaned status panels on page unload
  window.addEventListener('beforeunload', () => {
    const allPanels = document.querySelectorAll('#copayAutofillStatus');
    allPanels.forEach(panel => panel.remove());
  });

  setInterval(() => {
    try {
      mountButton();
    } catch (err) {
      console.error('[Copay Autofill] FATAL - mountButton error:', err);
      console.error('[Copay Autofill] Stack:', err.stack);
    }
  }, 2000);

  console.log('[Copay Autofill] Script loaded successfully!');

})();
