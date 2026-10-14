# Nova Grid

A Windows app that runs several Claude Code terminals side by side in one window, each in its own folder.

- Pick a model and effort level per terminal
- Usage bars for the session, weekly and Fable limits
- MCP servers shown per folder
- ChatGPT and Obsidian (the desktop apps) pulled into panes alongside the terminals
- Video backgrounds (import a file or paste a YouTube link), with looping, volume and auto-play of the next video
- A Keybinds sheet (F1) listing every Claude Code shortcut

## Run it

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

This makes `dist/Nova Grid Setup <version>.exe`. Running it installs Nova Grid with a Start menu and desktop shortcut, and it can be removed again from Windows' Installed apps list. The installed app keeps its background videos in `%APPDATA%\Nova Grid\backgrounds`.
