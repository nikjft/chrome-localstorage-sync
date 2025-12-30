# LocalStorage Sync

**LocalStorage Sync** is a Chrome Extension that allows you to synchronize specific `localStorage` keys from any website to your personal Google Drive. This enables you to share local settings, game saves, or application states between different computers automatically.

## Features

* **Selective Sync:** Choose exactly which keys to sync for any given domain.
* **Instant Sync:** Detects changes in real-time and syncs them (with a short delay to prevent spamming).
* **Robust Conflict Resolution:** Uses a "Last Write Wins" timestamp-based architecture to handle syncing between multiple devices seamlessly.
* **Startup Restore:** Proactively restores cloud data before page scripts load, preventing websites from overwriting your data with default values.
* **Privacy First:** Data is stored directly in your own Google Drive (`appDataFolder`), not on any third-party server.

## Installation (Load Unpacked)

Since this is a developer/personal tool, you will load it as an "Unpacked Extension" in Chrome.

1. **Download/Clone** this repository to a folder on your computer.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button that appears in the top left.
5. Select the folder containing these files (the folder with `manifest.json`).
6. The extension should now appear in your browser toolbar.

## Usage

1. Navigate to a website you want to sync (e.g., a web game or tool).
2. Click the extension icon.
3. Click **"+ Add to Sync"**.
4. You will see a list of `localStorage` keys available on that page.
5. Check the box next to any key you want to sync.
   * If the key already exists in the cloud, you may be prompted to resolve a conflict (Local vs. Cloud).
6. Your data is now backed up to Google Drive and will sync to other computers running this extension.

## Disclaimer: "Vibe-Coded" Software

**PLEASE READ CAREFULLY:**

This software was "vibe-coded" (generated via AI assistance) and is provided strictly **"AS IS"**.

* **No Warranty:** There are no guarantees that this software works as intended. It may contain bugs, errors, or logic flaws that could result in data loss.
* **Use at Your Own Risk:** You are solely responsible for any data you entrust to this extension. Do not use it for mission-critical data without independent backups.
* **No Support:** Bug reports, feature requests, or issues submitted regarding this code **will not be responded to**. This is a provided as-is utility.

## License

This project is released under the **MIT License**.

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.