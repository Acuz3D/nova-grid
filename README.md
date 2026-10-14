# Nova Grid

A Windows app that runs several Claude Code terminals side by side in one window, each in its own folder.

- Pick a model and effort level per terminal
- Usage bars for the session, weekly and Fable limits
- MCP servers shown per folder
- ChatGPT and Obsidian (the desktop apps) pulled into panes alongside the terminals
- Video backgrounds (import a file or paste a YouTube link), with looping, volume and auto-play of the next video
- A Commands sheet (F1) listing all of Claude's / commands; click one to type it into the selected terminal

## Download

Get **Nova-Grid-Setup-1.0.0.exe** from the [latest release](https://github.com/Acuz3D/nova-grid/releases/latest) and double-click it. Nova Grid installs and opens, with Start menu and desktop shortcuts. If Windows says "Windows protected your PC" (the app isn't signed), click **More info**, then **Run anyway**.

Needs [Claude Code](https://claude.com/claude-code) installed and signed in.

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

This makes `dist/Nova Grid Setup <version>.exe`. Double-click it and Nova Grid installs and opens, with no questions asked. It adds Start menu and desktop shortcuts, and can be removed from Windows' Installed apps list. The installed app keeps its background videos in `%APPDATA%\Nova Grid\backgrounds`.
