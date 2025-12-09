// FC Labor Tracking Assistant - Popup Script

const KIOSK_URL_PATTERN = /fcmenu-iad-regionalized\.corp\.amazon\.com/;
const FCLM_URL_PATTERN = /fclm-portal\.amazon\.com/;

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.querySelector('.status-text');
const workCodeSection = document.getElementById('work-code-section');
const badgeSection = document.getElementById('badge-section');
const workCodeInput = document.getElementById('work-code');
const badgeIdInput = document.getElementById('badge-id');
const submitWorkCodeBtn = document.getElementById('submit-work-code');
const submitBadgeBtn = document.getElementById('submit-badge');
const backBtn = document.getElementById('back-to-workcode');
const messageDiv = document.getElementById('message');
const activityList = document.getElementById('activity-list');

let kioskTabId = null;
let fclmTabId = null;
let currentState = 'work-code'; // 'work-code' or 'badge'

// Initialize popup
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await checkConnectedTabs();
  loadRecentActivity();
  setupEventListeners();

  // Focus the appropriate input
  if (currentState === 'work-code') {
    workCodeInput.focus();
  } else {
    badgeIdInput.focus();
  }
}

async function checkConnectedTabs() {
  try {
    const tabs = await browser.tabs.query({});

    kioskTabId = null;
    fclmTabId = null;

    for (const tab of tabs) {
      if (tab.url && KIOSK_URL_PATTERN.test(tab.url)) {
        kioskTabId = tab.id;
      }
      if (tab.url && FCLM_URL_PATTERN.test(tab.url)) {
        fclmTabId = tab.id;
      }
    }

    updateConnectionStatus();
  } catch (error) {
    console.error('Error checking tabs:', error);
    showMessage('Error checking connected tabs', 'error');
  }
}

function updateConnectionStatus() {
  if (kioskTabId) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = 'Connected to kiosk';
    submitWorkCodeBtn.disabled = false;
    submitBadgeBtn.disabled = false;
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = 'Not connected to kiosk';
    submitWorkCodeBtn.disabled = true;
    submitBadgeBtn.disabled = true;
  }
}

function setupEventListeners() {
  // Work code submission
  submitWorkCodeBtn.addEventListener('click', submitWorkCode);
  workCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      submitWorkCode();
    }
  });

  // Badge submission
  submitBadgeBtn.addEventListener('click', submitBadge);
  badgeIdInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      submitBadge();
    }
  });

  // Back button
  backBtn.addEventListener('click', () => {
    switchToWorkCodeMode();
  });
}

async function submitWorkCode() {
  const workCode = workCodeInput.value.trim().toUpperCase();

  if (!workCode) {
    showMessage('Please enter a work code', 'error');
    workCodeInput.focus();
    return;
  }

  if (!kioskTabId) {
    showMessage('Kiosk tab not found. Please open the labor tracking kiosk.', 'error');
    return;
  }

  try {
    showMessage('Submitting work code...', 'info');

    // Send message to content script to input the work code
    const response = await browser.tabs.sendMessage(kioskTabId, {
      action: 'inputWorkCode',
      workCode: workCode
    });

    if (response && response.success) {
      addActivity(`Work code "${workCode}" submitted`);
      showMessage('Work code submitted! Enter badge ID.', 'success');
      switchToBadgeMode();

      // Store the work code for reference
      await browser.storage.local.set({ lastWorkCode: workCode });
    } else {
      showMessage(response?.error || 'Failed to submit work code', 'error');
    }
  } catch (error) {
    console.error('Error submitting work code:', error);
    showMessage('Error: Could not communicate with kiosk page', 'error');
  }
}

async function submitBadge() {
  const badgeId = badgeIdInput.value.trim();

  if (!badgeId) {
    showMessage('Please enter a badge ID', 'error');
    badgeIdInput.focus();
    return;
  }

  if (!kioskTabId) {
    showMessage('Kiosk tab not found. Please open the labor tracking kiosk.', 'error');
    return;
  }

  try {
    showMessage('Submitting badge ID...', 'info');

    // Send message to content script to input the badge ID
    const response = await browser.tabs.sendMessage(kioskTabId, {
      action: 'inputBadgeId',
      badgeId: badgeId
    });

    if (response && response.success) {
      addActivity(`Badge "${badgeId}" submitted`);
      showMessage('Badge ID submitted successfully!', 'success');
      badgeIdInput.value = '';

      // Clear after a delay and ready for next badge
      setTimeout(() => {
        showMessage('Ready for next badge ID', 'info');
        badgeIdInput.focus();
      }, 1500);
    } else {
      showMessage(response?.error || 'Failed to submit badge ID', 'error');
    }
  } catch (error) {
    console.error('Error submitting badge ID:', error);
    showMessage('Error: Could not communicate with kiosk page', 'error');
  }
}

function switchToBadgeMode() {
  currentState = 'badge';
  workCodeSection.classList.add('hidden');
  badgeSection.classList.remove('hidden');
  badgeIdInput.value = '';
  badgeIdInput.focus();
}

function switchToWorkCodeMode() {
  currentState = 'work-code';
  badgeSection.classList.add('hidden');
  workCodeSection.classList.remove('hidden');
  workCodeInput.focus();
}

function showMessage(text, type) {
  messageDiv.textContent = text;
  messageDiv.className = `message ${type}`;
}

function addActivity(action) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });

  const li = document.createElement('li');
  li.innerHTML = `<span class="time">${timeStr}</span><span class="action">${action}</span>`;

  // Add to beginning of list
  if (activityList.firstChild) {
    activityList.insertBefore(li, activityList.firstChild);
  } else {
    activityList.appendChild(li);
  }

  // Keep only last 10 activities
  while (activityList.children.length > 10) {
    activityList.removeChild(activityList.lastChild);
  }

  // Save to storage
  saveRecentActivity();
}

async function saveRecentActivity() {
  const activities = [];
  for (const li of activityList.children) {
    activities.push(li.innerHTML);
  }
  await browser.storage.local.set({ recentActivity: activities });
}

async function loadRecentActivity() {
  try {
    const data = await browser.storage.local.get('recentActivity');
    if (data.recentActivity) {
      for (const html of data.recentActivity) {
        const li = document.createElement('li');
        li.innerHTML = html;
        activityList.appendChild(li);
      }
    }
  } catch (error) {
    console.error('Error loading recent activity:', error);
  }
}
