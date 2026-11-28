# Third-Party Licenses and Asset Notices

Swamp's original source code is licensed under the MIT License (see `LICENSE`).
The third-party libraries, fonts, and data assets bundled or referenced in this repository remain governed by their respective licenses below.

## 1. Frontend Libraries (`src/third/`)

| Component | Path | License | Notes |
| :--- | :--- | :--- | :--- |
| **PDF.js** (`6.5.438`) | `src/third/pdfjs/` | Apache-2.0 | Mozilla PDF.js (including bundled Adobe CMap / standard font notices) |
| **DOMPurify** (`3.5.0`) | `src/third/markdown/purify.min.js` | Apache-2.0 / MPL-2.0 | Used under Apache-2.0 |
| **Bibi** (`1.2.0`) | `src/third/bibi/` | MIT | EPUB Reader by Satoru Matsushima |
| **marked** (`4.3.0`) | `src/third/markdown/marked.min.js` | MIT | Markdown parser |
| **highlight.js** | `src/third/markdown/highlight.min.js` | BSD-3-Clause | Syntax highlighting |
| **CodeMirror 5** | `src/third/markdown/codemirror/` | MIT | Local Markdown editor |
| **Photo Sphere Viewer** (`2.9`) | `src/third/photo-sphere-viewer/` | MIT | 360° panorama viewer |
| **three.js** | `src/third/photo-sphere-viewer/three.min.js` | MIT | 3D rendering backend |
| **Prism** | `src/third/prism/` | MIT | Code block highlighting |
| **encoding.js** | `src/third/other/encoding.min.js` | MIT | Legacy text encoding fallback |
| **canvas-confetti** | `src/third/other/confetti.browser.min.js` | ISC | Visual celebration effect |

## 2. Fonts (`src/css/font/`)

- **Noto Serif SC**: Licensed under the **SIL Open Font License 1.1 (OFL-1.1)**. May be freely bundled and redistributed with software provided the font files themselves are not sold standalone and the OFL license notice is preserved.

## 3. Rust Dependencies (`_build/swamp-server/Cargo.toml`)

All direct Rust crate dependencies (`axum`, `tokio`, `tokio-util`, `serde`, `serde_json`, `toml`, `regex`, `similar`, `wasm-bindgen`, `serde-wasm-bindgen`, `js-sys`, `lazy_static`, `getrandom`, `subtle`, `percent-encoding`, `chrono`, `aho-corasick`, `crc32fast`, `sha2`, `globset`, `ignore`, `walkdir`, `rayon`, `image`, `webp`, `zip`, `arboard`, `reqwest`, `notify`, `windows-sys`) are distributed under permissive open-source licenses (MIT, Apache-2.0, BSD, or ISC).

## 4. Linguistic Data & Static Assets (Independent Terms)

- **HIT IR-Lab Tongyici Cilin Extended (`_build/swamp-server/assets/cilin.txt`)**:
  - **Not covered by Swamp's MIT License.** Distributed by Harbin Institute of Technology Research Center for Social Computing and Information Retrieval (HIT-SCIR) for **academic and non-commercial research use**.
  - For commercial redistribution or strict OSI-only compliance, you may delete `_build/swamp-server/assets/cilin.txt` — Swamp detects its absence and automatically falls back to user-defined custom synonyms in `_build/swamp.toml`.
- **Single-Character Pinyin Dictionary (`src/js/pinyinData.js`)** & **Go Stone Sound (`src/css/sound/stone2.wav`)**:
  - Optional static assets for character pinyin tooltips and the standalone Go board tool; may be replaced with your own assets at any time without affecting core functionality.
