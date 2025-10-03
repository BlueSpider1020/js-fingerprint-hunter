# Headless FP Detector

Detect JavaScript fingerprinting behavior (canvas, fonts, audio, WebGL, etc.) by visiting pages with a Puppeteer headless browser and logging suspicious fingerprinting activity.

> A Node.js server + Puppeteer-based tool to automatically visit web pages and detect common client-side fingerprinting techniques. Useful for research, testing, and automated audits.

## Features
- Launches Puppeteer (optionally headful) and navigates to target URLs
- Detects and logs common fingerprinting techniques:
  - Canvas fingerprinting (toDataURL / getImageData)
  - WebGL parameter readouts
  - AudioContext fingerprinting calls
  - Font probing (measuring invisible text widths)
  - Navigator / plugin fingerprinting (enumeration attempts)
  - Screen/timezone/language probing reads
  - WebRTC local IP leaks / `RTCPeerConnection` usage
  - High-resolution timers and performance API abuse
  - `toString` / function source inspection attempts
- Structured JSON output per visit for easy processing
- Extensible detection rule engine — add detectors with small scripts
- Simple REST API to trigger scans and retrieve results

## Quick start

### Requirements
- Node.js 18+ (or latest LTS)
- npm or yarn
- ~2GB free disk for Chromium (if using default Puppeteer)

### Install
```bash
git clone https://github.com/<your-org>/headless-fp-detector.git
cd headless-fp-detector
npm install
