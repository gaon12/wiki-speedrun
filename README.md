# Wiki Speedrun

Wiki Speedrun is a Next.js app for finding and visualizing fast routes between wiki documents. Pick a start document and a target document, then search for a path that follows only internal wiki links.

## Features

- MediaWiki support through the official API.
- HTML-link adapters for the seed, openNAMU, DokuWiki, and MoniWiki sites.
- the seed searches public HTML without an API token, and uses the API when a
  token is supplied.
- Title and URL normalization before comparing documents.
- Redirect handling with two modes: automatic resolution or counting redirects as clicks.
- Link filtering for footnotes and non-article namespaces.
- Start/target validation with detailed error codes.
- Optional Nth-document constraint.
- Visual route view with iframe preview and URL-only mode.
- Responsive UI with light/dark mode and Korean, English, and Japanese labels.
- Browser-local settings persistence in `localStorage` under the `LocalSettings` key.

## Supported Engines

| Priority | Engine | Current adapter |
| --- | --- | --- |
| 1 | MediaWiki | API adapter |
| 2 | the seed | HTML adapter |
| 3 | openNAMU | HTML adapter |
| 4 | DokuWiki | HTML adapter |
| 5 | MoniWiki | HTML adapter |

HTML adapters are best-effort because each public wiki can customize routes, skins, backlink pages, and access rules.

## Error Codes

The route API returns structured failure codes, including:

- `START_NOT_FOUND`
- `TARGET_NOT_FOUND`
- `SAME_DOCUMENT`
- `START_HAS_NO_VALID_OUT_LINKS`
- `TARGET_HAS_NO_VALID_IN_LINKS`
- `LINK_EXTRACTION_FAILED`
- `BACKLINK_LOOKUP_UNSUPPORTED`
- `PATH_NOT_FOUND`
- `SEARCH_LIMIT_EXCEEDED`
- `SITE_RATE_LIMITED`
- `NETWORK_ERROR`

## Local Settings

User preferences are saved in the browser:

```text
localStorage["LocalSettings"]
```

Saved values include language, theme, selected wiki, custom wiki URLs, start/target documents, route options, namespace filters, required Nth-document settings, search limits, and view mode.

## Development

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Recommended workflow:

```bash
npm run format
npm run lint
npm run test
npm run build
```

## License

MIT. See [LICENSE](./LICENSE).
