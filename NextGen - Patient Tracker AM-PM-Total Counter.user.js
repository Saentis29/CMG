// ==UserScript==
// @name         NextGen - Patient Tracker AM/PM/Total Counter
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Counts total, AM, PM patients and 'done' patients for the day on Patient Tracker (robust done/no-show logic)
// @match        https://*.healthfusionclaims.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Helper: parse "8:30 AM" to decide if AM (<12:30 PM)
    function isAM(timeStr) {
        if (!timeStr) return false;
        const [hourMin, ampm] = timeStr.trim().split(' ');
        if (!hourMin || !ampm) return false;
        let [hour, minute] = hourMin.split(':').map(Number);
        // Map to 24-hour time
        if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
        if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
        // AM = 00:00 to 12:30 inclusive
        if (hour < 12) return true;
        if (hour === 12 && minute <= 30) return true;
        return false;
}

    // Helper: parse time as Date object for today
    function parseApptTimeToDate(timeStr) {
        if (!timeStr) return null;
        const [hourMin, ampm] = timeStr.trim().split(' ');
        if (!hourMin || !ampm) return null;
        let [hour, minute] = hourMin.split(':').map(Number);
        if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
        if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    }

    // Determine if a patient is "done"
    function isPatientDone(statusCell, apptTime, commentText) {
        if (!statusCell) return false;
        const innerDivs = statusCell.querySelectorAll('div > div');
        if (innerDivs.length === 0) return false;
        const statusText = innerDivs[0].innerText.trim().toUpperCase();

        // Checked out: always done
        if (statusText === 'CHECKED OUT') return true;
        // Two times: always done
        if (innerDivs.length > 1 && innerDivs[1].innerText.includes('/')) return true;

        // "NEW" status: done if >20 min late, or NO SHOW in comments
        if (statusText === 'NEW') {
            // Case 1: second inner div is a single time (e.g., 0:25 or 1:03)
            if (innerDivs.length > 1) {
                const elapsed = innerDivs[1].innerText.split('/')[0].trim();
                const match = /^(\d+):(\d+)$/.exec(elapsed);
                if (match && apptTime) {
                    // Compare apptTime to now
                    const apptDate = parseApptTimeToDate(apptTime);
                    if (apptDate) {
                        const now = new Date();
                        const diffMin = Math.floor((now - apptDate) / 60000);
                        if (diffMin >= 20) return true;
                    }
                }
                // Or, if two times shown, also "done"
                if (innerDivs[1].innerText.includes('/')) return true;
            }
            // Case 2: comment says "NO SHOW"
            if (commentText && /NO SHOW\.?/i.test(commentText)) return true;
        }
        return false;
    }

    // Render the widget, using your preferred formatting
    function renderWidget(amDone, amTotal, pmDone, pmTotal) {
    const totalDone = amDone + pmDone;
    const totalPatients = amTotal + pmTotal;

    const totalStr = totalPatients === 0 ? '-' : `${totalDone} / ${totalPatients}`;
    const amStr = amTotal === 0 ? '-' : (amDone === 0 ? `${amTotal}` : `${amDone} / ${amTotal}`);
    const pmStr = pmTotal === 0 ? '-' : (pmDone === 0 ? `${pmTotal}` : `${pmDone} / ${pmTotal}`);

    return `
        <div style="display: flex; flex-direction: row; gap: 18px; align-items: center; justify-content: center; background: #e9f5f9; border: 1px solid #9be7ff; border-radius: 8px; padding: 5px 10px; font-size: 13px; min-width: 220px;">
            <div style="text-align:center;">
                <div style="font-weight:700; margin-bottom:1px;">AM</div>
                <div style="font-size:15px; margin-bottom:1px;">${amStr}</div>
            </div>
            <div style="border-left:1px solid #9be7ff; height:30px; margin:0 7px;"></div>
            <div style="text-align:center;">
                <div style="font-weight:700; margin-bottom:1px;">PM</div>
                <div style="font-size:15px; margin-bottom:1px;">${pmStr}</div>
            </div>
            <div style="border-left:1px solid #9be7ff; height:30px; margin:0 7px;"></div>
            <div style="text-align:center;">
                <div style="font-weight:700; margin-bottom:1px;">Total</div>
                <div style="font-size:15px; margin-bottom:1px;">${totalStr}</div>
            </div>
        </div>
    `;
}



    function updateWidget() {
        // Only run if Patient Tracker is present
        const pgTitle = document.querySelector('#pgTitle');
        if (!pgTitle || pgTitle.innerText.trim() !== "Patient Tracker") {
            removeWidget();
            return;
        }

        const table = document.querySelector('#patientTrackerTable');
        if (!table) {
            removeWidget();
            return;
        }

        let amTotal = 0, pmTotal = 0, amDone = 0, pmDone = 0;

        // Find all <tr> with valid appointment time and patient (skip BLOCK/LUNCH rows)
        const rows = table.querySelectorAll('tr.appointmentRow');
        rows.forEach(row => {
            const timeCell = row.querySelector('div.selectButton:not(.disabled)');
            if (!timeCell) return;
            const timeStr = timeCell.innerText.trim();
            if (!/^\d{1,2}:\d{2} [AP]M$/.test(timeStr)) return;
            if (row.innerText.includes('BLOCK') || row.innerText.includes('LUNCH') || row.innerText.includes('PROVIDER MEETING')) return;

            // Get the status cell (for the main patient row)
            const statusCell = row.querySelector('td.txtC');
            // Get comments from any nested .dashboardAppointmentNoteText inside the current row
            let commentText = '';
            const commentDivs = row.querySelectorAll('.dashboardAppointmentNoteText');
            commentText = Array.from(commentDivs).map(div => div.innerText).join(' | ');


            const isAMSection = isAM(timeStr);

            if (isAMSection) amTotal++;
            else pmTotal++;

            if (isPatientDone(statusCell, timeStr, commentText)) {
                if (isAMSection) amDone++;
                else pmDone++;
            }
        });

        // Render
        const html = renderWidget(amDone, amTotal, pmDone, pmTotal);

        // Place beside the patientStatusButtonsetContainer
        let widget = document.getElementById('amPmCounterWidget');
        if (!widget) {
            widget = document.createElement('div');
            widget.id = 'amPmCounterWidget';
            widget.style.marginLeft = "30px";
            widget.style.display = "inline-block";
            // Find the status container to the right of
            const statusContainer = document.getElementById('patientStatusButtonsetContainer');
            if (statusContainer && statusContainer.parentNode) {
                statusContainer.parentNode.insertBefore(widget, statusContainer.nextSibling);
            }
        }
        widget.innerHTML = html;
    }

    function removeWidget() {
        const widget = document.getElementById('amPmCounterWidget');
        if (widget && widget.parentNode) widget.parentNode.removeChild(widget);
    }

    // Mutation observer to react to changes in Patient Tracker DOM
    let lastPgTitle = '';
    const observer = new MutationObserver(() => {
        const pgTitle = document.querySelector('#pgTitle');
        const current = pgTitle ? pgTitle.innerText.trim() : '';
        if (current !== lastPgTitle) {
            lastPgTitle = current;
            // Page switched
            setTimeout(updateWidget, 200);
        } else {
            // Data updated
            setTimeout(updateWidget, 200);
        }
    });

    observer.observe(document.body, {childList: true, subtree: true});
    // Initial run (after page load)
    setTimeout(updateWidget, 1200);

    // Optional: update every minute in case time-out "NEW" patients cross 20 min
    setInterval(updateWidget, 60000);

})();
