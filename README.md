# ClipForge

A free video editor for Windows with no subscriptions and no paywall. Built with Electron and FFmpeg.

## Features

- Multi-track timeline: main video, Video 2, overlays, audio and text
- Snapping, gaps, multi-select, drag to move, undo and redo
- Split, freeze frame, speed (0.05x to 100x), reverse, fades
- Keyframes for scale, rotation, position and opacity
- Drag the picture in the preview to move it
- 38 transitions, centered on the cut like CapCut
- Text with styles, fonts, outline, shadow and animations
- Auto-captions that run offline on your PC (Whisper tiny)
- Green screen (chroma key)
- Color adjustments and filters
- Audio waveforms
- Autosave and crash recovery
- Six themes and a home screen with recent projects
- Export to MP4 up to 4K

## Download

Go to the **Releases** page and download `ClipForge Setup`. Windows may show a "protected your PC" warning because the installer is not code-signed. Click **More info**, then **Run anyway**.

## Run from source

You need Node.js.

```
npm install
npm start
```

Auto-captions need the Whisper model files in `models/` and `vendor/`, which are not in this repository because of their size. The installer includes them.

## Build the installer

```
npm run dist
```

## License

GPL-3.0. ClipForge bundles a GPL build of FFmpeg.

Credits: [Electron](https://www.electronjs.org/), [FFmpeg](https://ffmpeg.org/), [Whisper](https://github.com/openai/whisper) via [transformers.js](https://github.com/huggingface/transformers.js) and [ONNX Runtime Web](https://onnxruntime.ai/).
