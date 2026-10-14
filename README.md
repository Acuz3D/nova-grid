# Nova Grid

A Windows app that runs several Claude Code terminals side by side in one window, each in its own folder.

- Pick a model and effort level per terminal
- Usage bars for the session, weekly and Fable limits
- MCP servers shown per folder
- ChatGPT, Obsidian and Microsoft Edge (the desktop apps) pulled into panes alongside the terminals; ChatGPT and Obsidian can be faded so the background shows through
- Layouts: grid, side by side, stacked, or one big pane with the rest beside or below it; move panes around from the Layout menu
- Video backgrounds (import a file or paste a YouTube link), with looping, volume and auto-play of the next video
- A Commands sheet (F1) listing all of Claude's / commands; click one to type it into the selected terminal

## Download

Get **Nova-Grid-Setup-<version>.exe** from the [latest release](https://github.com/Acuz3D/nova-grid/releases/latest) and double-click it. Nova Grid installs and opens, with Start menu and desktop shortcuts. If Windows says "Windows protected your PC" (the app isn't signed), click **More info**, then **Run anyway**.

Needs [Claude Code](https://claude.com/claude-code). If it isn't installed, Nova Grid shows how to install it; the first terminal you open asks you to sign in. Node.js isn't needed.

From 1.1.0 on, Nova Grid updates itself: it checks GitHub when it opens, downloads a new version in the background, and installs it when you close it (or click **Restart to update**). Click the Nova Grid name in the top bar to see your version or check by hand. Version 1.0.0 has no updater, so download the latest version once by hand.

## Run it from the source

You need [Node.js](https://nodejs.org) installed. Download this repository (Code → Download ZIP, or `git clone`), open a terminal in its folder, then:

```
npm install
npm start
```

Needs [Claude Code](https://claude.com/claude-code) installed and signed in. Downloading backgrounds from links needs `yt-dlp`.

## Build the installer

```
npm run dist
```

This makes `dist/Nova-Grid-Setup-<version>.exe`. Double-click it and Nova Grid installs and opens, with no questions asked. It adds Start menu and desktop shortcuts, and can be removed from Windows' Installed apps list. The installed app keeps its background videos in `%APPDATA%\Nova Grid\backgrounds`.

## Publish a new version

1. Raise `version` in `package.json` (for example 1.2.0 → 1.3.0).
2. Run `npm run dist`.
3. Make a GitHub release with **all three** files from `dist`, so installed copies can update:

```
gh release create v1.3.0 dist/Nova-Grid-Setup-1.3.0.exe dist/Nova-Grid-Setup-1.3.0.exe.blockmap dist/latest.yml --title "Nova Grid 1.3.0" --notes "What changed"
```
