// ==UserScript==
// @name         ZZ NextGen Insurance Verification
// @namespace    http://tampermonkey.net/
// @version      1.2.7
// @description  Automatically verify insurance for all patients on Today's Appointments
// @author       David Luebbert, MD
// @match        https://txn2.healthfusionclaims.com/electronic/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// @updateURL    https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20Insurance%20Verification.js
// @downloadURL  https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20Insurance%20Verification.js
// @license      MIT
// @copyright    2025, David Luebbert, MD
// ==/UserScript==

/**
 * ============================================================================
 * NextGen Insurance Verification Automation Script (Batch Mode)
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

(function() {
    'use strict';

    // Don't run in iframes - only run in the main page
    if (window !== window.top) {
        return;
    }

    /** -----------------------------
     *  PDF.js worker setup
     *  ----------------------------- */
    try {
        if (window.pdfjsLib) {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
        }
    } catch (_) {}

    // Configuration
    const CONFIG = {
        PDF_POLL_INTERVAL: 2000, // Check for PDF every 2 seconds
        PDF_MAX_WAIT: 30000, // Max 30 seconds waiting for PDF
        MAX_CONCURRENT_REQUESTS: 1, // Process 1 patient at a time to avoid rate limiting
        BATCH_DELAY: 25000, // Wait 25 seconds between patients to avoid rate limiting
        RATE_LIMIT_PAUSE: 90000, // Wait 90 seconds if rate limited (CORS error detected)
        MAX_RETRIES: 3, // Retry rate-limited requests this many times
    };

    // PDF parsing configuration
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
        'PRIMARY CARE PHYSICIAN SERVICES'
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
        'IN NET'
    ];

    // Insurance-specific pattern configuration
    // Maps insurance company patterns to their specific formats
    const INSURANCE_PATTERNS = {
        // Pattern 1: Simple bracket format with detailed descriptions
        // Used by: ALLEGIANCE, ALL SAVERS, GOLDEN RULE
        'ALLEGIANCE': {
            patterns: [
                /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
            ],
            networkIndicators: ['JOHNS HOPKINS', 'IN NETWORK'],
            primaryCareKeywords: ['PCP', 'Office Visit', 'Professional (Physician) Visit - Office'],
            urgentCareKeywords: ['Urgent Care']
        },

        // Pattern 2: UHC format with authorization notes
        // Used by: ALL SAVERS, AARP MEDICARE, UNITED HEALTHCARE
        'UNITED': {
            patterns: [
                /([^[\]]+)\[([^\]]+UHC[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
                /([^[\]]+)\[([^\]]+OFFICE VISIT[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
                /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g  // Simple colon format
            ],
            networkIndicators: ['UHC CHOICE', 'IN NETWORK'],
            primaryCareKeywords: ['PCP OFFICE VISIT', 'Professional (Physician) Visit - Office', 'OFFICE VISIT PRIMARY'],
            urgentCareKeywords: ['Urgent Care']
        },

        // Pattern 3: Seq# coded format (very detailed)
        // Used by: CIGNA HEALTHSPRING, HUMANA MEDICARE
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

        // Pattern 4: CareFirst formats
        // Used by: CAREFIRST (various types)
        'CAREFIRST': {
            patterns: [
                /([^[\]]+)\[([^\]]+BCBS PROVIDERS[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
                /([^[\]]+)\[([^\]]+)\s+\((\d+)\)[^\]]*IN NETWORK[^\]]*\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,
                /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,  // Direct Service[DETAILS]:$amount format
                /([^[\]:]+):\s*[^[\]]*\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
            ],
            networkIndicators: ['BCBS PROVIDERS', 'IN NETWORK', 'BLUECHOICE'],
            primaryCareKeywords: ['Physician Visit - Office', 'Professional (Physician) Visit - Office', 'PRIMARY CARE PHYSICIAN', 'PCP', 'OFFICE VISIT'],
            urgentCareKeywords: ['Urgent Care', 'URGENT CARE']
        },

        // Pattern 5: SUREST format (location-based pricing)
        'SUREST': {
            patterns: [
                /([^:[\]]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g,
                /([^[\]]+)\[([^\]]+VARIES BY[^\]]*)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g
            ],
            networkIndicators: ['VARIES BY LOCATION', 'VARIES BY PRACTITIONER'],
            primaryCareKeywords: ['Physician Visit - Office: Sick', 'Physician Visit - Office: Well', 'Office Visit'],
            urgentCareKeywords: ['Urgent Care']
        },

        // Pattern 6: TRICARE (simple format)
        'TRICARE': {
            patterns: [
                /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g
            ],
            networkIndicators: ['IN NETWORK'],
            primaryCareKeywords: ['Professional (Physician) Visit - Office'],
            urgentCareKeywords: ['Urgent Care']
        },

        // Pattern 7: Aetna format
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

    // Default fallback pattern for unknown insurances
    const DEFAULT_PATTERN_CONFIG = {
        patterns: [
            /([^[\]]+)\[([^\]]+)\]:[\$]?([\d,]+(?:\.\d{2})?%?)/g,  // Bracket format
            /([^:]+):[\$]?([\d,]+(?:\.\d{2})?%?)/g  // Simple colon format
        ],
        networkIndicators: IN_NETWORK_TERMS,
        primaryCareKeywords: PRIMARY_CARE_TERMS,
        urgentCareKeywords: URGENT_CARE_TERMS
    };

    // State management
    let isRunning = false;
    let shouldStop = false;
    let processedPatients = [];
    let csvData = [];
    let statusPanel = null;
    let currentPatientIndex = 0;
    let allPatientsForPhysical = [];

    // State keys for physical navigation
    const STATE_KEY = 'insuranceVerify:state';
    const PATIENTS_KEY = 'insuranceVerify:patients';
    const INDEX_KEY = 'insuranceVerify:index';
    const CSV_KEY = 'insuranceVerify:csv';
    const COPAY_DATA_KEY = 'insuranceVerify:copayData';
    const SECONDARY_CHECK_KEY = 'insuranceVerify:checkSecondary';
    const INSURANCE_LEVEL_KEY = 'insuranceVerify:insuranceLevel'; // 'primary' or 'secondary'

    // Configuration for alert notes
    const ALERT_CONFIG = {
        ENABLE_ALERT_NOTES: true,
        ALERT_ON_SCHEDULING: true,   // Enable "Alert on Scheduling" checkbox
        ALERT_ON_BILLING: true        // Enable "Alert on Billing" checkbox
    };

    /** -----------------------------
     *  Helper Functions
     *  ----------------------------- */

    /**
     * Format copay/coinsurance data for alert message
     * @param {object} copayData - Object containing primaryCopay, primaryCoins, urgentCopay, urgentCoins, guarantorBalance
     * @returns {string} - Formatted message
     */
    /**
     * Extract next appointment info from appointments table
     */
    function extractNextAppointment() {
        try {
            console.log('[Insurance Verify] Looking for appointments...');
            const appointmentsDiv = document.getElementById('patient_chart_appointment');
            console.log('[Insurance Verify] Appointments div found?', !!appointmentsDiv);

            if (!appointmentsDiv) {
                console.log('[Insurance Verify] Appointments div not found');
                return 'No appointment found';
            }

            const rows = appointmentsDiv.querySelectorAll('tr.datacell, tr.datacell2');
            console.log('[Insurance Verify] Found', rows.length, 'appointment rows');

            const today = new Date();
            today.setHours(0, 0, 0, 0); // Reset time to midnight for date comparison

            let closestAppt = null;
            let closestDate = null;

            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 4) continue;

                const typeCell = cells[2]; // Appointment type is 3rd column
                const apptType = typeCell.textContent.trim();
                const apptTypeUpper = apptType.toUpperCase();

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
                if (!isValid) continue;

                // Get appointment date/time from 2nd column
                const dateLink = cells[1].querySelector('a');
                if (!dateLink) continue;

                const dateTimeText = dateLink.textContent.trim();
                const apptDate = new Date(dateTimeText);
                apptDate.setHours(0, 0, 0, 0); // Reset to midnight for fair comparison

                // Only consider today or future appointments
                if (apptDate < today) continue;

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
                }
            }

            return closestAppt || 'No appointment found';
        } catch (err) {
            console.error('[Insurance Verify] Error extracting appointment:', err);
            return 'No appointment found';
        }
    }

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
        const balance = copayData.guarantorBalance || 'N/A';
        const appointment = copayData.nextAppointment || 'No appointment found';

        return `PRIMARY CARE  | Copay: ${pc} | Coinsurance: ${pci}
URGENT CARE   | Copay: ${uc} | Coinsurance: ${uci}

Patient Balance: ${balance}

Next Appt: ${appointment}

        ** Insurance verified: ${today} **`;
    }

    /** -----------------------------
     *  PDF Utility Functions
     *  ----------------------------- */
    function cacheBust(url) {
        try {
            const u = new URL(url, location.href);
            u.searchParams.set('_tm', Date.now().toString(36));
            return u.href;
        } catch {
            return url;
        }
    }

    function isPdfBytes(u8) {
        return u8 && u8.length >= 5 &&
               u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2D;
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

    /**
     * Detect insurance company from PDF text
     * @param {string} pdfText - Full PDF text content
     * @returns {object} - Pattern configuration for detected insurance
     */
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
    async function extractCopayInfo(pdfText) {
        // Normalize whitespace
        const normalized = pdfText
            .replace(/\s+/g, ' ')
            .replace(/\n/g, ' ')
            .trim();

        // Detect insurance company and get appropriate pattern config
        const patternConfig = detectInsuranceCompany(pdfText);

        console.log('[DEBUG] Using pattern config:', patternConfig);

        let matches = [];

        // Try all patterns for this insurance type
        for (const pattern of patternConfig.patterns) {
            let match;
            // Reset regex state
            pattern.lastIndex = 0;

            while ((match = pattern.exec(normalized)) !== null) {
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

        console.log('[DEBUG] Found matches:', matches.length);

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

                // Prioritize explicit primary care mentions in details
                if (detailsUpper.includes('PRIMARY CARE PHYSICIAN')) {
                    score += 15; // Higher bonus for explicit "PRIMARY CARE PHYSICIAN"
                } else if (detailsUpper.includes('PRIMARY CARE') || detailsUpper.includes('PCP')) {
                    score += 5;
                }

                // EXCLUDE infusion therapy - not a regular office visit
                if (detailsUpper.includes('INFUSION')) {
                    score -= 50; // Heavy penalty for infusion therapy
                }

                // EXCLUDE specialist visits - not primary care
                if (detailsUpper.includes('SPECIALIST')) {
                    score -= 100; // Heavy penalty for specialist (not primary care)
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

                console.log(`[Insurance Verify] Primary care candidate: ${m.service} [${m.details}] | Score: ${score}${hasExactMatch ? ' (EXACT MATCH)' : ''} | Amount: ${m.isPercentage ? m.amount + '%' : '$' + m.amount}`);

                // Update if: higher score, OR same score but this one has PRIMARY CARE PHYSICIAN in details, OR same score and lower amount
                const isBetter = score > bestPrimaryScore ||
                    (score === bestPrimaryScore && detailsUpper.includes('PRIMARY CARE PHYSICIAN') && !bestPrimaryCopay?.details.toUpperCase().includes('PRIMARY CARE PHYSICIAN')) ||
                    (score === bestPrimaryScore && !bestPrimaryCopay);

                if (isBetter) {
                    bestPrimaryScore = score;
                    bestPrimaryCopay = m;
                    if (m.isPercentage) {
                        primaryCoins = m.amount.toFixed(0);
                    } else {
                        primaryCopay = m.amount.toFixed(2);
                    }
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

        console.log('[DEBUG] Primary care:', { copay: primaryCopay, coinsurance: primaryCoins });
        console.log('[DEBUG] Urgent care:', { copay: urgentCopay, coinsurance: urgentCoins });
        console.log('⏸️  PAUSED - Check console logs above for all matches and scores. Click the RESUME button to continue...');

        // Create resume button overlay
        const resumeOverlay = document.createElement('div');
        resumeOverlay.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 999999;
            background: white;
            padding: 30px;
            border: 3px solid #ff6b6b;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            text-align: center;
        `;
        resumeOverlay.innerHTML = `
            <div style="font-size: 18px; font-weight: bold; margin-bottom: 15px; color: #ff6b6b;">
                ⏸️ PAUSED FOR DEBUGGING
            </div>
            <div style="margin-bottom: 20px; color: #666;">
                Check console logs for PDF extraction details
            </div>
            <button id="resumeButton" style="
                padding: 12px 30px;
                font-size: 16px;
                font-weight: bold;
                background: #4CAF50;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
            ">▶️ RESUME SCRIPT</button>
        `;
        document.body.appendChild(resumeOverlay);

        // Wait for resume button click
        await new Promise(resolve => {
            document.getElementById('resumeButton').addEventListener('click', () => {
                resumeOverlay.remove();
                console.log('▶️  RESUMED - Continuing script...');
                resolve();
            });
        });

        return {
            primaryCopay,
            primaryCoins,
            urgentCopay,
            urgentCoins,
            allMatches: matches
        };
    }

    // Check if we're on the Today's Appointments page
    function isAppointmentsPage() {
        const pageTitle = document.getElementById('pgTitle');
        return pageTitle && pageTitle.textContent.includes("Today's Appointments");
    }

    // Add the verification button next to the page title
    function addVerifyButton() {
        const pageTitle = document.getElementById('pgTitle');
        if (!pageTitle || document.getElementById('insuranceVerifyBtn')) {
            return; // Already added or wrong page
        }

        const button = document.createElement('button');
        button.id = 'insuranceVerifyBtn';
        button.textContent = 'Verify All Insurance';
        button.style.cssText = 'margin-left: 20px; padding: 8px 16px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;';

        button.addEventListener('click', startVerification);
        button.addEventListener('mouseover', () => button.style.backgroundColor = '#45a049');
        button.addEventListener('mouseout', () => button.style.backgroundColor = '#4CAF50');

        pageTitle.parentNode.insertBefore(button, pageTitle.nextSibling);
        console.log('Insurance Verify button added');
    }

    // Ensure ALL RESOURCES is selected
    function setAllResources() {
        const resourceSelect = document.getElementById('FILTER_RESOURCE');
        if (resourceSelect && resourceSelect.value !== '') {
            resourceSelect.value = '';
            resourceSelect.dispatchEvent(new Event('change'));
            console.log('Set to ALL RESOURCES - page will reload');
            return true;
        }
        return false;
    }

    // Extract patient information from appointment table
    function getPatientList() {
        const patients = [];
        const rows = document.querySelectorAll('tr.datacell[id^="apt"]');

        rows.forEach(row => {
            // Look for patient chart link
            const chartLink = row.querySelector('a[href*="patient_chart.jsp?MEMBER_ID="]');
            if (chartLink) {
                const href = chartLink.getAttribute('href');
                const memberIdMatch = href.match(/MEMBER_ID=(\d+)/);
                if (memberIdMatch) {
                    const memberId = memberIdMatch[1];

                    // Extract patient name from the same cell or nearby
                    const nameCell = row.querySelector('a[title="View Eligibility Response"]');
                    const patientName = nameCell ? nameCell.textContent.trim() : 'Unknown';

                    // Extract appointment time (first cell with time)
                    const cells = row.querySelectorAll('td');
                    const appointmentTime = cells.length > 0 ? cells[0].textContent.trim() : '';

                    // Extract provider (usually in a cell near the end)
                    let provider = '';
                    cells.forEach(cell => {
                        const text = cell.textContent.trim();
                        // Look for provider names (they typically have comma format: LAST, FIRST)
                        if (text.includes(',') && text.split(',').length === 2 && !text.includes('BLOCKED')) {
                            provider = text;
                        }
                    });

                    // Extract status (last few cells usually contain status)
                    let appointmentStatus = '';
                    if (cells.length > 6) {
                        appointmentStatus = cells[cells.length - 3].textContent.trim();
                    }

                    patients.push({
                        memberId: memberId,
                        name: patientName,
                        chartLink: href,
                        appointmentTime: appointmentTime,
                        provider: provider,
                        status: appointmentStatus
                    });
                }
            }
        });

        console.log(`Found ${patients.length} patients with appointments`);
        return patients;
    }

    // Trigger insurance verification for a patient
    async function verifyPatientInsurance(patient, retryCount = 0) {
        // Safety check - ensure we're in main window context
        if (window !== window.top) {
            console.error('verifyPatientInsurance called from iframe context - aborting');
            return {
                success: false,
                patient: patient,
                error: 'Called from iframe context'
            };
        }

        console.log(`Starting verification for ${patient.name} (${patient.memberId})`);
        updateStatus({
            patient: `Patient: ${patient.name} (ID: ${patient.memberId})`,
            task: 'Triggering insurance verification...'
        });

        // Step 1: Trigger verification via POST
        const formData = new URLSearchParams({
            'ACTION_NAME': 'PATIENT_CHART_VERIFY',
            'MEMBER_ID': patient.memberId,
            'TYPE_OF_PLAN': 'Primary',
            'FROM_PAGE': 'PATIENT_CHART'
        });

        try {
            // Make POST request to trigger verification
            await new Promise((resolve, reject) => {
                // Double-check we're still in main context
                if (window !== window.top) {
                    reject('Switched to iframe context');
                    return;
                }

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://txn2.healthfusionclaims.com/electronic/pm/action.do',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    data: formData.toString(),
                    onload: function(response) {
                        if (response.status === 200) {
                            console.log(`Verification triggered for ${patient.name}`);
                            resolve(response);
                        } else {
                            reject(`Failed to verify: ${response.status}`);
                        }
                    },
                    onerror: function(error) {
                        reject(error);
                    }
                });
            });

            // Step 2: Poll for PDF link (with dynamic polling)
            updateStatus({ task: `Polling for verification PDF...` });
            console.log(`Polling for PDF link...`);

            const pdfUrl = await pollForPdfLink(patient);

            if (pdfUrl) {
                console.log(`PDF link found for ${patient.name}: ${pdfUrl}`);
                const fullUrl = `https://txn2.healthfusionclaims.com/electronic${pdfUrl.replace('..', '')}`;

                // Step 3: Parse PDF to extract copay/coinsurance
                updateStatus({ task: 'Parsing PDF for copay/coinsurance...' });
                console.log(`Fetching PDF from: ${fullUrl}`);

                try {
                    const pdfText = await fetchPdfTextRobust(cacheBust(fullUrl), {
                        attempts: 6,
                        initialDelayMs: 400,
                        backoff: 1.6,
                        timeoutPerTryMs: 12000
                    });

                    console.log(`PDF text length: ${pdfText.length} chars`);

                    const { primaryCopay, primaryCoins, urgentCopay, urgentCoins, allMatches } = extractCopayInfo(pdfText);

                    console.log(`Extracted copay data:`, {
                        primaryCopay,
                        primaryCoins,
                        urgentCopay,
                        urgentCoins,
                        matchCount: allMatches.length
                    });

                    updateStatus({ task: '✓ Verification complete!' });

                    return {
                        success: true,
                        patient: patient,
                        pdfUrl: pdfUrl,
                        fullUrl: fullUrl,
                        copayData: {
                            primaryCopay: primaryCopay || '',
                            primaryCoins: primaryCoins || '',
                            urgentCopay: urgentCopay || '',
                            urgentCoins: urgentCoins || ''
                        }
                    };
                } catch (pdfError) {
                    console.error(`PDF parsing error for ${patient.name}:`, pdfError);
                    // Return success but without copay data
                    updateStatus({ task: '⚠ PDF found but parsing failed' });
                    return {
                        success: true,
                        patient: patient,
                        pdfUrl: pdfUrl,
                        fullUrl: fullUrl,
                        copayData: {
                            primaryCopay: '',
                            primaryCoins: '',
                            urgentCopay: '',
                            urgentCoins: ''
                        },
                        pdfError: pdfError.message
                    };
                }
            } else {
                console.warn(`No PDF link found for ${patient.name}`);
                updateStatus({ task: '✗ No PDF link found' });
                return {
                    success: false,
                    patient: patient,
                    error: 'No PDF link found'
                };
            }

        } catch (error) {
            console.error(`Error verifying ${patient.name}:`, error);

            // Check if this is a CORS/rate limiting error
            const isCorsError = error.toString().includes('CORS') ||
                               error.status === 0 ||
                               (error.readyState === 4 && error.status === 0);

            if (isCorsError && retryCount < CONFIG.MAX_RETRIES) {
                console.warn(`⚠ Rate limiting detected for ${patient.name}. Pausing for ${CONFIG.RATE_LIMIT_PAUSE/1000}s before retry ${retryCount + 1}/${CONFIG.MAX_RETRIES}...`);
                updateStatus({ task: `⚠ Rate limited - pausing ${CONFIG.RATE_LIMIT_PAUSE/1000}s before retry...` });

                await sleep(CONFIG.RATE_LIMIT_PAUSE);

                // Retry the same patient
                console.log(`Retrying ${patient.name} (attempt ${retryCount + 2})...`);
                return await verifyPatientInsurance(patient, retryCount + 1);
            }

            updateStatus({ task: `✗ Error: ${error.toString()}` });
            return {
                success: false,
                patient: patient,
                error: error.toString(),
                rateLimited: isCorsError
            };
        }
    }

    // Poll for PDF link until it appears or timeout
    async function pollForPdfLink(patient) {
        const startTime = Date.now();
        const todayDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

        let attempts = 0;
        while (Date.now() - startTime < CONFIG.PDF_MAX_WAIT) {
            attempts++;
            console.log(`Polling attempt ${attempts} for ${patient.name}...`);
            updateStatus({ task: `Checking for PDF (attempt ${attempts})...` });

            try {
                const pdfUrl = await fetchPdfLink(patient);

                if (pdfUrl) {
                    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`✓ PDF found after ${elapsedSeconds}s (${attempts} attempts)`);
                    updateStatus({ task: `✓ PDF found (${elapsedSeconds}s)` });
                    return pdfUrl;
                }
            } catch (error) {
                console.warn(`Error during polling attempt ${attempts}: ${error}`);
            }

            // Wait before next poll
            await sleep(CONFIG.PDF_POLL_INTERVAL);
        }

        // Timeout reached
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        console.warn(`✗ PDF not found after ${elapsedSeconds}s (${attempts} attempts)`);
        return null;
    }

    // Fetch patient chart and extract PDF link using hidden iframe
    async function fetchPdfLink(patient) {
        return new Promise((resolve, reject) => {
            // Create hidden iframe
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.id = `verify-iframe-${patient.memberId}`;

            const removeIframe = () => {
                if (iframe && iframe.parentNode) {
                    try {
                        document.body.removeChild(iframe);
                    } catch (e) {
                        // Iframe already removed, ignore
                    }
                }
            };

            const timeout = setTimeout(() => {
                removeIframe();
                reject('Timeout waiting for patient chart to load');
            }, 15000); // 15 second timeout

            iframe.onload = function() {
                try {
                    // Wait a bit for any dynamic content to load
                    setTimeout(() => {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

                            if (!iframeDoc) {
                                console.error('Unable to access iframe document');
                                clearTimeout(timeout);
                                removeIframe();
                                resolve(null);
                                return;
                            }

                            // Look for the PDF link in the insurance section
                            let pdfLink = iframeDoc.querySelector('a[onclick*="printpdf.do"][onclick*="Eli2"]');
                            let lastCheckedCell = null;

                            if (!pdfLink) {
                                // Fallback: search in the "Last Checked" cell
                                pdfLink = iframeDoc.querySelector('td.patientLastChecked_0 a[onclick*="printpdf.do"]');
                            }

                            // Get the "Last Checked" date
                            const lastCheckedCells = iframeDoc.querySelectorAll('td.patientLastChecked_0');
                            if (lastCheckedCells.length > 0) {
                                lastCheckedCell = lastCheckedCells[0];
                                const lastCheckedText = lastCheckedCell.textContent.trim();
                                console.log(`Last Checked: ${lastCheckedText}`);

                                // Check if it's today's date (format: MM/DD/YYYY)
                                const today = new Date();
                                const todayStr = `${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}/${today.getFullYear()}`;

                                if (!lastCheckedText.includes(todayStr)) {
                                    console.warn(`PDF is not from today. Last checked: ${lastCheckedText}, Today: ${todayStr}`);
                                    clearTimeout(timeout);
                                    removeIframe();
                                    resolve(null); // Return null if not from today
                                    return;
                                }
                            }

                            // Note: We'll need to parse the PDF later to extract copay/coinsurance
                            // The values in the EMR are often outdated or empty

                            if (pdfLink) {
                                const onclickAttr = pdfLink.getAttribute('onclick');
                                console.log(`Found PDF link onclick: ${onclickAttr}`);

                                // Match both regular & and HTML-encoded &amp;
                                const urlMatch = onclickAttr.match(/printpdf\.do\?pageName=Eli2&(?:amp;)?reqID=(\d+)/);
                                if (urlMatch) {
                                    const reqId = urlMatch[1];
                                    const pdfUrl = `../printpdf.do?pageName=Eli2&reqID=${reqId}`;
                                    console.log(`Extracted PDF URL: ${pdfUrl} (verified as today's date)`);
                                    clearTimeout(timeout);
                                    removeIframe();
                                    resolve(pdfUrl);
                                    return;
                                }
                            }

                            // Debug logging
                            console.warn(`No PDF link found in patient chart for ${patient.name}`);
                            const allLinks = iframeDoc.querySelectorAll('a[onclick*="printpdf"]');
                            console.log(`Found ${allLinks.length} printpdf links total`);

                            clearTimeout(timeout);
                            removeIframe();
                            resolve(null);
                        } catch (err) {
                            console.error(`Error reading iframe content: ${err}`);
                            clearTimeout(timeout);
                            removeIframe();
                            reject(err);
                        }
                    }, 2000); // Wait 2 seconds for dynamic content to load
                } catch (err) {
                    clearTimeout(timeout);
                    removeIframe();
                    reject(err);
                }
            };

            iframe.onerror = function(err) {
                clearTimeout(timeout);
                removeIframe();
                reject(`Failed to load patient chart: ${err}`);
            };

            document.body.appendChild(iframe);
            iframe.src = `https://txn2.healthfusionclaims.com/electronic/pm/patient_chart.jsp?MEMBER_ID=${patient.memberId}`;
        });
    }

    // Create status panel
    function createStatusPanel() {
        if (statusPanel) return statusPanel;

        const panel = document.createElement('div');
        panel.id = 'insuranceVerifyStatus';
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 350px;
            background: white;
            border: 2px solid #4CAF50;
            border-radius: 8px;
            padding: 15px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            z-index: 10000;
            font-family: Arial, sans-serif;
            font-size: 13px;
        `;

        panel.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <strong style="color: #4CAF50; font-size: 14px;">Insurance Verification</strong>
                <button id="closeStatusPanel" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #999;">&times;</button>
            </div>
            <div id="statusContent" style="font-size: 12px; line-height: 1.6;">
                <div id="rangeSelector" style="margin-bottom: 10px; display: none;">
                    <div style="margin-bottom: 5px; color: #333; font-weight: bold;">Select Patient Range:</div>
                    <div style="margin-bottom: 8px; color: #666; font-size: 11px;">Found <span id="totalPatients">0</span> patients</div>
                    <input type="text" id="rangeInput" placeholder="e.g., 1-50 or 50" style="
                        width: 100%;
                        padding: 6px;
                        border: 1px solid #ccc;
                        border-radius: 4px;
                        font-size: 12px;
                        margin-bottom: 8px;
                    ">
                    <div style="margin-bottom: 10px; padding: 8px; background: #f0f9ff; border: 1px solid #0284c7; border-radius: 4px;">
                        <label style="display: flex; align-items: center; cursor: pointer; font-size: 12px;">
                            <input type="checkbox" id="physicalNavToggle" style="margin-right: 6px;">
                            <span style="color: #0369a1; font-weight: 500;">Physical Navigation Mode</span>
                        </label>
                        <div style="font-size: 10px; color: #64748b; margin-top: 4px; margin-left: 20px;">
                            ✓ No rate limiting • Slower • Visible page changes
                        </div>
                    </div>
                    <div style="margin-bottom: 8px; padding: 6px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px;">
                        <div style="font-size: 10px; color: #856404;">
                            Behind-scenes: ~9 patients, then 90s pause. ~25s/patient
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="startProcessing" style="
                            flex: 1;
                            padding: 8px;
                            background-color: #4CAF50;
                            color: white;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            font-weight: bold;
                        ">Start</button>
                        <button id="cancelProcessing" style="
                            flex: 1;
                            padding: 8px;
                            background-color: #999;
                            color: white;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            font-weight: bold;
                        ">Cancel</button>
                    </div>
                </div>
                <div id="progressSection" style="display: none;">
                    <div id="overallProgress" style="margin-bottom: 8px;"></div>
                    <div id="currentTask" style="color: #666; margin-bottom: 8px;"></div>
                    <div id="currentPatient" style="color: #333; font-weight: bold;"></div>
                    <div id="successCount" style="color: #4CAF50; margin-top: 8px;"></div>
                    <div id="failureCount" style="color: #f44336; margin-top: 4px;"></div>
                    <button id="stopVerification" style="
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
                    ">Stop Verification</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        document.getElementById('closeStatusPanel').addEventListener('click', hideStatusPanel);
        document.getElementById('stopVerification').addEventListener('click', stopVerification);
        document.getElementById('stopVerification').addEventListener('mouseover', function() {
            this.style.backgroundColor = '#da190b';
        });
        document.getElementById('stopVerification').addEventListener('mouseout', function() {
            this.style.backgroundColor = '#f44336';
        });

        statusPanel = panel;
        return panel;
    }

    // Show status panel
    function showStatusPanel() {
        const panel = createStatusPanel();
        panel.style.display = 'block';
        const stopBtn = document.getElementById('stopVerification');
        if (stopBtn) {
            stopBtn.style.display = 'block';
        }
    }

    // Hide status panel
    function hideStatusPanel() {
        if (statusPanel) {
            statusPanel.style.display = 'none';
        }
    }

    // Stop verification
    function stopVerification() {
        shouldStop = true;
        // Clear ALL physical mode state immediately
        GM_setValue(STATE_KEY, 'idle');
        GM_setValue(PATIENTS_KEY, '[]');
        GM_setValue(INDEX_KEY, 0);
        GM_setValue(CSV_KEY, '[]');
        GM_setValue(COPAY_DATA_KEY, '{}');
        GM_setValue(INSURANCE_LEVEL_KEY, 'primary');

        updateStatus({ task: 'Stopped by user - downloading CSV...' });

        // Download CSV with current progress
        const csvData = JSON.parse(GM_getValue(CSV_KEY, '[]'));
        if (csvData.length > 0) {
            downloadCsv(csvData);
        }

        const stopBtn = document.getElementById('stopVerification');
        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopped';
            stopBtn.style.backgroundColor = '#999';
        }

        // Hide panel after 3 seconds
        setTimeout(() => {
            hideStatusPanel();
            shouldStop = false; // Reset for next run
        }, 3000);
    }

    // Update status panel
    function updateStatus(message) {
        if (!statusPanel) createStatusPanel();

        // Show progress section if it's hidden
        const progressSection = document.getElementById('progressSection');
        if (progressSection && progressSection.style.display === 'none') {
            progressSection.style.display = 'block';
            const rangeSelector = document.getElementById('rangeSelector');
            if (rangeSelector) rangeSelector.style.display = 'none';
        }

        const { overall, task, patient, success, failure, current, total } = message;

        if (current !== undefined && total !== undefined) {
            document.getElementById('overallProgress').textContent = `Processing ${current}/${total} patients`;
        } else if (overall !== undefined) {
            document.getElementById('overallProgress').textContent = overall;
        }
        if (task !== undefined) {
            document.getElementById('currentTask').textContent = task;
        }
        if (patient !== undefined) {
            document.getElementById('currentPatient').textContent = `Current: ${patient}`;
        }
        if (success !== undefined) {
            document.getElementById('successCount').textContent = `✓ Successful: ${success}`;
        }
        if (failure !== undefined) {
            document.getElementById('failureCount').textContent = `✗ Failed: ${failure}`;
        }
    }

    // Download PDF file
    function downloadPdf(pdfUrl, patient, index) {
        const fullUrl = `https://txn2.healthfusionclaims.com/electronic${pdfUrl.replace('..', '')}`;
        const filename = `insurance_${patient.memberId}_${patient.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

        console.log(`Downloading PDF ${index + 1} for ${patient.name}...`);
        updateStatus({ task: `Downloading PDF for ${patient.name}` });

        GM_download({
            url: fullUrl,
            name: filename,
            onload: () => console.log(`Downloaded: ${filename}`),
            onerror: (error) => console.error(`Failed to download ${filename}:`, error)
        });
    }

    // Process all patients
    async function startVerification() {
        if (isRunning) {
            alert('Verification already in progress!');
            return;
        }

        // Ensure ALL RESOURCES is selected - if changed, page will auto-reload
        if (setAllResources()) {
            console.log('Switched to ALL RESOURCES, waiting for page reload...');
            // Page will reload automatically, no need to alert
            return;
        }

        console.log('Starting insurance verification process...');

        const allPatients = getPatientList();

        if (allPatients.length === 0) {
            alert('No patients found in today\'s appointments!');
            return;
        }

        // Show status panel with range selector
        showStatusPanel();
        document.getElementById('rangeSelector').style.display = 'block';
        document.getElementById('progressSection').style.display = 'none';
        document.getElementById('totalPatients').textContent = allPatients.length;
        document.getElementById('rangeInput').value = `1-${allPatients.length}`;

        // Wait for user to start, test, or cancel
        return new Promise((resolve) => {
            document.getElementById('startProcessing').onclick = () => {
                const rangeInput = document.getElementById('rangeInput').value;
                const usePhysical = document.getElementById('physicalNavToggle').checked;

                if (usePhysical) {
                    processPatientRangePhysical(allPatients, rangeInput);
                } else {
                    processPatientRange(allPatients, rangeInput);
                }
                resolve();
            };

            document.getElementById('cancelProcessing').onclick = () => {
                // Clear ALL physical mode state
                GM_setValue(STATE_KEY, 'idle');
                GM_setValue(PATIENTS_KEY, '[]');
                GM_setValue(INDEX_KEY, 0);
                GM_setValue(CSV_KEY, '[]');
                GM_setValue(COPAY_DATA_KEY, '{}');
                hideStatusPanel();
                resolve();
            };
        });
    }

    // Function to input copay and coinsurance for a patient
    async function inputCopayCoinsurance(patient, pcCopay, pcCoins, ucCopay, ucCoins) {
        return new Promise((resolve, reject) => {
            // Create hidden iframe to navigate through insurance pages
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.id = `insurance-input-iframe-${patient.memberId}`;

            let currentStep = 0;
            const steps = ALERT_CONFIG.ENABLE_ALERT_NOTES
                ? ['patient_chart', 'new_alert', 'save_alert', 'insurance_information', 'insurance_edit', 'save']
                : ['patient_chart', 'patient_information', 'insurance_information', 'insurance_edit', 'save'];

            const timeout = setTimeout(() => {
                if (iframe.parentNode) document.body.removeChild(iframe);
                reject('Timeout navigating insurance forms');
            }, 45000); // 45 second timeout (increased for alert step)

            iframe.onload = function() {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const iframeWin = iframe.contentWindow;

                    console.log(`[Behind-scenes] Step ${currentStep}: ${steps[currentStep]}`);

                    if (currentStep === 0) {
                        // Step 1: Patient chart loaded, check if we need to add alert
                        setTimeout(() => {
                            try {
                                // Scrape Guarantor Balance before navigating
                                let guarantorBalance = '';
                                const balanceCell = iframeDoc.querySelector('td.dataTotal');
                                if (balanceCell) {
                                    guarantorBalance = balanceCell.textContent.trim();
                                    console.log(`[Behind-scenes] Found Guarantor Balance: ${guarantorBalance}`);
                                } else {
                                    console.warn('[Behind-scenes] Guarantor Balance not found, will show N/A in alert');
                                }

                                // Store balance temporarily (will be added to copay data in next step)
                                iframe.dataset.guarantorBalance = guarantorBalance;

                                if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
                                    // Click "New Alert"
                                    iframeWin.new_pat_msg('Alert');
                                    currentStep++;
                                } else {
                                    // Skip alert, go to patient information
                                    iframeWin.pchart_patient_information();
                                    currentStep++;
                                }
                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to navigate from patient chart: ${e}`);
                            }
                        }, 1000);

                    } else if (ALERT_CONFIG.ENABLE_ALERT_NOTES && currentStep === 1) {
                        // Step 2: New alert page loaded, fill in alert message
                        setTimeout(() => {
                            try {
                                // Format alert message with guarantor balance
                                const guarantorBalance = iframe.dataset.guarantorBalance || '';
                                const copayData = {
                                    primaryCopay: pcCopay,
                                    primaryCoins: pcCoins,
                                    urgentCopay: ucCopay,
                                    urgentCoins: ucCoins,
                                    guarantorBalance: guarantorBalance
                                };
                                const alertMessage = formatCopayAlert(copayData);

                                // Fill MESSAGE textarea
                                const messageTextarea = iframeDoc.querySelector('textarea[name="MESSAGE"], textarea#MESSAGE');
                                if (messageTextarea) {
                                    messageTextarea.value = alertMessage;
                                    console.log('[Behind-scenes] Set alert message');
                                }

                                // Set TYPE to Alert
                                const typeSelect = iframeDoc.querySelector('select[name="TYPE"], select#TYPE');
                                if (typeSelect) {
                                    typeSelect.value = 'Alert';
                                    typeSelect.dispatchEvent(new Event('change'));
                                    console.log('[Behind-scenes] Set TYPE to Alert');
                                }

                                // Set checkboxes if configured
                                setTimeout(() => {
                                    if (ALERT_CONFIG.ALERT_ON_SCHEDULING) {
                                        const schedulingCheckbox = iframeDoc.querySelector('input[name="FOR_SCHEDULING"]');
                                        if (schedulingCheckbox) schedulingCheckbox.checked = true;
                                    }
                                    if (ALERT_CONFIG.ALERT_ON_BILLING) {
                                        const billingCheckbox = iframeDoc.querySelector('input[name="FOR_BILLING"]');
                                        if (billingCheckbox) billingCheckbox.checked = true;
                                    }

                                    // Click Save Message
                                    iframeWin.save_message();
                                    currentStep++;
                                }, 500);
                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to save alert: ${e}`);
                            }
                        }, 1500);

                    } else if (ALERT_CONFIG.ENABLE_ALERT_NOTES && currentStep === 2) {
                        // Step 3: Alert saved, navigate to insurance information
                        setTimeout(() => {
                            try {
                                iframeWin.goto_insurance_information();
                                currentStep++;
                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to goto insurance information: ${e}`);
                            }
                        }, 1500);

                    } else if (!ALERT_CONFIG.ENABLE_ALERT_NOTES && currentStep === 1) {
                        // Step 2 (no alert): Patient info page loaded, click "Insurance Information"
                        setTimeout(() => {
                            try {
                                iframeWin.goto_insurance_information();
                                currentStep++;
                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to call goto_insurance_information: ${e}`);
                            }
                        }, 1000);

                    } else if (steps[currentStep] === 'insurance_information') {
                        // Step: Insurance info page loaded, find and click edit button for Primary
                        setTimeout(() => {
                            try {
                                // Find the Primary insurance row and extract POLICY_INFO_ID
                                const primaryRow = iframeDoc.querySelector('tr[id="tr_Primary"]');
                                if (!primaryRow) {
                                    throw new Error('Primary insurance row not found');
                                }

                                const editImg = primaryRow.querySelector('img[onclick*="insurance_edit"]');
                                if (!editImg) {
                                    throw new Error('Edit button not found');
                                }

                                const onclickAttr = editImg.getAttribute('onclick');
                                const match = onclickAttr.match(/insurance_edit\('([^']+)','([^']+)'\)/);
                                if (!match) {
                                    throw new Error('Could not parse POLICY_INFO_ID from onclick');
                                }

                                const policyInfoId = match[1];
                                const memberId = match[2];

                                console.log(`[Behind-scenes] Found POLICY_INFO_ID: ${policyInfoId}`);

                                iframeWin.insurance_edit(policyInfoId, memberId);
                                currentStep++;
                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to click edit: ${e}`);
                            }
                        }, 1000);

                    } else if (steps[currentStep] === 'insurance_edit') {
                        // Step: Edit form loaded, fill in copay/coinsurance
                        setTimeout(() => {
                            try {
                                if (pcCopay) {
                                    const copayInput = iframeDoc.getElementById('COPAY');
                                    if (copayInput) {
                                        copayInput.value = pcCopay;
                                        console.log(`[Behind-scenes] Set COPAY to ${pcCopay}`);
                                    }
                                }

                                if (pcCoins) {
                                    const coinsInput = iframeDoc.getElementById('CO_INS');
                                    if (coinsInput) {
                                        coinsInput.value = pcCoins;
                                        console.log(`[Behind-scenes] Set CO_INS to ${pcCoins}`);
                                    }
                                }

                                // Call save function
                                iframeWin.insurance_save();
                                currentStep++;

                                // Wait a bit for save to complete
                                setTimeout(() => {
                                    clearTimeout(timeout);
                                    if (iframe.parentNode) document.body.removeChild(iframe);
                                    resolve();
                                }, 2000);

                            } catch (e) {
                                clearTimeout(timeout);
                                if (iframe.parentNode) document.body.removeChild(iframe);
                                reject(`Failed to fill form: ${e}`);
                            }
                        }, 2000); // Wait longer for form to fully load
                    }
                } catch (e) {
                    clearTimeout(timeout);
                    if (iframe.parentNode) document.body.removeChild(iframe);
                    reject(`Error in iframe: ${e}`);
                }
            };

            iframe.onerror = function(err) {
                clearTimeout(timeout);
                if (iframe.parentNode) document.body.removeChild(iframe);
                reject(`Failed to load page: ${err}`);
            };

            document.body.appendChild(iframe);
            iframe.src = `https://txn2.healthfusionclaims.com/electronic/pm/patient_chart.jsp?MEMBER_ID=${patient.memberId}`;
        });
    }

    // Process patients with the selected range
    async function processPatientRange(allPatients, rangeInput) {
        // Parse range
        let startIndex = 0;
        let endIndex = allPatients.length;

        if (rangeInput && rangeInput.trim() !== '') {
            const trimmed = rangeInput.trim();
            if (trimmed.includes('-')) {
                const parts = trimmed.split('-').map(p => parseInt(p.trim()));
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    startIndex = Math.max(0, parts[0] - 1); // Convert to 0-based index
                    endIndex = Math.min(allPatients.length, parts[1]);
                } else {
                    alert('Invalid range format. Use format like "1-50" or "50-100"');
                    hideStatusPanel();
                    return;
                }
            } else {
                const single = parseInt(trimmed);
                if (!isNaN(single)) {
                    startIndex = Math.max(0, single - 1);
                    endIndex = Math.min(allPatients.length, single);
                } else {
                    alert('Invalid range format. Use format like "1-50" or just "50"');
                    hideStatusPanel();
                    return;
                }
            }
        }

        const patients = allPatients.slice(startIndex, endIndex);

        if (patients.length === 0) {
            alert('No patients in selected range!');
            hideStatusPanel();
            return;
        }

        console.log(`Processing ${patients.length} patients (${startIndex + 1} to ${endIndex} of ${allPatients.length} total)...`);

        // Switch to progress view
        document.getElementById('rangeSelector').style.display = 'none';
        document.getElementById('progressSection').style.display = 'block';

        isRunning = true;
        shouldStop = false;
        processedPatients = [];
        csvData = [['Patient Name', 'Member ID', 'Appointment Time', 'Provider', 'Status', 'PDF URL', 'Primary Copay', 'Primary Coinsurance', 'Urgent Care Copay', 'Urgent Care Coinsurance', 'Verification Status', 'Error']];

        const button = document.getElementById('insuranceVerifyBtn');
        button.disabled = true;
        button.textContent = 'Verification Running...';
        button.style.backgroundColor = '#999';

        console.log(`Processing ${patients.length} patients...`);
        updateStatus({
            overall: `Processing 0 of ${patients.length} patients`,
            success: 0,
            failure: 0
        });

        let successCount = 0;
        let failureCount = 0;

        // Process patients in batches
        for (let i = 0; i < patients.length; i += CONFIG.MAX_CONCURRENT_REQUESTS) {
            // Check if user requested stop
            if (shouldStop) {
                console.log('Verification stopped by user');
                updateStatus({
                    overall: `Stopped! Processed ${i} of ${patients.length} patients`,
                    task: '⚠ Verification stopped by user'
                });
                break;
            }

            const batch = patients.slice(i, i + CONFIG.MAX_CONCURRENT_REQUESTS);

            updateStatus({
                overall: `Processing patients ${i + 1}-${Math.min(i + CONFIG.MAX_CONCURRENT_REQUESTS, patients.length)} of ${patients.length}`
            });

            const results = await Promise.all(batch.map(patient => verifyPatientInsurance(patient)));

            // Process results
            results.forEach((result, index) => {
                const globalIndex = i + index;

                if (result.success) {
                    successCount++;
                    csvData.push([
                        result.patient.name,
                        result.patient.memberId,
                        result.patient.appointmentTime || '',
                        result.patient.provider || '',
                        result.patient.status || '',
                        result.fullUrl,
                        result.copayData?.primaryCopay || '',
                        result.copayData?.primaryCoins || '',
                        result.copayData?.urgentCopay || '',
                        result.copayData?.urgentCoins || '',
                        'Success',
                        result.pdfError || ''
                    ]);
                } else {
                    failureCount++;
                    csvData.push([
                        result.patient.name,
                        result.patient.memberId,
                        result.patient.appointmentTime || '',
                        result.patient.provider || '',
                        result.patient.status || '',
                        '',
                        '', // Primary Copay
                        '', // Primary Coinsurance
                        '', // Secondary Copay
                        '', // Secondary Coinsurance
                        'Failed',
                        result.error
                    ]);
                }

                processedPatients.push(result);
            });

            // Update counts after each batch
            updateStatus({
                success: successCount,
                failure: failureCount
            });

            console.log(`Processed batch ${Math.floor(i / CONFIG.MAX_CONCURRENT_REQUESTS) + 1}`);

            // Add delay between batches to avoid overwhelming the server
            if (i + CONFIG.MAX_CONCURRENT_REQUESTS < patients.length) {
                await sleep(CONFIG.BATCH_DELAY);
            }
        }

        // Export CSV
        const completedCount = successCount + failureCount;
        if (!shouldStop) {
            updateStatus({
                overall: `Complete! Processed ${patients.length} patients`,
                task: 'Exporting CSV...',
                patient: ''
            });
        } else {
            updateStatus({
                task: 'Exporting CSV with partial results...',
                patient: ''
            });
        }

        exportCsv();

        updateStatus({
            task: shouldStop ? '⚠ Stopped - CSV exported with partial results' : '✓ All done! CSV exported.',
        });

        const message = shouldStop
            ? `Verification stopped!\nProcessed ${completedCount} of ${patients.length} patients.\nCSV file downloaded with results so far.`
            : `Verification complete! Processed ${patients.length} patients.\nFirst ${CONFIG.DOWNLOAD_FIRST_N_PDFS} PDFs downloaded.\nCSV file downloaded with all results.`;

        alert(message);

        resetButton();
    }

    // Export results to CSV
    function exportCsv() {
        const csvContent = csvData.map(row =>
            row.map(cell => `"${cell}"`).join(',')
        ).join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `insurance_verification_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        console.log('CSV exported successfully');
    }

    /** -----------------------------
     *  PHYSICAL NAVIGATION MODE
     *  ----------------------------- */
    async function processPatientRangePhysical(allPatients, rangeInput) {
        // Parse range
        let startIndex = 0;
        let endIndex = allPatients.length;

        if (rangeInput && rangeInput.trim() !== '') {
            const trimmed = rangeInput.trim();
            if (trimmed.includes('-')) {
                const parts = trimmed.split('-').map(p => parseInt(p.trim()));
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    startIndex = Math.max(0, parts[0] - 1);
                    endIndex = Math.min(allPatients.length, parts[1]);
                } else {
                    alert('Invalid range format');
                    hideStatusPanel();
                    return;
                }
            } else {
                const single = parseInt(trimmed);
                if (!isNaN(single)) {
                    startIndex = Math.max(0, single - 1);
                    endIndex = Math.min(allPatients.length, single);
                } else {
                    alert('Invalid range format');
                    hideStatusPanel();
                    return;
                }
            }
        }

        const patients = allPatients.slice(startIndex, endIndex);

        if (patients.length === 0) {
            alert('No patients in selected range!');
            hideStatusPanel();
            return;
        }

        console.log(`[Physical Mode] Range: ${rangeInput}, startIndex: ${startIndex}, endIndex: ${endIndex}`);
        console.log(`[Physical Mode] Starting verification for ${patients.length} patients:`, patients.map(p => p.name));

        // Show status panel
        showStatusPanel();
        updateStatus({
            task: 'Starting physical mode verification...',
            current: 0,
            total: patients.length,
            success: 0,
            failure: 0,
            patient: patients[0].name
        });

        // Save state for resuming
        GM_setValue(STATE_KEY, 'verify_patient');
        GM_setValue(PATIENTS_KEY, JSON.stringify(patients));
        GM_setValue(INDEX_KEY, 0);
        GM_setValue(CSV_KEY, JSON.stringify([['Patient Name', 'Member ID', 'Appointment Time', 'Provider', 'Status', 'PDF URL', 'Primary Copay', 'Primary Coinsurance', 'Urgent Care Copay', 'Urgent Care Coinsurance', 'Verification Status', 'Error']]));

        // Start with first patient
        startPhysicalVerification(patients[0], 0, patients.length);
    }

    function startPhysicalVerification(patient, index, total) {
        console.log(`[Physical Mode] Starting patient ${index + 1}/${total}: ${patient.name}`);

        // Find and click the actual patient chart link on the appointments page
        const chartLink = document.querySelector(`a[href*="patient_chart.jsp?MEMBER_ID=${patient.memberId}"]`);

        if (chartLink) {
            console.log(`[Physical Mode] Clicking patient chart link for ${patient.name}`);
            chartLink.click();
        } else {
            console.error(`[Physical Mode] Patient chart link not found for ${patient.name}`);
            // Fallback to direct navigation
            window.location.href = `https://txn2.healthfusionclaims.com/electronic${patient.chartLink}`;
        }
    }

    async function resumePhysicalWorkflow() {
        let state = GM_getValue(STATE_KEY, 'idle');

        if (state === 'idle') {
            return; // No active workflow
        }

        console.log(`[Physical Mode] Resuming workflow. State: ${state}`);

        const patientsJson = GM_getValue(PATIENTS_KEY, '[]');
        const patients = JSON.parse(patientsJson);
        const currentIndex = GM_getValue(INDEX_KEY, 0);
        const csvJson = GM_getValue(CSV_KEY, '[]');
        csvData = JSON.parse(csvJson);

        console.log(`[Physical Mode] Loaded state - Total patients: ${patients.length}, Current index: ${currentIndex}`);

        if (!patients || patients.length === 0) {
            console.error('[Physical Mode] No patients found in state');
            GM_setValue(STATE_KEY, 'idle');
            return;
        }

        const patient = patients[currentIndex];

        // If we're on appointments page in 'verify_patient' state, navigate to patient chart
        if (state === 'verify_patient' && isAppointmentsPage()) {
            console.log(`[Physical Mode] On appointments page, navigating to patient chart for ${patient.name}`);

            showStatusPanel();
            updateStatus({
                task: 'Navigating to patient chart...',
                current: currentIndex + 1,
                total: patients.length,
                success: 0,
                failure: 0,
                patient: patient.name
            });

            await sleep(1000);

            // Find and click the patient chart link
            const chartLink = document.querySelector(`a[href*="patient_chart.jsp?MEMBER_ID=${patient.memberId}"]`);
            if (chartLink) {
                console.log(`[Physical Mode] Clicking chart link for ${patient.name}`);
                chartLink.click();
            } else {
                console.error(`[Physical Mode] Chart link not found for ${patient.name}, using direct navigation`);
                window.location.href = `https://txn2.healthfusionclaims.com/electronic${patient.chartLink}`;
            }
            return;
        }

        // Show status panel if not visible
        showStatusPanel();

        // Count successes and failures from CSV
        let successCount = 0;
        let failureCount = 0;
        for (let i = 1; i < csvData.length; i++) {
            if (csvData[i][10] === 'Success') successCount++;
            if (csvData[i][10] === 'Failed') failureCount++;
        }

        try {
            if (state === 'verify_patient') {
                // We just landed on patient chart, check for existing PDF first
                console.log(`[Physical Mode] Step 1: Check for existing PDF for ${patient.name}`);

                updateStatus({
                    task: 'Checking for existing PDF...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                // Wait for page to fully load
                await sleep(2000);

                // Check if PDF already exists with today's date
                const pdfLinkSelector = 'td.patientData.patientLastChecked_0 a[onclick*="printpdf.do"]';
                let existingPdfLink = document.querySelector(pdfLinkSelector);
                const lastCheckedCells = document.querySelectorAll('td.patientData.patientLastChecked_0');

                let pdfIsFromToday = false;
                if (existingPdfLink && lastCheckedCells.length > 0) {
                    const lastCheckedText = lastCheckedCells[0].textContent.trim();
                    const today = new Date();
                    const todayStr = `${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}/${today.getFullYear()}`;

                    if (lastCheckedText.includes(todayStr)) {
                        pdfIsFromToday = true;
                        console.log(`[Physical Mode] Found existing PDF from today (${todayStr}), skipping verification`);
                    } else {
                        console.log(`[Physical Mode] Found PDF but it's from ${lastCheckedText}, not today (${todayStr})`);
                    }
                }

                if (!pdfIsFromToday) {
                    // Need to trigger verification
                    console.log(`[Physical Mode] Triggering insurance verification for ${patient.name}`);

                    updateStatus({
                        task: 'Triggering insurance verification...',
                        current: currentIndex + 1,
                        total: patients.length,
                        success: successCount,
                        failure: failureCount,
                        patient: patient.name
                    });

                    // Find the verify link and execute its javascript
                    const verifyLink = document.querySelector('a[href*="pchart_verify_insurance"][title*="Verify"]');

                if (verifyLink) {
                    const href = verifyLink.getAttribute('href');
                    console.log(`[Physical Mode] Found verify link with href: ${href}`);

                    // Extract the javascript and execute it
                    if (href && href.startsWith('javascript:')) {
                        const jsCode = href.replace('javascript:', '');
                        console.log(`[Physical Mode] Executing: ${jsCode}`);

                        // Try multiple execution methods
                        try {
                            // Method 1: Use Function constructor to ensure proper scope
                            (new Function(jsCode))();
                        } catch (e1) {
                            console.warn('[Physical Mode] Function() failed:', e1);
                            try {
                                // Method 2: Use window.eval for global scope
                                window.eval(jsCode);
                            } catch (e2) {
                                console.warn('[Physical Mode] window.eval() failed:', e2);
                                try {
                                    // Method 3: Direct eval as last resort
                                    eval(jsCode);
                                } catch (e3) {
                                    console.error('[Physical Mode] All eval methods failed:', e3);
                                }
                            }
                        }
                    } else {
                        console.error('[Physical Mode] Verify link does not contain javascript');
                    }
                } else {
                    console.error('[Physical Mode] Verify link not found');
                    // Try alternate selector
                    const altLink = document.querySelector('a[onclick*="pchart_verify_insurance"]');
                    if (altLink) {
                        console.log('[Physical Mode] Found verify link via onclick, clicking it');
                        altLink.click();
                    }
                }

                    // Wait for verification to complete and PDF to be generated
                    console.log('[Physical Mode] Waiting for PDF to be generated...');

                    updateStatus({
                        task: 'Waiting for PDF generation...',
                        current: currentIndex + 1,
                        total: patients.length,
                        success: successCount,
                        failure: failureCount,
                        patient: patient.name
                    });

                    await sleep(5000); // Initial wait for verification to process

                    // Poll for PDF link to appear
                    let pdfLink = null;
                    let attempts = 0;
                    const maxAttempts = 15; // 15 attempts * 2 seconds = 30 seconds max

                    while (!pdfLink && attempts < maxAttempts) {
                        pdfLink = document.querySelector(pdfLinkSelector);
                        if (pdfLink) {
                            console.log(`[Physical Mode] PDF link found after ${attempts * 2} seconds`);
                            break;
                        }
                        console.log(`[Physical Mode] Attempt ${attempts + 1}/${maxAttempts}: PDF link not found yet...`);
                        await sleep(2000);
                        attempts++;
                    }

                    if (!pdfLink) {
                        console.error(`[Physical Mode] PDF link never appeared after ${maxAttempts * 2} seconds`);
                        // Record failure and move on
                        csvData.push([
                            patient.name,
                            patient.memberId,
                            patient.appointmentTime || '',
                            patient.provider || '',
                            patient.status || '',
                            '',
                            '', '', '', '',
                            'Failed',
                            'PDF link never appeared'
                        ]);
                        GM_setValue(CSV_KEY, JSON.stringify(csvData));
                        await moveToNextPatient(patients, currentIndex);
                        return;
                    }
                } else {
                    console.log(`[Physical Mode] Using existing PDF from today for ${patient.name}`);
                }

                // Now change state to parse_pdf and update the state variable
                GM_setValue(STATE_KEY, 'parse_pdf');
                state = 'parse_pdf'; // Update the local variable too

                // Continue to parse_pdf state (fall through)
            }

            if (state === 'parse_pdf') {
                // PDF should be available now, parse it
                console.log(`[Physical Mode] Step 2: Parse PDF for ${patient.name}`);

                updateStatus({
                    task: 'Parsing PDF for copay information...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                const pdfLinkSelector = 'td.patientData.patientLastChecked_0 a[onclick*="printpdf.do"]';
                const pdfLink = document.querySelector(pdfLinkSelector);

                if (!pdfLink) {
                    console.error(`[Physical Mode] PDF link not found for ${patient.name}`);
                    // Record failure and move to next patient
                    csvData.push([
                        patient.name,
                        patient.memberId,
                        patient.appointmentTime || '',
                        patient.provider || '',
                        patient.status || '',
                        '',
                        '', '', '', '',
                        'Failed',
                        'PDF link not found'
                    ]);

                    await moveToNextPatient(patients, currentIndex);
                    return;
                }

                // Extract PDF URL from onclick attribute
                const onclick = pdfLink.getAttribute('onclick') || '';
                console.log(`[Physical Mode] PDF link onclick: ${onclick}`);

                const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)/);
                if (!urlMatch) {
                    console.error('[Physical Mode] Could not extract PDF URL');
                    csvData.push([
                        patient.name,
                        patient.memberId,
                        patient.appointmentTime || '',
                        patient.provider || '',
                        patient.status || '',
                        '',
                        '', '', '', '',
                        'Failed',
                        'Could not extract PDF URL'
                    ]);
                    await moveToNextPatient(patients, currentIndex);
                    return;
                }

                let pdfUrl = urlMatch[1].replace(/&amp;/g, '&');
                console.log(`[Physical Mode] Extracted PDF path: ${pdfUrl}`);

                // Build full URL - the path is relative to the current page
                let fullUrl;
                if (pdfUrl.startsWith('http')) {
                    fullUrl = pdfUrl;
                } else if (pdfUrl.startsWith('/')) {
                    // Absolute path
                    fullUrl = `${window.location.origin}${pdfUrl}`;
                } else {
                    // Relative path (like ../printpdf.do?...)
                    fullUrl = new URL(pdfUrl, window.location.href).href;
                }

                console.log(`[Physical Mode] Full PDF URL: ${fullUrl}`);

                // Fetch and parse PDF
                try {
                    const pdfText = await fetchPdfTextRobust(cacheBust(fullUrl), {
                        attempts: 6,
                        initialDelayMs: 400,
                        backoff: 1.6,
                        timeoutPerTryMs: 12000
                    });

                    const { primaryCopay, primaryCoins, urgentCopay, urgentCoins } = await extractCopayInfo(pdfText);

                    console.log(`[Physical Mode] Extracted from primary: Copay=${primaryCopay}, Coinsurance=${primaryCoins}`);

                    // Check if we need to check secondary insurance (only if BOTH copay AND coinsurance are missing)
                    const needsSecondaryCheck = !primaryCopay && !primaryCoins;

                    if (needsSecondaryCheck) {
                        console.log(`[Physical Mode] Primary has N/A values, will check secondary insurance`);
                        GM_setValue(SECONDARY_CHECK_KEY, 'true');
                    } else {
                        GM_setValue(SECONDARY_CHECK_KEY, 'false');
                    }

                    // If we found ANY values in primary PDF, mark that we should edit primary insurance
                    if (primaryCopay || primaryCoins || urgentCopay || urgentCoins) {
                        GM_setValue(INSURANCE_LEVEL_KEY, 'primary');
                        console.log('[Physical Mode] Values found in PRIMARY PDF - will edit Primary insurance');
                    }

                    // Save copay data for next step
                    GM_setValue(COPAY_DATA_KEY, JSON.stringify({
                        primaryCopay,
                        primaryCoins,
                        urgentCopay,
                        urgentCoins
                    }));

                    // Add to CSV
                    csvData.push([
                        patient.name,
                        patient.memberId,
                        patient.appointmentTime || '',
                        patient.provider || '',
                        patient.status || '',
                        fullUrl,
                        primaryCopay || '',
                        primaryCoins || '',
                        urgentCopay || '',
                        urgentCoins || '',
                        'Success',
                        ''
                    ]);

                    GM_setValue(CSV_KEY, JSON.stringify(csvData));

                    // Check if we should verify secondary insurance
                    if (needsSecondaryCheck) {
                        console.log('[Physical Mode] Primary has no copay/coinsurance, checking secondary...');

                        // Check if secondary verify link exists
                        const secondaryVerifyLink = document.querySelector('a[href*="pchart_verify_insurance(\'Secondary\')"]');

                        if (secondaryVerifyLink) {
                            // Set state BEFORE triggering verification (page will refresh)
                            GM_setValue(STATE_KEY, 'verify_secondary');

                            // Trigger secondary verification - page will refresh
                            const href = secondaryVerifyLink.getAttribute('href');
                            if (href && href.startsWith('javascript:')) {
                                const jsCode = href.replace('javascript:', '');
                                console.log('[Physical Mode] Triggering secondary verification, page will refresh');
                                try {
                                    (new Function(jsCode))();
                                } catch (e) {
                                    console.error('[Physical Mode] Error triggering secondary verify:', e);
                                }
                            }
                            // Don't continue here - let page refresh and resume in verify_secondary state
                            return;
                        } else {
                            console.log('[Physical Mode] No secondary insurance found, continuing with primary values');
                            // Continue with primary values (even if empty)
                        }
                    }

                    // Always proceed to alert (even if no copay values) - balance and appointment are still important
                    if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
                        // Create alert note (will show N/A for missing copay values)
                        GM_setValue(STATE_KEY, 'add_alert');
                        state = 'add_alert';
                        console.log(`[Physical Mode] Moving to add alert state. State is now: ${state}`);
                        // Continue to add_alert state (fall through)
                    } else if (primaryCopay || primaryCoins || urgentCopay || urgentCoins) {
                        // Skip alert, but only input copay if we have values
                        GM_setValue(STATE_KEY, 'input_copay');
                        state = 'input_copay';
                        console.log(`[Physical Mode] Moving to input copay state. State is now: ${state}`);
                        // Continue to input_copay state (fall through)
                    } else {
                        // No alert enabled and no copay values - skip to next patient
                        console.log(`[Physical Mode] No alert enabled and no copay/coinsurance data, moving to next patient`);
                        await moveToNextPatient(patients, currentIndex);
                        return;
                    }

                } catch (pdfError) {
                    console.error(`[Physical Mode] PDF parsing error:`, pdfError);
                    csvData.push([
                        patient.name,
                        patient.memberId,
                        patient.appointmentTime || '',
                        patient.provider || '',
                        patient.status || '',
                        fullUrl,
                        '', '', '', '',
                        'Failed',
                        pdfError.message
                    ]);
                    await moveToNextPatient(patients, currentIndex);
                }
            }

            if (state === 'verify_secondary') {
                // Step 2b: Parse secondary insurance PDF
                console.log(`[Physical Mode] Step 2b: Parsing secondary insurance for ${patient.name}`);

                updateStatus({
                    task: 'Parsing secondary insurance...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(2000);

                try {
                    // Wait for secondary PDF link
                    const secondaryPdfSelector = 'td.patientData.patientLastChecked_1 a[onclick*="printpdf.do"]';

                    // Poll for PDF link with timeout
                    let secondaryPdfLink = null;
                    let attempts = 0;
                    const maxAttempts = 15;

                    while (!secondaryPdfLink && attempts < maxAttempts) {
                        secondaryPdfLink = document.querySelector(secondaryPdfSelector);
                        if (secondaryPdfLink) {
                            console.log(`[Physical Mode] Secondary PDF link found after ${attempts * 2} seconds`);
                            break;
                        }
                        console.log(`[Physical Mode] Waiting for secondary PDF... attempt ${attempts + 1}/${maxAttempts}`);
                        await sleep(2000);
                        attempts++;
                    }

                    if (!secondaryPdfLink) {
                        console.log('[Physical Mode] Secondary PDF link not found, continuing without secondary values');
                        // Continue to alert/input with what we have
                        const copayData = JSON.parse(GM_getValue(COPAY_DATA_KEY, '{}'));
                        if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
                            GM_setValue(STATE_KEY, 'add_alert');
                            state = 'add_alert';
                        } else {
                            GM_setValue(STATE_KEY, 'input_copay');
                            state = 'input_copay';
                        }
                        // Fall through to next state
                    } else {
                        // Extract and parse secondary PDF
                        const onclick = secondaryPdfLink.getAttribute('onclick') || '';
                        const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)/);

                        if (urlMatch) {
                            let pdfUrl = urlMatch[1].replace(/&amp;/g, '&');
                            let fullUrl = new URL(pdfUrl, window.location.href).href;

                            console.log(`[Physical Mode] Secondary PDF URL: ${fullUrl}`);

                            const pdfText = await fetchPdfTextRobust(cacheBust(fullUrl), {
                                attempts: 6,
                                initialDelayMs: 400,
                                backoff: 1.6,
                                timeoutPerTryMs: 12000
                            });

                            const { primaryCopay: secCopay, primaryCoins: secCoins } = await extractCopayInfo(pdfText);

                            console.log(`[Physical Mode] Extracted from secondary: Copay=${secCopay}, Coinsurance=${secCoins}`);

                            // Update copay data with secondary values if they fill in N/A from primary
                            const copayDataJson = GM_getValue(COPAY_DATA_KEY, '{}');
                            const copayData = JSON.parse(copayDataJson);

                            let usedSecondaryValues = false;

                            if (!copayData.primaryCopay && secCopay) {
                                copayData.primaryCopay = secCopay;
                                console.log(`[Physical Mode] Using secondary copay: ${secCopay}`);
                                usedSecondaryValues = true;
                            }
                            if (!copayData.primaryCoins && secCoins) {
                                copayData.primaryCoins = secCoins;
                                console.log(`[Physical Mode] Using secondary coinsurance: ${secCoins}`);
                                usedSecondaryValues = true;
                            }

                            // If we used ANY values from secondary PDF, mark that we should edit secondary insurance
                            if (usedSecondaryValues) {
                                GM_setValue(INSURANCE_LEVEL_KEY, 'secondary');
                                console.log('[Physical Mode] Values found in SECONDARY PDF - will edit Secondary insurance');
                            }

                            // Save updated data
                            GM_setValue(COPAY_DATA_KEY, JSON.stringify(copayData));

                            // Move to alert or copay input
                            if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
                                GM_setValue(STATE_KEY, 'add_alert');
                                state = 'add_alert';
                                console.log(`[Physical Mode] Moving to add alert state`);
                            } else {
                                GM_setValue(STATE_KEY, 'input_copay');
                                state = 'input_copay';
                                console.log(`[Physical Mode] Moving to input copay state`);
                            }
                            // Fall through to next state
                        }
                    }
                } catch (err) {
                    console.error('[Physical Mode] Secondary extraction error:', err);
                    // Continue anyway with what we have
                    if (ALERT_CONFIG.ENABLE_ALERT_NOTES) {
                        GM_setValue(STATE_KEY, 'add_alert');
                        state = 'add_alert';
                    } else {
                        GM_setValue(STATE_KEY, 'input_copay');
                        state = 'input_copay';
                    }
                    // Fall through
                }
            }

            if (state === 'add_alert') {
                // Step 3a: Click "New Alert" to add insurance verification note
                console.log(`[Physical Mode] Step 3a: Adding alert note for ${patient.name}`);

                updateStatus({
                    task: 'Creating alert note...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(1000);

                // Scrape Guarantor Balance from iframe before navigating away
                let guarantorBalance = '$0.00'; // Default

                try {
                    // Try iframe first
                    const balancesFrame = document.getElementById('balances') || document.querySelector('iframe[name="balances"]');

                    if (balancesFrame && balancesFrame.contentDocument) {
                        const iframeDoc = balancesFrame.contentDocument;
                        const allRows = iframeDoc.querySelectorAll('tr');
                        console.log('[Physical Mode] Searching iframe for Guarantor Balance, found', allRows.length, 'rows');

                        for (const row of allRows) {
                            if (row.textContent.includes('Guarantor Balance')) {
                                console.log('[Physical Mode] Found Guarantor Balance row in iframe');
                                const balanceCell = row.querySelector('td.dataTotal');
                                if (balanceCell) {
                                    const cellText = balanceCell.textContent.trim();
                                    const match = cellText.match(/\$\d+(?:,\d{3})*(?:\.\d{2})?/);
                                    if (match) {
                                        guarantorBalance = match[0];
                                        console.log('[Physical Mode] ✓ Extracted balance from iframe:', guarantorBalance);
                                        break;
                                    }
                                }
                            }
                        }
                    } else {
                        console.warn('[Physical Mode] Balances iframe not found, trying main document');
                        // Fallback to main document
                        const allRows = document.querySelectorAll('tr');
                        for (const row of allRows) {
                            if (row.textContent.includes('Guarantor Balance')) {
                                const balanceCell = row.querySelector('td.dataTotal');
                                if (balanceCell) {
                                    const match = balanceCell.textContent.trim().match(/\$\d+(?:,\d{3})*(?:\.\d{2})?/);
                                    if (match) {
                                        guarantorBalance = match[0];
                                        console.log('[Physical Mode] ✓ Extracted balance from main document:', guarantorBalance);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error('[Physical Mode] Error extracting balance:', err);
                }

                // Extract next appointment info
                const nextAppointment = extractNextAppointment();
                console.log(`[Physical Mode] Next appointment: ${nextAppointment}`);

                // Add balance and appointment to stored copay data
                const copayDataJson = GM_getValue(COPAY_DATA_KEY, '{}');
                const copayData = JSON.parse(copayDataJson);
                copayData.guarantorBalance = guarantorBalance;
                copayData.nextAppointment = nextAppointment;
                GM_setValue(COPAY_DATA_KEY, JSON.stringify(copayData));

                const alertLink = document.querySelector('a[href*="new_pat_msg"]');
                console.log('[Physical Mode] New Alert link:', alertLink);

                if (alertLink) {
                    console.log('[Physical Mode] Clicking New Alert');
                    const href = alertLink.getAttribute('href');
                    if (href && href.includes('javascript:')) {
                        const jsCode = href.replace('javascript:', '');
                        // Change state before clicking (page will reload)
                        GM_setValue(STATE_KEY, 'save_alert');
                        try {
                            (new Function(jsCode))();
                        } catch (e) {
                            console.error('[Physical Mode] Error clicking New Alert:', e);
                        }
                        // Page will reload, script will resume in 'save_alert' state
                        return;
                    }
                } else {
                    console.error('[Physical Mode] New Alert link not found, skipping alert creation');
                    // Skip to insurance input directly
                    GM_setValue(STATE_KEY, 'click_insurance_direct');
                    state = 'click_insurance_direct';
                    // Fall through
                }
            }

            if (state === 'save_alert') {
                // Step 3b: Fill in alert message and save
                console.log(`[Physical Mode] Step 3b: Saving alert message for ${patient.name}`);

                updateStatus({
                    task: 'Saving alert note...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(1500);

                // Get copay data
                const copayDataJson = GM_getValue(COPAY_DATA_KEY, '{}');
                const copayData = JSON.parse(copayDataJson);

                // Format alert message
                const alertMessage = formatCopayAlert(copayData);
                console.log('[Physical Mode] Alert message:', alertMessage);

                // Fill in the MESSAGE textarea
                const messageTextarea = document.querySelector('textarea[name="MESSAGE"], textarea#MESSAGE');
                if (messageTextarea) {
                    messageTextarea.value = alertMessage;
                    console.log('[Physical Mode] Set alert message');
                } else {
                    console.error('[Physical Mode] MESSAGE textarea not found');
                }

                // Ensure TYPE is set to "Alert"
                const typeSelect = document.querySelector('select[name="TYPE"], select#TYPE');
                if (typeSelect) {
                    typeSelect.value = 'Alert';
                    // Trigger change event to show action checkboxes
                    typeSelect.dispatchEvent(new Event('change'));
                    console.log('[Physical Mode] Set TYPE to Alert');

                    await sleep(500);
                }

                // Set checkboxes if configured
                if (ALERT_CONFIG.ALERT_ON_SCHEDULING) {
                    const schedulingCheckbox = document.querySelector('input[name="FOR_SCHEDULING"]');
                    if (schedulingCheckbox) {
                        schedulingCheckbox.checked = true;
                        console.log('[Physical Mode] Enabled Alert on Scheduling');
                    }
                }

                if (ALERT_CONFIG.ALERT_ON_BILLING) {
                    const billingCheckbox = document.querySelector('input[name="FOR_BILLING"]');
                    if (billingCheckbox) {
                        billingCheckbox.checked = true;
                        console.log('[Physical Mode] Enabled Alert on Billing');
                    }
                }

                await sleep(500);

                // Click Save Message
                const saveBtn = document.querySelector('input[onclick*="save_message"]');
                console.log('[Physical Mode] Save Message button:', saveBtn);

                if (saveBtn) {
                    console.log('[Physical Mode] Clicking Save Message');
                    // Change state before clicking (page will reload)
                    GM_setValue(STATE_KEY, 'click_insurance_direct');
                    saveBtn.click();
                    // Page will reload, script will resume in 'click_insurance_direct' state
                    return;
                } else {
                    console.error('[Physical Mode] Save Message button not found');
                }

                // If we couldn't save, move to next patient
                await moveToNextPatient(patients, currentIndex);
            }

            if (state === 'click_insurance_direct') {
                // Step 3c: After alert is saved, go directly to Insurance Information
                console.log(`[Physical Mode] Step 3c: Navigating to insurance info for ${patient.name}`);

                updateStatus({
                    task: 'Opening insurance information...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(1500);

                const insuranceLink = document.querySelector('a[href*="goto_insurance_information"]');
                console.log('[Physical Mode] Insurance link:', insuranceLink);

                if (insuranceLink) {
                    console.log('[Physical Mode] Clicking Insurance Information');
                    const insHref = insuranceLink.getAttribute('href');
                    if (insHref && insHref.includes('javascript:')) {
                        const insJsCode = insHref.replace('javascript:', '');
                        // Change state before clicking
                        GM_setValue(STATE_KEY, 'edit_insurance');
                        try {
                            (new Function(insJsCode))();
                        } catch (e) {
                            console.error('[Physical Mode] Error clicking Insurance:', e);
                        }
                        // Page will reload, script will resume in 'edit_insurance' state
                        return;
                    }
                } else {
                    console.error('[Physical Mode] Insurance link not found');
                }

                // If we couldn't click, move to next patient
                await moveToNextPatient(patients, currentIndex);
            }

            if (state === 'input_copay') {
                // Step 3d: Click "View / Edit Details" to navigate to patient info page
                // (This state is only used if alert notes are disabled)
                console.log(`[Physical Mode] Step 3d: Navigating to patient info for ${patient.name}`);

                updateStatus({
                    task: 'Opening patient information...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                const viewEditLink = document.querySelector('a[href*="pchart_patient_information"]');
                console.log('[Physical Mode] View/Edit Details link:', viewEditLink);

                if (viewEditLink) {
                    console.log('[Physical Mode] Clicking View/Edit Details');
                    const href = viewEditLink.getAttribute('href');
                    if (href && href.includes('javascript:')) {
                        const jsCode = href.replace('javascript:', '');
                        // Change state before clicking (page will reload)
                        GM_setValue(STATE_KEY, 'click_insurance');
                        try {
                            (new Function(jsCode))();
                        } catch (e) {
                            console.error('[Physical Mode] Error clicking View/Edit Details:', e);
                        }
                        // Page will reload, script will resume in 'click_insurance' state
                        return;
                    }
                } else {
                    console.error('[Physical Mode] View/Edit Details link not found, skipping copay input');
                }

                // If we couldn't click, move to next patient
                await moveToNextPatient(patients, currentIndex);
            }

            if (state === 'click_insurance') {
                // Step 3b: Click "2. Insurance Information"
                console.log(`[Physical Mode] Step 3b: Navigating to insurance info for ${patient.name}`);

                updateStatus({
                    task: 'Opening insurance information...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(1000);

                const insuranceLink = document.querySelector('a[href*="goto_insurance_information"]');
                console.log('[Physical Mode] Insurance link:', insuranceLink);

                if (insuranceLink) {
                    console.log('[Physical Mode] Clicking Insurance Information');
                    const insHref = insuranceLink.getAttribute('href');
                    if (insHref && insHref.includes('javascript:')) {
                        const insJsCode = insHref.replace('javascript:', '');
                        // Change state before clicking
                        GM_setValue(STATE_KEY, 'edit_insurance');
                        try {
                            (new Function(insJsCode))();
                        } catch (e) {
                            console.error('[Physical Mode] Error clicking Insurance:', e);
                        }
                        // Page will reload, script will resume in 'edit_insurance' state
                        return;
                    }
                } else {
                    console.error('[Physical Mode] Insurance link not found');
                }

                // If we couldn't click, move to next patient
                await moveToNextPatient(patients, currentIndex);
            }

            if (state === 'edit_insurance') {
                // Step 3c: Click edit button
                console.log(`[Physical Mode] Step 3c: Editing insurance for ${patient.name}`);

                updateStatus({
                    task: 'Editing insurance...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                await sleep(1000);

                // Determine which insurance level to edit based on which PDF the values came from
                const insuranceLevel = GM_getValue(INSURANCE_LEVEL_KEY, 'primary'); // 'primary' or 'secondary'
                console.log('[Physical Mode] Insurance level to edit:', insuranceLevel);

                let targetRow = null;

                if (insuranceLevel === 'secondary') {
                    // Look for secondary insurance row
                    targetRow = document.getElementById('tr_Secondary');
                    if (targetRow) {
                        console.log('[Physical Mode] ✓ Editing Secondary insurance (values came from secondary PDF)');
                    } else {
                        console.warn('[Physical Mode] Secondary PDF had values but tr_Secondary not found, falling back to primary');
                        targetRow = document.getElementById('tr_Primary');
                    }
                } else {
                    // Edit primary insurance
                    targetRow = document.getElementById('tr_Primary');
                    console.log('[Physical Mode] ✓ Editing Primary insurance (values came from primary PDF)');
                }

                if (!targetRow) {
                    console.error('[Physical Mode] Could not find insurance row to edit');
                    await moveToNextPatient(patients, currentIndex);
                    return;
                }

                // Find edit button within the target row
                const editImg = targetRow.querySelector('img[onclick*="insurance_edit"]');
                console.log('[Physical Mode] Edit button:', editImg);

                if (editImg) {
                    console.log('[Physical Mode] Clicking Edit Insurance');
                    const editOnclick = editImg.getAttribute('onclick');
                    if (editOnclick) {
                        // Change state before clicking
                        GM_setValue(STATE_KEY, 'save_copay');
                        try {
                            (new Function(editOnclick))();
                        } catch (e) {
                            console.error('[Physical Mode] Error clicking Edit:', e);
                        }
                        // Page will reload, script will resume in 'save_copay' state
                        return;
                    }
                } else {
                    console.error('[Physical Mode] Edit button not found in insurance row');
                }

                // If we couldn't click, move to next patient
                await moveToNextPatient(patients, currentIndex);
            }

            if (state === 'save_copay') {
                // Step 3d: Input copay/coinsurance and save
                console.log(`[Physical Mode] Step 3d: Saving copay/coinsurance for ${patient.name}`);

                updateStatus({
                    task: 'Saving copay/coinsurance...',
                    current: currentIndex + 1,
                    total: patients.length,
                    success: successCount,
                    failure: failureCount,
                    patient: patient.name
                });

                // Wait longer for edit form to fully load
                await sleep(2000);

                const copayDataJson = GM_getValue(COPAY_DATA_KEY, '{}');
                console.log('[Physical Mode] Copay data JSON from storage:', copayDataJson);

                let copayData;
                try {
                    copayData = JSON.parse(copayDataJson);
                    console.log('[Physical Mode] Parsed copay data:', copayData);
                } catch (e) {
                    console.error('[Physical Mode] Failed to parse copay data:', e);
                    copayData = {};
                }

                // Check if we have any data to input
                if (!copayData || (!copayData.primaryCopay && !copayData.primaryCoins)) {
                    console.warn('[Physical Mode] No copay data available to input!');
                }

                // Input copay
                if (copayData.primaryCopay) {
                    console.log(`[Physical Mode] Attempting to set copay to: ${copayData.primaryCopay}`);
                    const copayInput = document.querySelector('input[name="COPAY"]');
                    console.log('[Physical Mode] Copay input field:', copayInput);
                    console.log('[Physical Mode] Copay input current value:', copayInput ? copayInput.value : 'FIELD NOT FOUND');

                    if (copayInput) {
                        copayInput.value = copayData.primaryCopay;
                        copayInput.dispatchEvent(new Event('input', { bubbles: true }));
                        copayInput.dispatchEvent(new Event('change', { bubbles: true }));
                        console.log(`[Physical Mode] Set copay to ${copayData.primaryCopay}, new value: ${copayInput.value}`);
                    } else {
                        console.error('[Physical Mode] COPAY input field not found!');
                        console.log('[Physical Mode] Available inputs:', Array.from(document.querySelectorAll('input')).map(i => `${i.name}=${i.value}`));
                    }
                } else {
                    console.log('[Physical Mode] No primary copay to input');
                }

                // Input coinsurance
                if (copayData.primaryCoins) {
                    console.log(`[Physical Mode] Attempting to set coinsurance to: ${copayData.primaryCoins}`);
                    const coinsInput = document.querySelector('input[name="CO_INS"]');
                    console.log('[Physical Mode] Coinsurance input field:', coinsInput);
                    console.log('[Physical Mode] Coinsurance input current value:', coinsInput ? coinsInput.value : 'FIELD NOT FOUND');

                    if (coinsInput) {
                        coinsInput.value = copayData.primaryCoins;
                        coinsInput.dispatchEvent(new Event('input', { bubbles: true }));
                        coinsInput.dispatchEvent(new Event('change', { bubbles: true }));
                        console.log(`[Physical Mode] Set coinsurance to ${copayData.primaryCoins}, new value: ${coinsInput.value}`);
                    } else {
                        console.error('[Physical Mode] CO_INS input field not found!');
                    }
                } else {
                    console.log('[Physical Mode] No primary coinsurance to input');
                }

                // Click Save Changes (or Cancel if save will fail)
                await sleep(500);

                // Check if required fields are filled
                const payerId = document.querySelector('input[name="PAYER_ID"], select[name="PAYER_ID"]');
                const insuranceType = document.querySelector('input[name="INSURANCE_TYPE"], select[name="INSURANCE_TYPE"]');
                const insuranceId = document.querySelector('input[name="INSURANCE_ID"]');

                const hasRequiredFields = (payerId && payerId.value) || (insuranceType && insuranceType.value) || (insuranceId && insuranceId.value);

                if (!hasRequiredFields) {
                    console.warn('[Physical Mode] Required insurance fields are missing, clicking Cancel instead of Save');
                    const cancelBtn = document.querySelector('input[value="Cancel"], input[onclick*="cancel"]');
                    if (cancelBtn) {
                        cancelBtn.click();
                        await sleep(1000);
                    }
                } else {
                    const saveBtn = document.querySelector('input[onclick*="insurance_save"]');
                    console.log('[Physical Mode] Save button:', saveBtn);
                    if (saveBtn) {
                        console.log('[Physical Mode] Clicking Save Changes');
                        saveBtn.click();
                        await sleep(2000);
                    } else {
                        console.error('[Physical Mode] Save button not found');
                    }
                }

                // Move to next patient
                await moveToNextPatient(patients, currentIndex);
            }
        } catch (err) {
            console.error(`[Physical Mode] Error:`, err);
            GM_setValue(STATE_KEY, 'idle');
            alert('Physical navigation error: ' + err.message);
        }
    }

    async function moveToNextPatient(patients, currentIndex) {
        const nextIndex = currentIndex + 1;

        // Check if user clicked stop
        if (shouldStop) {
            console.log('[Physical Mode] Stopping verification as requested');
            // Clear ALL state
            GM_setValue(STATE_KEY, 'idle');
            GM_setValue(PATIENTS_KEY, '[]');
            GM_setValue(INDEX_KEY, 0);
            GM_setValue(CSV_KEY, '[]');
            GM_setValue(COPAY_DATA_KEY, '{}');
            GM_setValue(INSURANCE_LEVEL_KEY, 'primary');

            updateStatus({ task: 'Stopped by user' });
            downloadCsv(csvData);
            setTimeout(() => {
                hideStatusPanel();
                shouldStop = false;
            }, 3000);
            return;
        }

        if (nextIndex >= patients.length) {
            // All done!
            console.log('[Physical Mode] All patients processed!');
            GM_setValue(STATE_KEY, 'idle');

            // Export CSV
            exportCsv();

            updateStatus({ task: `Complete! Processed ${patients.length} patients. CSV downloaded.` });

            // Hide status panel after 3 seconds
            setTimeout(() => {
                hideStatusPanel();
            }, 3000);

            // Don't navigate away - user can navigate manually
            return;
        } else {
            // Save updated index and CSV
            GM_setValue(INDEX_KEY, nextIndex);
            GM_setValue(CSV_KEY, JSON.stringify(csvData));
            GM_setValue(STATE_KEY, 'verify_patient');
            GM_setValue(INSURANCE_LEVEL_KEY, 'primary'); // Reset for next patient

            const nextPatient = patients[nextIndex];
            console.log(`[Physical Mode] Moving to next patient: ${nextPatient.name}`);

            // Navigate back to appointments page first, then to next patient
            // Use today's date for the appointments link
            const today = new Date();
            const dateStr = `${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}/${today.getFullYear()}`;
            const appointmentsUrl = `https://txn2.healthfusionclaims.com/electronic/pm/action.do?ACTION_NAME=TODAYS_APPOINTMENTS_DISPLAY&FILTER_DATE=${dateStr}`;

            // Wait a bit before navigating
            await sleep(2000);

            // Go back to appointments page - the script will resume and navigate to next patient
            window.location.href = appointmentsUrl;
        }
    }

    // Helper function to sleep
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Reset button state
    function resetButton() {
        isRunning = false;
        shouldStop = false;
        const button = document.getElementById('insuranceVerifyBtn');
        if (button) {
            button.disabled = false;
            button.textContent = 'Verify All Insurance';
            button.style.backgroundColor = '#4CAF50';
        }
        // Hide stop button
        const stopBtn = document.getElementById('stopVerification');
        if (stopBtn) {
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.textContent = 'Stop Verification';
            stopBtn.style.backgroundColor = '#f44336';
        }
    }

    // Initialize when page loads
    function init() {
        if (isAppointmentsPage()) {
            addVerifyButton();
        }

        // Auto-resume physical navigation workflow if in progress
        setTimeout(() => {
            resumePhysicalWorkflow();
        }, 1000);
    }

    // Run on page load and watch for dynamic content
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Also watch for page changes (in case it's a SPA)
    const observer = new MutationObserver(() => {
        if (isAppointmentsPage() && !document.getElementById('insuranceVerifyBtn')) {
            addVerifyButton();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    console.log('NextGen Insurance Verification script loaded');
})();
