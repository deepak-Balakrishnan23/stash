# Stash

**Record. Screenshot. Stash.**  
A free, offline screen recorder that keeps everything on your device.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ehcljdhhbbchlcklpijonmkfpojdbmkh?label=Chrome%20Web%20Store&logo=google-chrome)](https://chromewebstore.google.com/detail/stash/ehcljdhhbbchlcklpijonmkfpojdbmkh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is Stash?

Stash is a Chrome extension for screen recording and screenshots — built privacy-first. Everything stays on your device. No accounts, no uploads, no telemetry.

## Features

- 🎥 **Screen recording** — capture your full screen, a specific tab, or your camera
- 📸 **Screenshots** — instant capture with a single click
- 🎙️ **Audio support** — record with microphone and/or system audio
- 💾 **Local-first** — all recordings saved directly to your device
- ☁️ **Optional Google Drive** — save to Drive if you want to, never required
- ⚙️ **Configurable output** — choose resolution (up to 1080p) and format (WebM)
- ⏸️ **Pause & resume** — full control over your recording session
- 🔒 **Offline** — works entirely without an internet connection

## Installation

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/stash/ehcljdhhbbchlcklpijonmkfpojdbmkh).

Or load unpacked for development:

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder

## Project Structure

```
stash/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — recording state & logic
├── popup.html / popup.js  # Extension popup UI
├── popup.css              # Popup styles
├── content.js / .css      # Content script injected into pages
├── offscreen/
│   ├── offscreen.html     # Offscreen document host
│   └── offscreen.js       # Media capture & processing
└── icons/                 # Extension icons (16, 32, 48, 128px)
```

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabCapture` | Capture the active tab's video/audio |
| `storage` | Save settings and recordings locally |
| `downloads` | Save files to your device |
| `scripting` | Inject the recording toolbar into pages |
| `offscreen` | Run media encoding in a background document |
| `identity` | Optional Google Drive authentication |

## Privacy

Stash is designed to keep your data on your device:

- No analytics or tracking
- No data sent to any server
- Google Drive integration is opt-in only, and uses OAuth — no credentials are stored by the extension

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
