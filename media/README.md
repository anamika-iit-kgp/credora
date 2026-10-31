# media

The demo video and the presentation for Credora's ExaThon India 2026 entry go here.

| File | Served at | Page |
|---|---|---|
| `demo.mp4` | `https://video.<domain>/demo.mp4` | [`sites/video/index.html`](../sites/video/index.html) plays it |
| `presentation.pdf` (or `presentation.pptx`) | `https://ppt.<domain>/presentation.pdf` | [`sites/ppt/index.html`](../sites/ppt/index.html) embeds the PDF and offers a download |

`<domain>` is the bank domain of the deployment (the one the app is served from). At deploy, the file is copied next to the page's `index.html`. Until a file is here, its page shows a "coming soon" placeholder.

Use H.264 video with AAC audio in an MP4 container so every browser can play it. The embedded viewer needs a PDF; a `.pptx` can only be offered as a download.
