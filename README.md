# FC Labor Tracking Assistant

A Firefox browser extension to assist with work code and badge ID entry on Amazon FC labor tracking kiosk pages.

## Features

- Non-blocking popup interface for entering work codes and badge IDs
- Works with FC labor tracking kiosk pages
- Tracks recent activity for reference
- Connection status indicator showing when kiosk page is detected

## Installation (Firefox)

### Temporary Installation (Development)

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on"
4. Navigate to the `extension` folder and select `manifest.json`
5. The extension will be loaded and active

### Permanent Installation

1. Package the extension:
   - Zip all contents of the `extension` folder
   - Rename the `.zip` file to `.xpi`
2. In Firefox, go to `about:addons`
3. Click the gear icon and select "Install Add-on From File"
4. Select the `.xpi` file

## Usage

1. Open the FC labor tracking kiosk page: `https://fcmenu-iad-regionalized.corp.amazon.com/IND8/laborTrackingKiosk`
2. Optionally, also have the FCLM portal open: `https://fclm-portal.amazon.com/?warehouseId=IND8`
3. Click the extension icon in your browser toolbar
4. Enter the work code (e.g., `CREOL`) and press Enter or click "Submit Work Code"
5. The extension will input the work code into the kiosk page
6. After the page transitions, enter the badge ID and press Enter or click "Submit Badge"

## File Structure

```
extension/
├── manifest.json          # Extension manifest
├── background.js          # Background script for message passing
├── icons/                 # Extension icons
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── content/
│   ├── kiosk.js          # Content script for kiosk pages
│   ├── kiosk.css         # Styles for kiosk page
│   └── fclm.js           # Content script for FCLM portal
└── popup/
    ├── popup.html        # Popup UI
    ├── popup.css         # Popup styles
    └── popup.js          # Popup logic
```

## Target Pages

- **Labor Tracking Kiosk (Work Code)**: `https://fcmenu-iad-regionalized.corp.amazon.com/*/laborTrackingKiosk`
- **Labor Tracking Kiosk (Badge)**: `https://fcmenu-iad-regionalized.corp.amazon.com/do/laborTrackingKiosk`
- **FCLM Portal**: `https://fclm-portal.amazon.com/*`

## Future Enhancements

- FCLM integration for associate lookup before badge submission
- Batch badge processing
- Keyboard shortcuts for faster operation
- History and reporting features

## Troubleshooting

### Extension shows "Not connected to kiosk"
- Make sure you have the labor tracking kiosk page open in a tab
- Refresh the kiosk page to reinitialize the content script
- Try reloading the extension from `about:debugging`

### Work code/badge not being entered
- The page DOM structure may have changed; the input selectors may need updating
- Check the browser console for error messages from the extension
