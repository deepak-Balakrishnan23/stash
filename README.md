# Stash

**Record. Screenshot. Stash.**  
A free, offline screen recorder that keeps everything on your device.

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
├── manifest.json            # Extension manifest (MV3)
├── background.js            # Service worker — state machine, message router, Drive
├── db.js                    # Shared IndexedDB + codec layer (StashDB)
├── popup.html / .js / .css  # Extension popup UI
├── content.js / .css        # In-page recording toolbar (tab/screen)
├── camera.html / .js / .css # Dedicated camera-recording window
├── offscreen/
│   ├── offscreen.html       # Offscreen document host (loads db.js)
│   └── offscreen.js         # Tab/screen capture, encoding, screenshot stitching
└── icons/                   # Extension icons (16, 32, 48, 128px)
```

### How capture works

- **This Tab / Desktop** — recorded in the offscreen document (`tabCapture` /
  `getDisplayMedia`), streamed to IndexedDB, downloaded via an anchor click from
  the persistent offscreen context.
- **Camera** — opens a dedicated window (`camera.html`) with live preview and its
  own controls. Works everywhere, including restricted pages where in-page
  injection isn't allowed.
- **Format** — MP4 (H.264/AAC) is the default and is recorded natively on modern
  Chrome. Browsers without MP4 support fall back to WebM and show a notice.

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabCapture` | Capture the active tab's video/audio |
| `storage` | Save settings and recordings locally |
| `downloads` | Save screenshots to your device |
| `scripting` | In-page toolbar + screenshot selection overlays |
| `offscreen` | Run media encoding in a background document |
| `activeTab` | Capture the visible tab for screenshots |
| `alarms` | Daily cleanup of old recordings |
| `identity` *(optional)* | Requested only when you connect Google Drive |

## Privacy

Stash is designed to keep your data on your device:

- No analytics or tracking
- No data sent to any server
- Google Drive integration is opt-in only, and uses OAuth, no credentials are stored by the extension

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.
