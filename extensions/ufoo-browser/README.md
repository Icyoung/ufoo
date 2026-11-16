# Ufoo Chrome Extension

Manifest V3 Chrome extension for connecting daily Chrome tabs to local `ufoo` and `ucode` agents via Native Messaging and the user-scoped `ufoo` browser broker.

## Differences From Upstream Playwright Extension

- **Brand & Identity**: Uses a standalone ufoo Manifest V3 identity (`DEV_EXTENSION_ID=hepkcmckfedpfpijhdpbfccnddjpdceh` in unpacked dev builds; separate Chrome Web Store ID for release). Does not reuse Playwright's extension ID or branding.
- **Auto-Discovery via Native Messaging**: Connects to `com.ufoo.browser` / `com.ufoo.browser.dev` on startup instead of requiring a manual pairing tab or copied token.
- **Per-Tab Ownership & Isolation**: Lists normal non-incognito tabs without attaching `chrome.debugger` globally; only attaches to tabs claimed by an agent session.
- **Extension Panel Controls**: A light, compact connection panel shows project/agent ownership, page titles, addresses and live counts. `暂停全部控制 / 恢复浏览器控制` and per-page `释放` actions remain available. Installation help and technical errors expand on demand; failed actions report an inline error and pending actions prevent duplicate clicks.
- **Icon Assets**: The panel and extension list use the dark tile from `icons/logo.png` (`icons/icon-*.png`). The Chrome toolbar independently uses an enlarged amber saucer on transparency from `icons/toolbar-logo.png`, exported as `toolbar-16.png` and `toolbar-32.png` via `action.default_icon`. The toolbar has no status badges. All assets are bundled locally, with no external fonts or icon requests.
- **Protocol Compatibility**: Control protocol `v1` (`protocolVersion: 1`), compatible with `ufoo` host `>= 4.0.6`.

## Developer Loading (Unpacked Mode)

1. Run:
   ```bash
   ufoo browser install --dev
   ```
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this directory (`extensions/ufoo-browser/`).
5. Verify extension ID matches `hepkcmckfedpfpijhdpbfccnddjpdceh` and verify connection with:
   ```bash
   ufoo browser status --json
   ```

After updating these files, use **Reload** for Ufoo in `chrome://extensions`,
then reopen its popup. Reloading releases existing browser-control connections;
do it between browser tasks. The extension key and protocol are unchanged.
