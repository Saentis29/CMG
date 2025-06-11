// ==UserScript==
// @name         NextGen - Done Button for Tasks (Auto Confirm)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Adds "Done" button beside Close to accept and complete tasks with auto-confirm
// @updateURL    https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20-%20Done%20Button%20for%20Tasks%20(Auto%20Confirm).user.js
// @downloadURL  https://github.com/Saentis29/CMG/raw/refs/heads/main/NextGen%20-%20Done%20Button%20for%20Tasks%20(Auto%20Confirm).user.js
// @match        *://*.healthfusionclaims.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function createDoneButton() {
        const btn = document.createElement('button');
        btn.id = 'btnDoneTask';
        btn.textContent = 'Done';
        btn.style.padding = '6px 10px';
        btn.style.backgroundColor = '#007bff';
        btn.style.color = 'white';
        btn.style.border = 'none';
        btn.style.borderRadius = '4px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '12px';
        btn.style.fontWeight = 'bold';
        btn.style.marginLeft = '12px';
        return btn;
    }

    function attachDoneBehavior(button) {
        button.onclick = async () => {
            const acceptBtn = document.getElementById('btnAccept');
            const completeBtn = document.getElementById('btnCompleteAndDelete');

            if (!acceptBtn || !completeBtn) return;

            // Override confirm popup
            const originalConfirm = window.confirm;
            window.confirm = function (message) {
                if (message.includes("mark the selected Message(s) as COMPLETED and DELETE")) {
                    return true;
                }
                return originalConfirm(message);
            };

            acceptBtn.click();

            // Wait for button to be enabled
            await new Promise(resolve => setTimeout(resolve, 1000));
            let attempts = 0;
            while (completeBtn.classList.contains('disabled') && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            if (!completeBtn.classList.contains('disabled')) {
                completeBtn.click();
            }

            // Restore original confirm after action
            window.confirm = originalConfirm;
        };
    }

    function insertDoneButton() {
        const closeContainer = document.getElementById('closeButtons');
        const closeBtn = document.getElementById('taskClose');

        if (!closeContainer || !closeBtn) return;
        if (document.getElementById('btnDoneTask')) return;

        const doneBtn = createDoneButton();
        attachDoneBehavior(doneBtn);
        closeBtn.insertAdjacentElement('afterend', doneBtn);
    }

    const observer = new MutationObserver(() => {
        insertDoneButton();
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
