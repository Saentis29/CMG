// ==UserScript==
// @name         NextGen - Task Summary Exporter
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  Export task summaries from Deleted and Inbox views as pivot table CSV
// @match        https://*.healthfusionclaims.com/*
// @updateURL    https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20-%20Task%20summary.js
// @downloadURL  https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20-%20Task%20summary.js
// @license      MIT
// @copyright    2025, David Luebbert, MD
// @grant        none
// ==/UserScript==

/**
 * ============================================================================
 * NextGen - Task Summary Exporter
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

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stopFlag = false;

  // ---------- UI Bubble ----------
  function createBubble() {
    let bubble = document.getElementById('exportStatusBubble');
    if (bubble) return bubble;

    bubble = document.createElement('div');
    bubble.id = 'exportStatusBubble';
    Object.assign(bubble.style, {
      position: 'fixed', bottom: '20px', right: '20px',
      width: '340px', background: '#fff', border: '1px solid #ccc',
      borderRadius: '10px', padding: '12px', fontSize: '13px',
      zIndex: '99999', boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
      fontFamily: 'system-ui, sans-serif'
    });
    // Set default dates to today
    const today = new Date();
    const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

    bubble.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>Task Summary Exporter</strong>
        <button id="bubbleClose" style="border:none;background:#eee;border-radius:6px;cursor:pointer;">✕</button>
      </div>
      <div style="margin-bottom:6px;">
        <strong>Date Range:</strong><br>
        <input id="exportStartDate" type="text" placeholder="MM/DD/YYYY" value="${todayStr}" style="width:100px;margin-right:4px;">
        to
        <input id="exportEndDate" type="text" placeholder="MM/DD/YYYY" value="${todayStr}" style="width:100px;margin-left:4px;">
      </div>
      <div style="display:flex;gap:20px;margin-bottom:6px;">
        <div>
          <label style="display:block;margin-bottom:4px;">
            <input type="checkbox" id="summarizeRange" checked> Summarize Range
          </label>
          <label style="display:block;">
            <input type="checkbox" id="individualDates"> Individual Dates
          </label>
        </div>
        <div>
          <label style="display:block;margin-bottom:4px;">
            <input type="checkbox" id="includeDeleted" checked> Deleted Method
          </label>
          <label style="display:block;">
            <input type="checkbox" id="includeInbox" checked> Inbox Method
          </label>
        </div>
        <div>
          <label style="display:block;margin-bottom:4px;">
            <input type="radio" name="statusMode" id="combineStatuses" checked> Combine Statuses
          </label>
          <label style="display:block;">
            <input type="radio" name="statusMode" id="separateStatuses"> Separate by Status
          </label>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button id="startExportBtn" style="flex:1;background:#1976d2;color:#fff;border:none;border-radius:6px;padding:6px;cursor:pointer;">Start Export</button>
        <button id="stopExportBtn" style="flex:1;background:#c62828;color:#fff;border:none;border-radius:6px;padding:6px;cursor:pointer;">Stop</button>
      </div>
      <div style="background:#eee;border-radius:6px;overflow:hidden;margin-bottom:6px;">
        <div id="progressBar" style="height:8px;width:0%;background:#43a047;"></div>
      </div>
      <div id="exportStatus">Ready to export.</div>
      <details style="margin-top:6px;">
        <summary>Debug log</summary>
        <pre id="debugLog" style="max-height:150px;overflow:auto;font-size:11px;"></pre>
      </details>
    `;
    document.body.appendChild(bubble);
    bubble.querySelector('#bubbleClose').onclick = () => bubble.remove();
    return bubble;
  }

  function log(...msg) {
    const pre = document.getElementById('debugLog');
    const ts = new Date().toLocaleTimeString();
    if (pre) { pre.textContent += `[${ts}] ${msg.join(' ')}\n`; pre.scrollTop = pre.scrollHeight; }
    console.log('[Exporter]', ...msg);
  }
  function setStatus(msg) { const el = document.getElementById('exportStatus'); if (el) el.textContent = msg; log(msg); }
  function setProgress(pct) {
    const bar = document.getElementById('progressBar');
    if (bar) bar.style.width = pct + '%';
  }

  // ---------- Button Helpers ----------
  function clickButton(selector, description) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      log(`Clicked ${description}`);
      return true;
    }
    log(`⚠ ${description} not found`);
    return false;
  }

  function ensureDeleted() {
    const deletedBtn = [...document.querySelectorAll('div[name="viewFilt"]')]
      .find(el => el.textContent.trim().toLowerCase() === 'deleted');
    if (deletedBtn && !deletedBtn.classList.contains('selected')) {
      deletedBtn.click();
      log('Clicked Deleted filter');
      return true;
    }
    log('Deleted already selected');
    return false;
  }

  function ensureInbox() {
    const inboxBtn = document.querySelector('#inboxBtn');
    if (inboxBtn && !inboxBtn.classList.contains('selected')) {
      inboxBtn.click();
      log('Clicked Inbox');
      return true;
    }
    log('Inbox already selected');
    return false;
  }

  function configureInboxFilters() {
    // Select All priority
    const priAll = document.querySelector('#priAll');
    if (priAll && !priAll.classList.contains('selected')) {
      priAll.click();
      log('Selected Priority: All');
    }

    // Select All status
    const stusAll = document.querySelector('#stusAll');
    if (stusAll && !stusAll.classList.contains('selected')) {
      stusAll.click();
      log('Selected Status: All');
    }
  }

  // ---------- Table Scraping ----------
  function getTaskTable() {
    return document.querySelector('table.dataTable[id^="tskTable"]');
  }

  function getRows() {
    const tbl = getTaskTable();
    if (!tbl) { log('No task table found'); return []; }
    return tbl.querySelectorAll('tr.dataRow, tr.dataRow2');
  }

  function scrapeRow(row) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 8) return null;

    return {
      from: cells[0]?.innerText.trim(),
      owner: cells[1]?.innerText.trim(),
      received: cells[2]?.innerText.trim(),
      taskType: cells[3]?.innerText.trim(),
      subject: cells[4]?.innerText.trim(),
      patient: cells[5]?.innerText.trim(),
      dueDate: cells[6]?.innerText.trim(),
      status: cells[7]?.innerText.trim()
    };
  }

  function isNextEnabled() {
    const btn = document.querySelector('#next');
    return btn && !btn.classList.contains('disabled');
  }

  async function clickNext() {
    const btn = document.querySelector('#next');
    if (!btn) {
      log('Next button not found');
      return false;
    }
    if (btn.classList.contains('disabled')) {
      log('Next button is disabled');
      return false;
    }
    btn.click();
    log('Clicked Next, waiting for table refresh...');
    await sleep(1000); // Wait for page to load
    return true;
  }

  // ---------- Scraping Functions ----------
  async function scrapeAllPages(source) {
    const allTasks = [];
    let pageNum = 1;

    while (!stopFlag) {
      const rows = getRows();
      log(`${source} table - Page ${pageNum}: ${rows.length} rows`);

      if (rows.length === 0) {
        log(`${source} table - No rows found, stopping`);
        break;
      }

      for (const row of rows) {
        const task = scrapeRow(row);
        if (task) {
          task.source = source;
          allTasks.push(task);
        }
      }

      // If fewer than 20 rows, this is the last page
      if (rows.length < 20) {
        log(`${source} table - Fewer than 20 rows, this is the last page`);
        break;
      }

      // Check if Next button exists and is enabled
      if (!isNextEnabled()) {
        log(`${source} table - No more pages (Next button disabled or missing)`);
        break;
      }

      const advanced = await clickNext();
      if (!advanced) break;

      pageNum++;
      await sleep(500);
    }

    log(`${source} table - Total tasks scraped: ${allTasks.length}`);
    return allTasks;
  }

  // ---------- CSV Generation ----------
  function generateTablesForTasks(tasks, dateLabel, separateByStatus) {
    const tables = [];

    if (!separateByStatus || tasks.length === 0) {
      // Generate single combined table
      tables.push(generatePivotTable(tasks, dateLabel));
    } else {
      // Group tasks by status
      const statusGroups = {};
      for (const task of tasks) {
        const status = task.status || 'Unknown';
        if (!statusGroups[status]) {
          statusGroups[status] = [];
        }
        statusGroups[status].push(task);
      }

      // Generate table for each status
      const statuses = Object.keys(statusGroups).sort();
      for (const status of statuses) {
        const label = `${dateLabel} - Status: ${status}`;
        tables.push(generatePivotTable(statusGroups[status], label));
      }
    }

    return tables;
  }

  function generatePivotTable(tasks, dateLabel) {
    // Get unique owners and task types
    const owners = [...new Set(tasks.map(t => t.owner))].sort();
    const taskTypes = [...new Set(tasks.map(t => t.taskType))].sort();

    log(`${dateLabel} - Unique owners: ${owners.length}, Unique task types: ${taskTypes.length}`);

    // Create count matrix
    const matrix = {};
    for (const owner of owners) {
      matrix[owner] = {};
      for (const type of taskTypes) {
        matrix[owner][type] = 0;
      }
    }

    // Fill matrix with counts
    for (const task of tasks) {
      if (matrix[task.owner] && matrix[task.owner].hasOwnProperty(task.taskType)) {
        matrix[task.owner][task.taskType]++;
      }
    }

    // Build table rows
    const tableRows = [];

    // Date label
    tableRows.push(`"${dateLabel}"`);
    tableRows.push('');

    // Header row
    tableRows.push(['Owner', ...taskTypes, 'TOTAL'].map(v => `"${v}"`).join(','));

    // Data rows - each owner with their task type counts
    for (const owner of owners) {
      const row = [owner];
      let rowTotal = 0;
      for (const type of taskTypes) {
        const count = matrix[owner][type];
        row.push(count);
        rowTotal += count;
      }
      row.push(rowTotal);
      tableRows.push(row.map((v, i) => i === 0 ? `"${v}"` : v).join(','));
    }

    // Total row - sum of each task type across all owners
    const totals = ['TOTAL'];
    let grandTotal = 0;
    for (const type of taskTypes) {
      let sum = 0;
      for (const owner of owners) {
        sum += matrix[owner][type];
      }
      totals.push(sum);
      grandTotal += sum;
    }
    totals.push(grandTotal);
    tableRows.push(totals.map((v, i) => i === 0 ? `"${v}"` : v).join(','));

    // Add two blank rows at the end
    tableRows.push('');
    tableRows.push('');

    return tableRows;
  }

  function generateTaskList(tasks) {
    const listRows = [];

    // Header
    listRows.push(['From', 'Owner', 'Received', 'Task Type', 'Subject', 'Patient', 'Due Date', 'Status'].map(v => `"${v}"`).join(','));

    // Sort tasks alphabetically by task type, then owner
    const sortedTasks = [...tasks].sort((a, b) => {
      if (a.taskType !== b.taskType) {
        return a.taskType.localeCompare(b.taskType);
      }
      return a.owner.localeCompare(b.owner);
    });

    // Add each task as a row
    for (const task of sortedTasks) {
      listRows.push([
        task.from,
        task.owner,
        task.received,
        task.taskType,
        task.subject,
        task.patient,
        task.dueDate,
        task.status
      ].map(v => `"${(v || '').replace(/"/g, '""')}"`).join(','));
    }

    return listRows;
  }

  // ---------- Date Functions ----------
  function parseDate(dateStr) {
    // Parse MM/DD/YYYY
    const parts = dateStr.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  }

  function formatDate(date) {
    // Format as MM/DD/YYYY
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  function getDateRange(startDateStr, endDateStr) {
    const dates = [];
    const start = parseDate(startDateStr);
    const end = parseDate(endDateStr);

    if (!start || !end) return [];

    let current = new Date(start);
    while (current <= end) {
      dates.push(formatDate(current));
      current = addDays(current, 1);
    }

    return dates;
  }

  async function setDateRangeAndSearch(startDate, endDate) {
    const startDateEl = document.querySelector('#dateRange306090Start');
    const endDateEl = document.querySelector('#dateRange306090End');
    const searchBtn = document.querySelector('#searchDateRange306090');

    if (!startDateEl || !endDateEl || !searchBtn) {
      log('⚠ Date range fields not found on page');
      return false;
    }

    // Set the dates
    startDateEl.value = startDate;
    endDateEl.value = endDate;
    log(`Set date range on page: ${startDate} to ${endDate}`);

    // Trigger the search
    searchBtn.click();
    log('Clicked search button, waiting for table to refresh...');
    await sleep(2000); // Wait for table to reload

    return true;
  }

  // ---------- Main Export Function ----------
  async function scrapeForDateRange(startDate, endDate, includeDeleted, includeInbox) {
    const allTasks = [];

    // Scrape Deleted tasks if enabled
    if (includeDeleted) {
      setStatus(`Setting date range for Deleted: ${startDate} to ${endDate}`);
      ensureDeleted();
      await sleep(1000);
      await setDateRangeAndSearch(startDate, endDate);

      setStatus('Scraping Deleted table...');
      const deletedTasks = await scrapeAllPages('Deleted');
      if (stopFlag) return null;
      allTasks.push(...deletedTasks);
    }

    // Scrape Inbox tasks if enabled
    if (includeInbox) {
      setStatus('Switching to Inbox...');
      ensureInbox();
      await sleep(1000);

      setStatus(`Setting date range for Inbox: ${startDate} to ${endDate}`);
      await setDateRangeAndSearch(startDate, endDate);

      configureInboxFilters();
      await sleep(1000);

      setStatus('Scraping Inbox table...');
      const inboxTasks = await scrapeAllPages('Inbox');
      if (stopFlag) return null;
      allTasks.push(...inboxTasks);
    }

    return allTasks;
  }

  async function startExport() {
    stopFlag = false;
    setStatus('Starting export...');
    setProgress(0);

    try {
      // Get date range from bubble inputs
      const startDate = document.getElementById('exportStartDate')?.value;
      const endDate = document.getElementById('exportEndDate')?.value;

      if (!startDate || !endDate) {
        setStatus('⚠ Please enter start and end dates');
        return;
      }

      // Get checkbox and radio button states
      const summarizeRange = document.getElementById('summarizeRange')?.checked;
      const individualDates = document.getElementById('individualDates')?.checked;
      const includeDeleted = document.getElementById('includeDeleted')?.checked;
      const includeInbox = document.getElementById('includeInbox')?.checked;
      const separateByStatus = document.getElementById('separateStatuses')?.checked;

      if (!summarizeRange && !individualDates) {
        setStatus('⚠ Please select Summarize Range and/or Individual Dates');
        return;
      }

      if (!includeDeleted && !includeInbox) {
        setStatus('⚠ Please select Deleted Method and/or Inbox Method');
        return;
      }

      log(`Date range: ${startDate} to ${endDate}`);
      log(`Summarize Range: ${summarizeRange}, Individual Dates: ${individualDates}`);
      log(`Include Deleted: ${includeDeleted}, Include Inbox: ${includeInbox}`);
      log(`Separate by Status: ${separateByStatus}`);

      const csvSections = [];
      const allTasksCollected = [];
      const isSameDate = startDate === endDate;

      // If Summarize Range is checked (and not same date, or only this option is checked)
      if (summarizeRange && (!isSameDate || !individualDates)) {
        setStatus('Scraping range summary...');
        const rangeTasks = await scrapeForDateRange(startDate, endDate, includeDeleted, includeInbox);
        if (!rangeTasks) {
          setStatus('Export stopped.');
          return;
        }

        allTasksCollected.push(...rangeTasks);

        const rangeLabel = isSameDate ? `Date: ${startDate}` : `Date Range: ${startDate} to ${endDate}`;
        const rangeTables = generateTablesForTasks(rangeTasks, rangeLabel, separateByStatus);
        csvSections.push(...rangeTables);

        setProgress(individualDates ? 40 : 90);
      }

      // If Individual Dates is checked
      if (individualDates) {
        const dates = getDateRange(startDate, endDate);
        log(`Processing ${dates.length} individual date(s)`);

        for (let i = 0; i < dates.length; i++) {
          if (stopFlag) {
            setStatus('Export stopped.');
            return;
          }

          const date = dates[i];
          setStatus(`Processing date ${i + 1}/${dates.length}: ${date}`);

          const dateTasks = await scrapeForDateRange(date, date, includeDeleted, includeInbox);
          if (!dateTasks) {
            setStatus('Export stopped.');
            return;
          }

          // Only add to all tasks if we didn't already collect them in range summary
          if (!summarizeRange || isSameDate) {
            allTasksCollected.push(...dateTasks);
          }

          // Only create table(s) if there are tasks for this date
          if (dateTasks.length > 0) {
            const dateTables = generateTablesForTasks(dateTasks, `Date: ${date}`, separateByStatus);
            csvSections.push(...dateTables);
            log(`Generated ${dateTables.length} table(s) for ${date} with ${dateTasks.length} tasks`);
          } else {
            log(`Skipping table for ${date} - no tasks found`);
          }

          const progressBase = summarizeRange ? 40 : 0;
          const progressRange = summarizeRange ? 50 : 90;
          setProgress(progressBase + Math.round((i + 1) / dates.length * progressRange));
        }
      }

      // Add task list at the end
      if (allTasksCollected.length > 0) {
        csvSections.push(generateTaskList(allTasksCollected));
      } else {
        setStatus('No tasks found.');
        setProgress(0);
        return;
      }

      // Combine all sections (each section already has 2 blank rows at the end)
      const csv = csvSections.map(section => section.join('\n')).join('\n');

      // Download CSV
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `task_summary_${timestamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      setStatus('✅ Export complete!');
      setProgress(100);
    } catch (error) {
      log('Error:', error);
      setStatus('❌ Export failed: ' + error.message);
    }
  }

  // ---------- Inject Export Button ----------
  function injectButton() {
    if (document.getElementById('exportTasksBtn')) return;

    // Find the table with view filter buttons
    const viewButtons = document.querySelectorAll('div[name="viewFilt"]');
    if (viewButtons.length === 0) return;

    // Find the parent table row
    const firstViewBtn = viewButtons[0];
    const parentRow = firstViewBtn.closest('tr');
    if (!parentRow) return;

    const parentTable = parentRow.closest('table');
    if (!parentTable) return;

    // Add CSS for shimmer animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes shimmer {
        0% {
          background-position: -200% center;
        }
        100% {
          background-position: 200% center;
        }
      }
      .exportBtn-animate {
        background: linear-gradient(
          90deg,
          #f8f8f8 0%,
          #fff 25%,
          #f8f8f8 50%,
          #fff 75%,
          #f8f8f8 100%
        ) !important;
        background-size: 200% 100% !important;
        animation: shimmer 0.8s ease-out !important;
      }
      #exportTasksBtn:hover {
        background: linear-gradient(to bottom, #fff, #f0f0f0) !important;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);

    // Create a new row for the export button
    const newRow = document.createElement('tr');
    const newCell = document.createElement('td');
    newCell.colSpan = '3';
    newCell.style.paddingTop = '8px';

    const exportBtn = document.createElement('div');
    exportBtn.id = 'exportTasksBtn';
    exportBtn.textContent = '📊 Export Task Summary';
    exportBtn.className = 'selectButton';
    exportBtn.style.cssText = 'width: 100%; text-align: center; font-weight: bold; background: linear-gradient(to bottom, #f8f8f8, #e8e8e8); border: 1px solid #999;';

    exportBtn.onclick = () => {
      // Add shimmer animation
      exportBtn.classList.add('exportBtn-animate');
      setTimeout(() => exportBtn.classList.remove('exportBtn-animate'), 800);

      createBubble();

      document.getElementById('startExportBtn').onclick = startExport;
      document.getElementById('stopExportBtn').onclick = () => {
        stopFlag = true;
        setStatus('⏹ Export stop requested.');
      };
    };

    newCell.appendChild(exportBtn);
    newRow.appendChild(newCell);

    // Insert the new row after the parent row
    parentRow.parentNode.insertBefore(newRow, parentRow.nextSibling);
    log('✅ Export button injected as full-width row');
  }

  // ---------- Observer ----------
  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
