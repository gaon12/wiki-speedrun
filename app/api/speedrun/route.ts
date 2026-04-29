type WikiEngine =
  | "mediawiki"
  | "the-seed"
  | "opennamu"
  | "dokuwiki"
  | "moniwiki";

type ErrorCode =
  | "INVALID_REQUEST"
  | "START_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "SAME_DOCUMENT"
  | "START_HAS_NO_VALID_OUT_LINKS"
  | "TARGET_HAS_NO_VALID_IN_LINKS"
  | "LINK_EXTRACTION_FAILED"
  | "BACKLINK_LOOKUP_UNSUPPORTED"
  | "PATH_NOT_FOUND"
  | "SEARCH_LIMIT_EXCEEDED"
  | "SITE_RATE_LIMITED"
  | "NETWORK_ERROR"
  | "INVALID_WIKI_SITE"
  | "REQUIRED_STEP_NOT_FOUND"
  | "REQUIRED_STEP_UNREACHABLE";

type NamespacePolicy = {
  file: boolean;
  category: boolean;
  template: boolean;
  user: boolean;
  talk: boolean;
  special: boolean;
};

type SpeedrunRequest = {
  engine: WikiEngine;
  baseUrl: string;
  apiEndpoint?: string;
  apiToken?: string;
  startTitle: string;
  targetTitle: string;
  includeFootnotes: boolean;
  redirectMode: "auto" | "count";
  namespacePolicy: NamespacePolicy;
  requiredStep?: {
    enabled: boolean;
    position: number;
    title: string;
  };
  search: {
    maxDepth: number;
    maxNodes: number;
  };
};

type ResolvedPage = {
  pageId: string;
  title: string;
  url: string;
  ns: number;
  inputTitle: string;
  redirectedFrom?: string;
};

type Candidate = {
  page: ResolvedPage;
  linkTitle: string;
  redirected: boolean;
};

type PathNode = {
  id: string;
  pageId: string | null;
  title: string;
  url: string;
  kind: "page" | "redirect";
  redirectedFrom?: string;
};

type WikiAdapter = {
  endpoint: string;
  backlinkMode: "api" | "html" | "best_effort";
  resolvePage: (rawInput: string) => Promise<ResolvedPage | null>;
  getOutgoingLinks: (page: ResolvedPage) => Promise<Candidate[]>;
  getBacklinkCount: (target: ResolvedPage) => Promise<number | null>;
};

type MwPage = {
  pageid?: number;
  ns?: number;
  title?: string;
  fullurl?: string;
  missing?: boolean;
  invalid?: boolean;
  links?: Array<{ ns: number; title: string }>;
  linkshere?: Array<{ ns: number; pageid?: number; title: string }>;
};

type HtmlFetchResult = {
  finalUrl: string;
  html: string;
  status: number;
};

type RawFetchResult = {
  text: string;
  exists: boolean;
};

type ProgressUpdate = {
  stage: string;
  message: string;
  percent: number;
  expanded?: number;
  queued?: number;
  depth?: number;
  title?: string;
};

type ProgressReporter = (update: ProgressUpdate) => void;

const namespaceGroups = {
  file: new Set([6, 7]),
  category: new Set([14, 15]),
  template: new Set([10, 11]),
  user: new Set([2, 3]),
  talk: new Set([1, 3, 5, 7, 9, 11, 13, 15]),
  special: new Set([-1]),
};

const functionalPathParts = [
  "/api/",
  "/edit/",
  "/history/",
  "/recentchanges",
  "/random",
  "/settings",
  "/upload",
  "/user/",
  "/discuss/",
  "/thread/",
  "/acl/",
  "/raw/",
  "/revert/",
  "/delete/",
  "/move/",
  "/diff/",
  "/blame/",
  "/admin/",
];

const htmlCache = new Map<
  string,
  { expires: number; value: HtmlFetchResult }
>();
const jsonCache = new Map<string, { expires: number; value: unknown }>();
const hostNextRequestAt = new Map<string, number>();
const userAgent =
  "wiki-speedrun/0.2 (route search; local app; contact: local-development)";
const maxTitleLength = 240;
const maxUrlLength = 2048;
const maxTokenLength = 4096;
const maxRedirects = 5;

export async function POST(request: Request) {
  try {
    const body = normalizeRequest(await request.json());
    if (new URL(request.url).searchParams.get("stream") === "1") {
      return streamSpeedrun(body);
    }

    const payload = await runSpeedrun(body);
    return Response.json(payload);
  } catch (error) {
    if (error instanceof SpeedrunError) {
      return fail(error.code, error.message);
    }
    return fail(
      "NETWORK_ERROR",
      error instanceof Error
        ? error.message
        : "Unexpected network or parsing failure.",
    );
  }
}

function streamSpeedrun(body: SpeedrunRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const payload = await runSpeedrun(body, (update) =>
          send({ type: "progress", ...update }),
        );
        send({ type: "result", data: payload });
      } catch (error) {
        if (error instanceof SpeedrunError) {
          send({
            type: "result",
            data: failurePayload(error.code, error.message),
          });
        } else {
          send({
            type: "result",
            data: failurePayload(
              "NETWORK_ERROR",
              error instanceof Error
                ? error.message
                : "Unexpected network or parsing failure.",
            ),
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function runSpeedrun(body: SpeedrunRequest, report?: ProgressReporter) {
  report?.({
    stage: "prepare",
    message: "Preparing wiki adapter.",
    percent: 4,
  });

  const adapter = await createWikiAdapter(body);

  report?.({
    stage: "resolve_start",
    message: "Resolving start document.",
    percent: 9,
    title: body.startTitle,
  });
  const start = await adapter.resolvePage(body.startTitle);
  if (!start) {
    return failurePayload(
      "START_NOT_FOUND",
      "The start document could not be resolved to an existing page.",
    );
  }

  report?.({
    stage: "resolve_target",
    message: "Resolving target document.",
    percent: 15,
    title: body.targetTitle,
  });
  const target = await adapter.resolvePage(body.targetTitle);
  if (!target) {
    return failurePayload(
      "TARGET_NOT_FOUND",
      "The target document could not be resolved to an existing page.",
    );
  }

  report?.({
    stage: "resolve_required",
    message: "Checking required Nth document option.",
    percent: 20,
  });
  const required = body.requiredStep?.enabled
    ? await adapter.resolvePage(body.requiredStep.title)
    : null;
  if (body.requiredStep?.enabled && !required) {
    return failurePayload(
      "REQUIRED_STEP_NOT_FOUND",
      "The required Nth document could not be resolved.",
    );
  }

  if (start.pageId === target.pageId) {
    return failurePayload(
      "SAME_DOCUMENT",
      "Start and target resolve to the same canonical page.",
    );
  }

  report?.({
    stage: "start_links",
    message: "Collecting valid outgoing links from the start document.",
    percent: 28,
    title: start.title,
  });
  const startLinks = await adapter.getOutgoingLinks(start);
  if (startLinks.length === 0) {
    return failurePayload(
      "START_HAS_NO_VALID_OUT_LINKS",
      "The start document exists, but it has no valid outgoing links under the current options.",
    );
  }

  report?.({
    stage: "target_backlinks",
    message: "Checking target backlinks.",
    percent: 36,
    title: target.title,
  });
  const targetBacklinks = await adapter.getBacklinkCount(target);
  if (targetBacklinks === 0) {
    return failurePayload(
      "TARGET_HAS_NO_VALID_IN_LINKS",
      "The target document exists, but no valid backlinks were found under the current options.",
    );
  }

  report?.({
    stage: "search",
    message: "Searching reachable wiki graph.",
    percent: 42,
    expanded: 0,
    queued: 1,
  });
  const result = await findPath(
    adapter,
    start,
    target,
    required,
    body,
    {
      [start.pageId]: startLinks,
    },
    report,
  );

  report?.({
    stage: "complete",
    message: "Route search completed.",
    percent: 100,
    expanded: result.expanded,
  });

  return {
    ok: true,
    endpoint: adapter.endpoint,
    backlinkMode: adapter.backlinkMode,
    start,
    target,
    required,
    ...result,
    checks: {
      startOutLinks: startLinks.length,
      targetBacklinks,
    },
  };
}

async function findPath(
  adapter: WikiAdapter,
  start: ResolvedPage,
  target: ResolvedPage,
  required: ResolvedPage | null,
  request: SpeedrunRequest,
  seededLinks: Record<string, Candidate[]>,
  report?: ProgressReporter,
) {
  type QueueEntry = {
    current: ResolvedPage;
    hops: Candidate[];
  };

  const queue: QueueEntry[] = [{ current: start, hops: [] }];
  const visited = new Set<string>([start.pageId]);
  const linkCache = new Map<string, Candidate[]>(Object.entries(seededLinks));
  let expanded = 0;

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }

    if (entry.hops.length >= request.search.maxDepth) {
      continue;
    }

    expanded += 1;
    report?.({
      stage: "search",
      message: `Expanding "${entry.current.title}".`,
      percent: Math.min(
        96,
        42 + Math.round((expanded / request.search.maxNodes) * 54),
      ),
      expanded,
      queued: queue.length,
      depth: entry.hops.length,
      title: entry.current.title,
    });
    if (expanded > request.search.maxNodes) {
      throw new SpeedrunError(
        "SEARCH_LIMIT_EXCEEDED",
        "The search visited too many pages.",
      );
    }

    let links: Candidate[];
    try {
      links =
        linkCache.get(entry.current.pageId) ??
        (await adapter.getOutgoingLinks(entry.current));
    } catch (error) {
      if (
        error instanceof SpeedrunError &&
        error.code === "LINK_EXTRACTION_FAILED" &&
        entry.current.pageId !== start.pageId
      ) {
        continue;
      }
      throw error;
    }
    linkCache.set(entry.current.pageId, links);

    for (const candidate of links) {
      if (candidate.page.pageId === entry.current.pageId) {
        continue;
      }

      const nextHops = [...entry.hops, candidate];
      if (!passesRequiredStep(start, required, nextHops, request)) {
        continue;
      }

      const reachedTarget =
        candidate.page.pageId === target.pageId ||
        titlesEqual(candidate.page.title, target.title) ||
        titlesEqual(candidate.page.title, target.inputTitle);
      if (reachedTarget) {
        const targetHops =
          candidate.page.pageId === target.pageId
            ? nextHops
            : [
                ...entry.hops,
                {
                  ...candidate,
                  page: target,
                  redirected: true,
                },
              ];
        const nodes = buildPathNodes(start, targetHops, request.redirectMode);
        if (!hasRequiredNode(nodes, required, request)) {
          throw new SpeedrunError(
            "REQUIRED_STEP_UNREACHABLE",
            "A route exists, but it does not satisfy the required Nth document.",
          );
        }
        return {
          path: nodes,
          edges: buildEdges(nodes),
          clicks: Math.max(nodes.length - 1, 0),
          expanded,
          exhausted: false,
        };
      }

      if (!visited.has(candidate.page.pageId)) {
        visited.add(candidate.page.pageId);
        queue.push({ current: candidate.page, hops: nextHops });
      }
    }
  }

  throw new SpeedrunError(
    "PATH_NOT_FOUND",
    "Every reachable candidate within the configured limits was exhausted.",
  );
}

async function createMediaWikiAdapter(
  request: SpeedrunRequest,
): Promise<WikiAdapter> {
  const endpoint = await discoverMediaWikiEndpoint(
    request.baseUrl,
    request.apiEndpoint,
  );

  return {
    endpoint,
    backlinkMode: "api",
    resolvePage: (rawInput) =>
      resolveMediaWikiPage(endpoint, rawInput, request),
    getOutgoingLinks: (page) =>
      getMediaWikiOutgoingLinks(endpoint, page, request),
    getBacklinkCount: (target) =>
      getMediaWikiBacklinkCount(endpoint, target, request.namespacePolicy),
  };
}

async function createWikiAdapter(request: SpeedrunRequest) {
  if (request.engine === "mediawiki") {
    return createMediaWikiAdapter(request);
  }

  if (request.engine === "dokuwiki") {
    const apiAdapter = await createDokuWikiApiAdapter(request);
    return apiAdapter ?? createHtmlWikiAdapter(request);
  }

  if (request.engine === "the-seed" && request.apiToken) {
    return createTheSeedApiAdapter(request);
  }

  if (request.engine === "the-seed") {
    return createTheSeedPublicAdapter(request);
  }

  if (request.engine === "opennamu") {
    const apiAdapter = await createOpenNamuApiAdapter(request);
    return apiAdapter ?? createHtmlWikiAdapter(request);
  }

  if (request.engine === "moniwiki") {
    return createRawMarkupWikiAdapter(request, {
      endpoint: `${request.engine}:raw:${safeUrl(request.baseUrl)?.origin ?? ""}`,
      rawUrl: (base, title) => {
        const url = new URL(buildHtmlPageUrl(base, title, request.engine));
        url.searchParams.set("action", "raw");
        return url.toString();
      },
      parseLinks: (text) => extractWikiMarkupLinks(text, request.engine),
    });
  }

  return createHtmlWikiAdapter(request);
}

function createTheSeedPublicAdapter(request: SpeedrunRequest): WikiAdapter {
  const adapter = createHtmlWikiAdapter(request);
  return {
    ...adapter,
    endpoint: `${request.engine}:public-html:${
      safeUrl(request.baseUrl)?.origin ?? ""
    }`,
  };
}

function createHtmlWikiAdapter(request: SpeedrunRequest): WikiAdapter {
  const base = safeUrl(request.baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }
  const htmlBase = base;

  const pageCache = new Map<string, ResolvedPage | null>();

  async function resolvePage(rawInput: string) {
    const normalized = normalizeTitleInput(rawInput, request.baseUrl);
    if (!normalized) {
      return null;
    }

    const cacheKey = canonicalTextKey(normalized);
    if (pageCache.has(cacheKey)) {
      return pageCache.get(cacheKey) ?? null;
    }

    const pageUrl = buildHtmlPageUrl(htmlBase, normalized, request.engine);
    const fetched = await fetchHtml(pageUrl);
    if (!isExistingHtmlPage(fetched)) {
      pageCache.set(cacheKey, null);
      return null;
    }

    const finalTitle =
      titleFromHtml(fetched.html) ??
      titleFromEngineUrl(fetched.finalUrl, htmlBase, request.engine) ??
      normalized;

    const page: ResolvedPage = {
      pageId: canonicalPageId(fetched.finalUrl, finalTitle),
      title: normalizeLooseTitle(finalTitle),
      url: fetched.finalUrl,
      ns: namespaceGuess(finalTitle),
      inputTitle: rawInput,
      redirectedFrom: titlesEqual(finalTitle, normalized)
        ? undefined
        : normalized,
    };
    pageCache.set(cacheKey, page);
    pageCache.set(canonicalTextKey(page.title), page);
    return page;
  }

  async function getOutgoingLinks(page: ResolvedPage) {
    const fetched = await fetchHtml(page.url);
    if (!isExistingHtmlPage(fetched)) {
      throw new SpeedrunError(
        "LINK_EXTRACTION_FAILED",
        "Could not extract valid page links.",
      );
    }

    const html = request.includeFootnotes
      ? fetched.html
      : stripReferenceHtml(fetched.html);
    const titles = extractHtmlEngineLinks(
      html,
      fetched.finalUrl,
      htmlBase,
      request,
    );
    const resolved: Candidate[] = [];
    const seen = new Set<string>();

    for (const title of titles.slice(0, 180)) {
      if (!namespaceAllowed(namespaceGuess(title), request.namespacePolicy)) {
        continue;
      }
      if (titlesEqual(title, page.title)) {
        continue;
      }

      const candidateUrl = buildHtmlPageUrl(htmlBase, title, request.engine);
      const candidateId = canonicalPageId(candidateUrl, title);
      if (candidateId === page.pageId || seen.has(candidateId)) {
        continue;
      }

      resolved.push({
        page: {
          pageId: candidateId,
          title: normalizeLooseTitle(title),
          url: candidateUrl,
          ns: namespaceGuess(title),
          inputTitle: title,
        },
        linkTitle: title,
        redirected: false,
      });
      seen.add(candidateId);
    }

    return resolved;
  }

  async function getBacklinkCount(target: ResolvedPage) {
    const urls = backlinkUrls(htmlBase, target.title, request.engine);
    for (const url of urls) {
      try {
        const fetched = await fetchHtml(url);
        if (!isExistingHtmlPage(fetched)) {
          continue;
        }
        const links = extractHtmlEngineLinks(
          fetched.html,
          fetched.finalUrl,
          htmlBase,
          request,
        ).filter((title) => !titlesEqual(title, target.title));
        if (links.length > 0) {
          return links.length;
        }
      } catch {
        // Try the next backlink URL shape for the same engine.
      }
    }

    return null;
  }

  return {
    endpoint: `${request.engine}:html:${htmlBase.origin}`,
    backlinkMode: "best_effort",
    resolvePage,
    getOutgoingLinks,
    getBacklinkCount,
  };
}

async function createDokuWikiApiAdapter(
  request: SpeedrunRequest,
): Promise<WikiAdapter | null> {
  const base = safeUrl(request.baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }
  const wikiBase = base;

  const endpoint = discoverDokuWikiJsonRpcEndpoint(
    wikiBase,
    request.apiEndpoint,
  );
  try {
    await dokuJsonRpc(endpoint, "dokuwiki.getVersion", []);
  } catch {
    return null;
  }

  const pageCache = new Map<string, ResolvedPage | null>();

  async function resolvePage(rawInput: string) {
    const normalized = normalizeTitleInput(rawInput, request.baseUrl);
    if (!normalized) {
      return null;
    }

    const id = dokuWikiId(normalized);
    const cacheKey = canonicalTextKey(id);
    if (pageCache.has(cacheKey)) {
      return pageCache.get(cacheKey) ?? null;
    }

    try {
      await dokuJsonRpc(endpoint, "wiki.getPageInfo", [id]);
      const page: ResolvedPage = {
        pageId: `dokuwiki:${canonicalTextKey(id)}`,
        title: normalizeLooseTitle(id),
        url: buildHtmlPageUrl(wikiBase, id, request.engine),
        ns: namespaceGuess(id.replace(/:/g, " ")),
        inputTitle: rawInput,
      };
      pageCache.set(cacheKey, page);
      return page;
    } catch {
      pageCache.set(cacheKey, null);
      return null;
    }
  }

  async function getOutgoingLinks(page: ResolvedPage) {
    const links = await dokuJsonRpc(endpoint, "wiki.listLinks", [
      dokuWikiId(page.title),
    ]);
    const titles = (Array.isArray(links) ? links : [])
      .map((link) =>
        typeof link === "string"
          ? link
          : typeof link?.page === "string"
            ? link.page
            : typeof link?.id === "string"
              ? link.id
              : "",
      )
      .filter(Boolean);

    return resolveRawLinksToCandidates(titles, page, request, resolvePage);
  }

  async function getBacklinkCount(target: ResolvedPage) {
    try {
      const backlinks = await dokuJsonRpc(endpoint, "wiki.getBackLinks", [
        dokuWikiId(target.title),
      ]);
      return Array.isArray(backlinks)
        ? backlinks.filter((title) =>
            namespaceAllowed(
              namespaceGuess(String(title)),
              request.namespacePolicy,
            ),
          ).length
        : null;
    } catch {
      return null;
    }
  }

  return {
    endpoint,
    backlinkMode: "api",
    resolvePage,
    getOutgoingLinks,
    getBacklinkCount,
  };
}

function createTheSeedApiAdapter(request: SpeedrunRequest): WikiAdapter {
  const base = safeUrl(request.baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }
  const endpoint =
    request.apiEndpoint?.trim() ||
    (base.hostname === "namu.wiki"
      ? "https://wiki-api.namu.la/api"
      : new URL("/api", base.origin).toString());

  return createRawMarkupWikiAdapter(request, {
    endpoint,
    backlinkMode: "api",
    rawUrl: (_base, title) =>
      `${endpoint.replace(/\/+$/g, "")}/edit/${encodeTitlePath(title)}`,
    rawFetcher: async (url) => {
      const data = (await cachedJsonWithHeaders(url, {
        authorization: `Bearer ${request.apiToken}`,
      })) as { text?: string; exists?: boolean };
      return {
        text: data.text ?? "",
        exists: data.exists === true,
      };
    },
    backlinkCount: async (target) => {
      const url = `${endpoint.replace(/\/+$/g, "")}/backlink/${encodeTitlePath(
        target.title,
      )}`;
      const data = (await cachedJsonWithHeaders(url, {
        authorization: `Bearer ${request.apiToken}`,
      })) as {
        backlinks?: Array<{ document?: string; flags?: string }>;
      };
      return (data.backlinks ?? []).filter((item) =>
        namespaceAllowed(
          namespaceGuess(item.document ?? ""),
          request.namespacePolicy,
        ),
      ).length;
    },
    parseLinks: (text) => extractWikiMarkupLinks(text, request.engine),
  });
}

async function createOpenNamuApiAdapter(
  request: SpeedrunRequest,
): Promise<WikiAdapter | null> {
  const base = safeUrl(request.baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }

  const endpoint =
    request.apiEndpoint?.trim() || new URL("/api", base.origin).toString();
  try {
    const pingUrl = `${endpoint.replace(/\/+$/g, "")}/raw_exist/${encodeTitlePath(
      "FrontPage",
    )}`;
    await cachedJson(pingUrl);
  } catch {
    return null;
  }

  return createRawMarkupWikiAdapter(request, {
    endpoint,
    rawUrl: (_base, title) =>
      `${endpoint.replace(/\/+$/g, "")}/raw/${encodeTitlePath(title)}`,
    rawFetcher: async (url) => {
      const data = (await cachedJson(url)) as {
        data?: string;
        response?: string;
      };
      return {
        text: data.data ?? "",
        exists: data.response === "ok",
      };
    },
    parseLinks: (text) => extractWikiMarkupLinks(text, request.engine),
  });
}

function createRawMarkupWikiAdapter(
  request: SpeedrunRequest,
  options: {
    endpoint: string;
    backlinkMode?: WikiAdapter["backlinkMode"];
    rawUrl: (base: URL, title: string) => string;
    rawFetcher?: (url: string) => Promise<RawFetchResult>;
    backlinkCount?: (target: ResolvedPage) => Promise<number | null>;
    parseLinks: (text: string) => string[];
  },
): WikiAdapter {
  const base = safeUrl(request.baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }
  const wikiBase = base;
  const pageCache = new Map<string, ResolvedPage | null>();
  const rawCache = new Map<string, RawFetchResult>();
  const fetchRaw = options.rawFetcher ?? fetchPlainRaw;

  async function getRaw(title: string) {
    const key = canonicalTextKey(title);
    const cached = rawCache.get(key);
    if (cached) {
      return cached;
    }
    const result = await fetchRaw(options.rawUrl(wikiBase, title));
    rawCache.set(key, result);
    return result;
  }

  async function resolvePage(rawInput: string): Promise<ResolvedPage | null> {
    const normalized = normalizeTitleInput(rawInput, request.baseUrl);
    if (!normalized) {
      return null;
    }

    const cacheKey = canonicalTextKey(normalized);
    if (pageCache.has(cacheKey)) {
      return pageCache.get(cacheKey) ?? null;
    }

    const raw = await getRaw(normalized);
    if (!raw.exists) {
      pageCache.set(cacheKey, null);
      return null;
    }

    const redirectTitle = extractRedirectTarget(raw.text);
    if (redirectTitle && !titlesEqual(redirectTitle, normalized)) {
      const redirected: ResolvedPage | null = await resolvePage(redirectTitle);
      if (redirected) {
        const page: ResolvedPage = {
          ...redirected,
          inputTitle: rawInput,
          redirectedFrom: normalized,
        };
        pageCache.set(cacheKey, page);
        return page;
      }
    }

    const page: ResolvedPage = {
      pageId: `${request.engine}:${canonicalTextKey(normalized)}`,
      title: normalizeLooseTitle(normalized),
      url: buildHtmlPageUrl(wikiBase, normalized, request.engine),
      ns: namespaceGuess(normalized),
      inputTitle: rawInput,
    };
    pageCache.set(cacheKey, page);
    pageCache.set(canonicalTextKey(page.title), page);
    return page;
  }

  async function getOutgoingLinks(page: ResolvedPage) {
    const raw = await getRaw(page.title);
    if (!raw.exists) {
      throw new SpeedrunError(
        "LINK_EXTRACTION_FAILED",
        "Could not extract valid page links.",
      );
    }
    const text = request.includeFootnotes
      ? raw.text
      : stripWikiMarkupFootnotes(raw.text);
    const titles = options.parseLinks(text);
    return resolveRawLinksToCandidates(titles, page, request, resolvePage);
  }

  async function getBacklinkCount(target: ResolvedPage) {
    if (options.backlinkCount) {
      return options.backlinkCount(target);
    }
    return createHtmlWikiAdapter(request).getBacklinkCount(target);
  }

  return {
    endpoint: options.endpoint,
    backlinkMode: options.backlinkMode ?? "best_effort",
    resolvePage,
    getOutgoingLinks,
    getBacklinkCount,
  };
}

async function fetchPlainRaw(url: string): Promise<RawFetchResult> {
  const response = await throttledFetch(
    url,
    { accept: "text/plain,*/*" },
    true,
  );
  const text = await decodeResponseText(response);
  return {
    text,
    exists: response.ok && !looksLikeHtmlShell(text),
  };
}

function discoverDokuWikiJsonRpcEndpoint(base: URL, explicitEndpoint?: string) {
  if (explicitEndpoint) {
    return explicitEndpoint;
  }
  const url = new URL(base.toString());
  if (!url.pathname.endsWith("/lib/exe/jsonrpc.php")) {
    url.pathname = joinPath(url.pathname, "lib/exe/jsonrpc.php");
  }
  url.search = "";
  return url.toString();
}

async function dokuJsonRpc(
  endpoint: string,
  method: string,
  params: unknown[],
) {
  const requestUrl = new URL(endpoint);
  await scheduleHost(requestUrl.origin);
  const response = await fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": userAgent,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "wiki-speedrun",
      method,
      params,
    }),
  });
  if (response.status === 429) {
    throw new SpeedrunError(
      "SITE_RATE_LIMITED",
      "The wiki API returned HTTP 429.",
    );
  }
  if (!response.ok) {
    throw new SpeedrunError(
      response.status === 404 ? "INVALID_WIKI_SITE" : "NETWORK_ERROR",
      `The wiki server returned HTTP ${response.status}.`,
    );
  }
  const data = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (data.error) {
    throw new SpeedrunError(
      "NETWORK_ERROR",
      data.error.message ?? "DokuWiki JSON-RPC error.",
    );
  }
  return data.result;
}

async function resolveRawLinksToCandidates(
  titles: string[],
  page: ResolvedPage,
  request: SpeedrunRequest,
  resolvePage: (rawInput: string) => Promise<ResolvedPage | null>,
) {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const title of titles.slice(0, 180)) {
    if (!namespaceAllowed(namespaceGuess(title), request.namespacePolicy)) {
      continue;
    }
    if (titlesEqual(title, page.title)) {
      continue;
    }

    const resolved = await resolvePage(title);
    if (
      !resolved ||
      resolved.pageId === page.pageId ||
      seen.has(resolved.pageId)
    ) {
      continue;
    }

    candidates.push({
      page: resolved,
      linkTitle: title,
      redirected: Boolean(resolved.redirectedFrom),
    });
    seen.add(resolved.pageId);
  }

  return candidates;
}

async function discoverMediaWikiEndpoint(
  baseUrl: string,
  explicitEndpoint?: string,
) {
  const candidates = new Set<string>();
  if (explicitEndpoint) {
    candidates.add(explicitEndpoint);
  }

  const base = safeUrl(baseUrl);
  if (!base) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL is not a valid http(s) URL.",
    );
  }

  if (base.pathname.endsWith("/api.php")) {
    candidates.add(base.toString());
  }
  candidates.add(new URL("/w/api.php", base.origin).toString());
  candidates.add(new URL("/api.php", base.origin).toString());

  for (const candidate of candidates) {
    try {
      await mwApi(candidate, {
        action: "query",
        meta: "siteinfo",
        siprop: "general",
      });
      return candidate;
    } catch {
      // Try the next common MediaWiki endpoint shape.
    }
  }

  throw new SpeedrunError(
    "INVALID_WIKI_SITE",
    "No MediaWiki API endpoint responded for this site.",
  );
}

async function resolveMediaWikiPage(
  endpoint: string,
  rawInput: string,
  request: SpeedrunRequest,
) {
  const title = normalizeTitleInput(rawInput, request.baseUrl);
  if (!title) {
    return null;
  }

  const data = await mwApi(endpoint, {
    action: "query",
    redirects: "1",
    converttitles: "1",
    prop: "info",
    inprop: "url",
    titles: title,
  });

  const page = firstPage(data);
  if (!isUsablePage(page)) {
    return null;
  }

  const redirectedFrom = data.query?.redirects?.find(
    (item: { from?: string }) => titlesEqual(item.from, title),
  )?.from;

  return {
    pageId: String(page.pageid),
    title: page.title,
    url: page.fullurl ?? pageUrlFromTitle(request.baseUrl, page.title),
    ns: page.ns,
    inputTitle: rawInput,
    redirectedFrom,
  } satisfies ResolvedPage;
}

async function _resolveMediaWikiPages(
  endpoint: string,
  titles: string[],
  request: SpeedrunRequest,
) {
  const uniqueTitles = [
    ...new Set(
      titles.map((title) => normalizeLooseTitle(title)).filter(Boolean),
    ),
  ];
  const resolved: Candidate[] = [];

  for (const batch of chunk(uniqueTitles, 50)) {
    const data = await mwApi(endpoint, {
      action: "query",
      redirects: "1",
      converttitles: "1",
      prop: "info",
      inprop: "url",
      titles: batch.join("|"),
    });

    const pages = (data.query?.pages ?? []) as MwPage[];
    for (const inputTitle of batch) {
      const redirect = data.query?.redirects?.find(
        (item: { from?: string; to?: string }) =>
          titlesEqual(item.from, inputTitle),
      );
      const targetTitle = redirect?.to ?? inputTitle;
      const page = pages.find((item) => titlesEqual(item.title, targetTitle));
      if (!isUsablePage(page)) {
        continue;
      }
      resolved.push({
        linkTitle: inputTitle,
        redirected: Boolean(redirect),
        page: {
          pageId: String(page.pageid),
          title: page.title,
          url: page.fullurl ?? pageUrlFromTitle(request.baseUrl, page.title),
          ns: page.ns,
          inputTitle,
          redirectedFrom: redirect?.from,
        },
      });
    }
  }

  return resolved;
}

async function getMediaWikiOutgoingLinks(
  endpoint: string,
  page: ResolvedPage,
  request: SpeedrunRequest,
) {
  try {
    const rawLinks = request.includeFootnotes
      ? await getMediaWikiOutgoingLinksFromQuery(endpoint, page)
      : await getMediaWikiOutgoingLinksFromHtml(endpoint, page, request);

    const filteredLinks = rawLinks
      .filter((link) => namespaceAllowed(link.ns, request.namespacePolicy))
      .filter((link) => !titlesEqual(link.title, page.title))
      .slice(0, 180);

    const seen = new Set<string>();
    return filteredLinks
      .map((link) => {
        const title = normalizeLooseTitle(link.title);
        const pageId = `mw-title:${canonicalTextKey(title)}`;
        return {
          linkTitle: title,
          redirected: false,
          page: {
            pageId,
            title,
            url: pageUrlFromTitle(request.baseUrl, title),
            ns: link.ns,
            inputTitle: title,
          },
        } satisfies Candidate;
      })
      .filter((candidate) => {
        const key = candidate.page.pageId;
        if (seen.has(key) || key === page.pageId) {
          return false;
        }
        seen.add(key);
        return true;
      });
  } catch (error) {
    if (error instanceof SpeedrunError) {
      throw error;
    }
    throw new SpeedrunError(
      "LINK_EXTRACTION_FAILED",
      "Could not extract valid page links.",
    );
  }
}

async function getMediaWikiOutgoingLinksFromQuery(
  endpoint: string,
  page: ResolvedPage,
) {
  const pageParam: Record<string, string> = numericPageId(page.pageId)
    ? { pageids: page.pageId }
    : { titles: page.title, redirects: "1" };
  const data = await mwApi(endpoint, {
    action: "query",
    prop: "links",
    pllimit: "max",
    ...pageParam,
  });
  const pageData = firstPage(data);
  return pageData?.links ?? [];
}

async function getMediaWikiOutgoingLinksFromHtml(
  endpoint: string,
  page: ResolvedPage,
  request: SpeedrunRequest,
) {
  const data = await mwApi(endpoint, {
    action: "parse",
    ...(numericPageId(page.pageId)
      ? { pageid: page.pageId }
      : { page: page.title, redirects: "1" }),
    prop: "text",
    disableeditsection: "1",
  });
  const html = stripReferenceHtml(data.parse?.text ?? "");
  const titles = extractInternalTitles(html, request.baseUrl);

  return titles.map((title) => ({
    ns: namespaceGuess(title),
    title,
  }));
}

async function getMediaWikiBacklinkCount(
  endpoint: string,
  target: ResolvedPage,
  namespacePolicy: NamespacePolicy,
) {
  const data = await mwApi(endpoint, {
    action: "query",
    prop: "linkshere",
    lhlimit: "50",
    pageids: target.pageId,
  });
  const page = firstPage(data);
  return (page?.linkshere ?? []).filter((link) =>
    namespaceAllowed(link.ns, namespacePolicy),
  ).length;
}

async function mwApi(endpoint: string, params: Record<string, string>) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({
    format: "json",
    formatversion: "2",
    errorformat: "plaintext",
    ...params,
  })) {
    url.searchParams.set(key, value);
  }

  return cachedJson(url.toString());
}

async function cachedJson(url: string) {
  return cachedJsonWithHeaders(url, {});
}

async function cachedJsonWithHeaders(
  url: string,
  extraHeaders: Record<string, string | undefined>,
) {
  const requestHeaders = Object.fromEntries(
    Object.entries(extraHeaders).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
  const hasSensitiveHeaders = Object.keys(requestHeaders).some((key) =>
    ["authorization", "cookie"].includes(key.toLocaleLowerCase()),
  );
  const headerKey = JSON.stringify(requestHeaders);
  const cacheKey = `${url}#${headerKey}`;
  const cached = hasSensitiveHeaders ? undefined : jsonCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.value as {
      query?: {
        pages?: MwPage[];
        redirects?: Array<{ from?: string; to?: string }>;
      };
      parse?: { text?: string };
      continue?: Record<string, string>;
      error?: { info?: string };
    };
  }

  const response = await throttledFetch(url, {
    accept: "application/json",
    "api-user-agent": userAgent,
    ...requestHeaders,
  });
  const data = await response.json();
  if (data.error) {
    throw new SpeedrunError(
      "NETWORK_ERROR",
      data.error.info ?? "MediaWiki API error.",
    );
  }
  if (!hasSensitiveHeaders) {
    jsonCache.set(cacheKey, {
      expires: Date.now() + 1000 * 60 * 8,
      value: data,
    });
  }
  return data;
}

async function fetchHtml(url: string) {
  const cached = htmlCache.get(url);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const response = await throttledFetch(
    url,
    {
      accept: "text/html,application/xhtml+xml",
    },
    true,
  );
  const value = {
    finalUrl: response.url || url,
    html: await decodeResponseText(response),
    status: response.status,
  };
  htmlCache.set(url, { expires: Date.now() + 1000 * 60 * 6, value });
  return value;
}

async function throttledFetch(
  url: string,
  headers: Record<string, string>,
  allowHttpErrors = false,
) {
  if (!safePublicUrl(url)) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL must be a public http(s) URL.",
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithSafeRedirects(url, headers);
    } catch (error) {
      if (attempt === 2) {
        if (error instanceof SpeedrunError) {
          throw error;
        }
        throw new SpeedrunError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "fetch failed",
        );
      }
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (response.status !== 429) {
      if (!response.ok && !allowHttpErrors) {
        throw new SpeedrunError(
          response.status === 403 ? "INVALID_WIKI_SITE" : "NETWORK_ERROR",
          `The wiki server returned HTTP ${response.status}.`,
        );
      }
      return response;
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) ? retryAfter * 1000 : 1600 * (attempt + 1),
    );
  }

  throw new SpeedrunError(
    "SITE_RATE_LIMITED",
    "The wiki server returned HTTP 429 after retries.",
  );
}

async function fetchWithSafeRedirects(
  initialUrl: string,
  headers: Record<string, string>,
) {
  let current = initialUrl;
  for (
    let redirectCount = 0;
    redirectCount <= maxRedirects;
    redirectCount += 1
  ) {
    const requestUrl = safePublicUrl(current);
    if (!requestUrl) {
      throw new SpeedrunError(
        "INVALID_WIKI_SITE",
        "The wiki URL must be a public http(s) URL.",
      );
    }
    await scheduleHost(requestUrl.origin);

    const response = await fetch(requestUrl, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        ...headers,
        "user-agent": userAgent,
      },
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const nextUrl = safePublicUrl(location, requestUrl);
    if (!nextUrl) {
      throw new SpeedrunError(
        "INVALID_WIKI_SITE",
        "The wiki redirected to a blocked or invalid URL.",
      );
    }
    current = nextUrl.toString();
  }

  throw new SpeedrunError(
    "NETWORK_ERROR",
    "The wiki redirected too many times.",
  );
}

function isRedirectStatus(status: number) {
  return status >= 300 && status < 400;
}

async function decodeResponseText(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const charset =
    contentType.match(/charset=([^;\s]+)/i)?.[1]?.toLocaleLowerCase() ??
    "utf-8";
  const buffer = await response.arrayBuffer();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

async function scheduleHost(origin: string) {
  const interval = origin.includes("wikipedia.org") ? 260 : 120;
  const now = Date.now();
  const nextAt = hostNextRequestAt.get(origin) ?? now;
  const wait = Math.max(0, nextAt - now);
  hostNextRequestAt.set(origin, now + wait + interval);
  if (wait > 0) {
    await sleep(wait);
  }
}

function firstPage(data: { query?: { pages?: MwPage[] } }) {
  return data.query?.pages?.[0];
}

function isUsablePage(
  page: MwPage | undefined,
): page is Required<Pick<MwPage, "pageid" | "title" | "ns">> & MwPage {
  return Boolean(
    page?.pageid &&
      page.title &&
      typeof page.ns === "number" &&
      !page.missing &&
      !page.invalid,
  );
}

function namespaceAllowed(ns: number, policy: NamespacePolicy) {
  if (namespaceGroups.special.has(ns)) {
    return policy.special;
  }
  if (namespaceGroups.file.has(ns)) {
    return policy.file;
  }
  if (namespaceGroups.category.has(ns)) {
    return policy.category;
  }
  if (namespaceGroups.template.has(ns)) {
    return policy.template;
  }
  if (namespaceGroups.user.has(ns)) {
    return policy.user;
  }
  if (namespaceGroups.talk.has(ns)) {
    return policy.talk;
  }
  return true;
}

function normalizeRequest(value: unknown): SpeedrunRequest {
  if (!value || typeof value !== "object") {
    throw new SpeedrunError("INVALID_REQUEST", "Request body must be JSON.");
  }

  const request = value as Partial<SpeedrunRequest>;
  const engine = isWikiEngine(request.engine) ? request.engine : null;
  if (!engine) {
    throw new SpeedrunError("INVALID_REQUEST", "Unsupported wiki engine.");
  }

  const baseUrl = stringField(request.baseUrl, "baseUrl", maxUrlLength);
  const safeBaseUrl = safePublicUrl(baseUrl);
  if (!safeBaseUrl) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The wiki URL must be a public http(s) URL.",
    );
  }

  const apiEndpoint = optionalStringField(request.apiEndpoint, maxUrlLength);
  const safeApiEndpoint = apiEndpoint ? safePublicUrl(apiEndpoint) : null;
  if (apiEndpoint && !safeApiEndpoint) {
    throw new SpeedrunError(
      "INVALID_WIKI_SITE",
      "The API URL must be a public http(s) URL.",
    );
  }

  const search =
    request.search && typeof request.search === "object"
      ? (request.search as Partial<SpeedrunRequest["search"]>)
      : {};
  const requiredStep =
    request.requiredStep && typeof request.requiredStep === "object"
      ? (request.requiredStep as Partial<
          NonNullable<SpeedrunRequest["requiredStep"]>
        >)
      : undefined;

  return {
    engine,
    startTitle: stringField(request.startTitle, "startTitle", maxTitleLength),
    targetTitle: stringField(
      request.targetTitle,
      "targetTitle",
      maxTitleLength,
    ),
    baseUrl: safeBaseUrl.toString(),
    apiEndpoint: safeApiEndpoint?.toString(),
    apiToken: normalizeApiToken(request.apiToken),
    includeFootnotes: Boolean(request.includeFootnotes),
    redirectMode: isRedirectMode(request.redirectMode)
      ? request.redirectMode
      : "auto",
    namespacePolicy: sanitizeNamespacePolicy(request.namespacePolicy),
    requiredStep: {
      enabled: Boolean(requiredStep?.enabled),
      position: clamp(
        Math.trunc(numberOrDefault(requiredStep?.position, 2)),
        2,
        12,
      ),
      title: optionalStringField(requiredStep?.title, maxTitleLength),
    },
    search: {
      maxDepth: clamp(Math.trunc(numberOrDefault(search.maxDepth, 1)), 1, 8),
      maxNodes: clamp(
        Math.trunc(numberOrDefault(search.maxNodes, 80)),
        10,
        1200,
      ),
    },
  };
}

function sanitizeNamespacePolicy(value: unknown): NamespacePolicy {
  if (!value || typeof value !== "object") {
    return {
      file: false,
      category: false,
      template: false,
      user: false,
      talk: false,
      special: false,
    };
  }
  const policy = value as Partial<NamespacePolicy>;
  return {
    file: Boolean(policy.file),
    category: Boolean(policy.category),
    template: Boolean(policy.template),
    user: Boolean(policy.user),
    talk: Boolean(policy.talk),
    special: Boolean(policy.special),
  };
}

function stringField(value: unknown, name: string, maxLength: number) {
  const text = optionalStringField(value, maxLength);
  if (!text) {
    throw new SpeedrunError("INVALID_REQUEST", `${name} is required.`);
  }
  return text;
}

function optionalStringField(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeApiToken(value: unknown) {
  const token = optionalStringField(value, maxTokenLength);
  return token.replace(/^bearer\s+/i, "") || undefined;
}

function isWikiEngine(value: unknown): value is WikiEngine {
  return (
    value === "mediawiki" ||
    value === "the-seed" ||
    value === "opennamu" ||
    value === "dokuwiki" ||
    value === "moniwiki"
  );
}

function isRedirectMode(
  value: unknown,
): value is SpeedrunRequest["redirectMode"] {
  return value === "auto" || value === "count";
}

function normalizeTitleInput(rawInput: string, baseUrl: string) {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return "";
  }

  const asUrl = safeUrl(trimmed);
  if (asUrl) {
    const base = safeUrl(baseUrl);
    if (base && asUrl.origin !== base.origin) {
      return "";
    }

    const queryTitle =
      asUrl.searchParams.get("title") ?? asUrl.searchParams.get("id");
    if (queryTitle) {
      return normalizeLooseTitle(queryTitle);
    }

    for (const marker of ["/wiki/", "/w/", "/wiki.php/"]) {
      const index = asUrl.pathname.indexOf(marker);
      if (index >= 0) {
        return normalizeLooseTitle(asUrl.pathname.slice(index + marker.length));
      }
    }

    return normalizeLooseTitle(
      asUrl.pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
  }

  return normalizeLooseTitle(trimmed);
}

function normalizeLooseTitle(input: string | undefined) {
  if (!input) {
    return "";
  }

  const withoutHash = input.split("#")[0]?.split("?")[0] ?? "";
  const withoutTrailingSlash = withoutHash.replace(/\/+$/g, "");

  try {
    return decodeURIComponent(withoutTrailingSlash).replace(/_/g, " ").trim();
  } catch {
    return withoutTrailingSlash.replace(/_/g, " ").trim();
  }
}

function titlesEqual(left: string | undefined, right: string | undefined) {
  return canonicalTextKey(left) === canonicalTextKey(right);
}

function canonicalTextKey(value: string | undefined) {
  return normalizeLooseTitle(value).toLocaleLowerCase();
}

function canonicalPageId(url: string, title: string) {
  const parsed = safeUrl(url);
  if (!parsed) {
    return canonicalTextKey(title);
  }
  parsed.hash = "";
  parsed.searchParams.delete("from");
  parsed.searchParams.delete("redirect");
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function passesRequiredStep(
  start: ResolvedPage,
  required: ResolvedPage | null,
  hops: Candidate[],
  request: SpeedrunRequest,
) {
  if (!request.requiredStep?.enabled || !required) {
    return true;
  }

  const nodes = buildPathNodes(start, hops, request.redirectMode);
  const requiredIndex = request.requiredStep.position - 1;
  if (nodes.length <= requiredIndex) {
    return true;
  }

  return nodes[requiredIndex]?.pageId === required.pageId;
}

function hasRequiredNode(
  nodes: PathNode[],
  required: ResolvedPage | null,
  request: SpeedrunRequest,
) {
  if (!request.requiredStep?.enabled || !required) {
    return true;
  }
  return nodes[request.requiredStep.position - 1]?.pageId === required.pageId;
}

function buildPathNodes(
  start: ResolvedPage,
  hops: Candidate[],
  redirectMode: "auto" | "count",
): PathNode[] {
  const nodes: PathNode[] = [toPathNode(start)];

  for (const hop of hops) {
    if (redirectMode === "count" && hop.redirected) {
      nodes.push({
        id: `redirect:${hop.linkTitle}->${hop.page.pageId}`,
        pageId: null,
        title: hop.linkTitle,
        url: pageUrlFromTitle(hop.page.url, hop.linkTitle),
        kind: "redirect",
      });
    }
    nodes.push(toPathNode(hop.page, hop.linkTitle));
  }

  return dedupeAdjacent(nodes);
}

function toPathNode(page: ResolvedPage, redirectedFrom?: string): PathNode {
  return {
    id: `page:${page.pageId}`,
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    kind: "page",
    redirectedFrom:
      redirectedFrom && redirectedFrom !== page.title
        ? redirectedFrom
        : undefined,
  };
}

function dedupeAdjacent(nodes: PathNode[]) {
  return nodes.filter(
    (node, index) => index === 0 || node.id !== nodes[index - 1]?.id,
  );
}

function buildEdges(nodes: PathNode[]) {
  return nodes.slice(1).map((node, index) => ({
    from: nodes[index].id,
    to: node.id,
  }));
}

function buildHtmlPageUrl(base: URL, title: string, engine: WikiEngine) {
  const encodedTitle = encodeTitlePath(title);

  if (engine === "dokuwiki") {
    const url = new URL(base.toString());
    if (!url.pathname.endsWith("doku.php")) {
      url.pathname = joinPath(url.pathname, "doku.php");
    }
    url.search = "";
    url.searchParams.set("id", title.replace(/\s/g, "_"));
    return url.toString();
  }

  if (engine === "moniwiki") {
    const url = new URL(base.toString());
    if (
      url.pathname.endsWith("wiki.php") ||
      url.pathname.endsWith("wiki.php/")
    ) {
      url.pathname = joinPath(url.pathname, encodedTitle);
      return url.toString();
    }
    url.pathname = joinPath(url.pathname, encodedTitle);
    return url.toString();
  }

  const url = new URL(base.toString());
  url.search = "";
  url.pathname = joinPath(url.pathname, encodedTitle);
  return url.toString();
}

function extractHtmlEngineLinks(
  html: string,
  currentUrl: string,
  base: URL,
  request: SpeedrunRequest,
) {
  const titles: string[] = [];
  const hrefPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>/gi;
  let match = hrefPattern.exec(html);

  while (match) {
    const href = decodeHtmlAttribute(match[2] ?? "");
    const title = htmlEngineTitleFromHref(
      href,
      currentUrl,
      base,
      request.engine,
    );
    if (title) {
      titles.push(title);
    }
    match = hrefPattern.exec(html);
  }

  return [...new Set(titles)];
}

function htmlEngineTitleFromHref(
  href: string,
  currentUrl: string,
  base: URL,
  engine: WikiEngine,
) {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("javascript:")
  ) {
    return "";
  }

  const url = safeUrl(href, safeUrl(currentUrl) ?? base);
  if (!url || url.origin !== base.origin) {
    return "";
  }
  if (isFunctionalUrl(url)) {
    return "";
  }

  const titleParam =
    url.searchParams.get("title") ?? url.searchParams.get("id");
  if (engine === "dokuwiki" && titleParam) {
    return normalizeLooseTitle(titleParam);
  }

  for (const marker of ["/wiki/", "/w/", "/wiki.php/"]) {
    const index = url.pathname.indexOf(marker);
    if (index >= 0) {
      return normalizeLooseTitle(url.pathname.slice(index + marker.length));
    }
  }

  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  if (url.pathname.startsWith(basePath)) {
    return normalizeLooseTitle(url.pathname.slice(basePath.length));
  }

  return "";
}

function titleFromEngineUrl(urlValue: string, base: URL, engine: WikiEngine) {
  const url = safeUrl(urlValue);
  if (!url) {
    return null;
  }
  return htmlEngineTitleFromHref(url.toString(), base.toString(), base, engine);
}

function backlinkUrls(base: URL, title: string, engine: WikiEngine) {
  const encodedTitle = encodeTitlePath(title);
  const urls: string[] = [];

  if (engine === "the-seed") {
    urls.push(new URL(`/backlink/${encodedTitle}`, base.origin).toString());
    urls.push(new URL(`/xref/${encodedTitle}`, base.origin).toString());
  } else if (engine === "opennamu") {
    urls.push(new URL(`/xref/${encodedTitle}`, base.origin).toString());
    urls.push(new URL(`/backlink/${encodedTitle}`, base.origin).toString());
  } else if (engine === "dokuwiki") {
    const url = new URL(base.toString());
    if (!url.pathname.endsWith("doku.php")) {
      url.pathname = joinPath(url.pathname, "doku.php");
    }
    url.search = "";
    url.searchParams.set("id", title.replace(/\s/g, "_"));
    url.searchParams.set("do", "backlink");
    urls.push(url.toString());
  } else if (engine === "moniwiki") {
    const article = buildHtmlPageUrl(base, title, engine);
    const articleUrl = new URL(article);
    articleUrl.searchParams.set("action", "backlinks");
    urls.push(articleUrl.toString());
    const queryUrl = new URL(base.origin);
    queryUrl.searchParams.set("action", "backlinks");
    queryUrl.searchParams.set("pagename", title);
    urls.push(queryUrl.toString());
  }

  return urls;
}

function isExistingHtmlPage(fetched: HtmlFetchResult) {
  if (fetched.status >= 400) {
    return false;
  }

  const compact = fetched.html.slice(0, 8000).toLocaleLowerCase();
  const missingMarkers = [
    "page does not exist",
    "document does not exist",
    "문서가 없습니다",
    "없는 문서",
    "존재하지 않는 문서",
    "문서가 존재하지 않습니다",
    "해당 문서를 찾을 수 없습니다",
    "このページはまだ作成されていません",
    "not found",
  ];

  return !missingMarkers.some((marker) => compact.includes(marker));
}

function titleFromHtml(html: string) {
  const h1 =
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!h1) {
    return null;
  }
  return normalizeLooseTitle(
    stripTags(h1)
      .replace(/\s+-\s+.*$/g, "")
      .replace(/\s+\|\s+.*$/g, ""),
  );
}

function extractInternalTitles(html: string, baseUrl: string) {
  const titles: string[] = [];
  const hrefPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>/gi;
  let match = hrefPattern.exec(html);

  while (match) {
    const href = decodeHtmlAttribute(match[2] ?? "");
    const title = mediaWikiTitleFromHref(href, baseUrl);
    if (title) {
      titles.push(title);
    }
    match = hrefPattern.exec(html);
  }

  return [...new Set(titles)];
}

function mediaWikiTitleFromHref(href: string, baseUrl: string) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
    return "";
  }

  const base = safeUrl(baseUrl);
  const url = base ? safeUrl(href, base) : null;
  if (!url || (base && url.origin !== base.origin)) {
    return "";
  }
  if (isFunctionalUrl(url) || url.searchParams.get("redlink") === "1") {
    return "";
  }

  const queryTitle = url.searchParams.get("title");
  if (queryTitle) {
    return normalizeLooseTitle(queryTitle);
  }

  const wikiIndex = url.pathname.indexOf("/wiki/");
  if (wikiIndex >= 0) {
    return normalizeLooseTitle(url.pathname.slice(wikiIndex + 6));
  }

  return "";
}

function isFunctionalUrl(url: URL) {
  const path = url.pathname.toLocaleLowerCase();
  if (
    url.searchParams.has("action") ||
    url.searchParams.has("oldid") ||
    url.searchParams.has("diff") ||
    url.searchParams.has("rev")
  ) {
    return true;
  }
  return functionalPathParts.some((part) => path.includes(part));
}

function stripReferenceHtml(html: string) {
  return html
    .replace(
      /<ol\b[^>]*class=["'][^"']*(references|footnotes|reflist)[^"']*["'][\s\S]*?<\/ol>/gi,
      "",
    )
    .replace(
      /<section\b[^>]*class=["'][^"']*(references|footnotes|reflist)[^"']*["'][\s\S]*?<\/section>/gi,
      "",
    )
    .replace(
      /<sup\b[^>]*class=["'][^"']*(reference|footnote)[^"']*["'][\s\S]*?<\/sup>/gi,
      "",
    )
    .replace(
      /<span\b[^>]*class=["'][^"']*mw-ref[^"']*["'][\s\S]*?<\/span>/gi,
      "",
    );
}

function extractWikiMarkupLinks(text: string, engine: WikiEngine) {
  const links: string[] = [];
  const doubleBracketPattern = /\[\[([^\]\n]+?)\]\]/g;
  let match = doubleBracketPattern.exec(text);
  while (match) {
    const target = cleanWikiMarkupTarget(match[1] ?? "");
    if (target) {
      links.push(target);
    }
    match = doubleBracketPattern.exec(text);
  }

  if (engine === "moniwiki") {
    const singleBracketPattern = /(^|[^[])\[([^\n|]{2,120})\]/g;
    let singleMatch = singleBracketPattern.exec(text);
    while (singleMatch) {
      const target = cleanWikiMarkupTarget(singleMatch[2] ?? "");
      if (target) {
        links.push(target);
      }
      singleMatch = singleBracketPattern.exec(text);
    }
  }

  return [...new Set(links)];
}

function cleanWikiMarkupTarget(rawTarget: string) {
  const target = normalizeLooseTitle(
    rawTarget.split("|")[0]?.split("#")[0]?.replace(/^:/, "").trim(),
  );
  if (
    !target ||
    target.includes("://") ||
    target.includes("[") ||
    target.includes("]") ||
    target.startsWith("#") ||
    /^\w+\(/.test(target)
  ) {
    return "";
  }
  return target;
}

function stripWikiMarkupFootnotes(text: string) {
  return text.replace(/\[\*[\s\S]*?\]/g, "");
}

function extractRedirectTarget(text: string) {
  const firstContentLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("//")) ?? "";
  const match =
    firstContentLine.match(/^#(?:redirect|넘겨주기)\s+\[\[([^\]]+)\]\]/i) ??
    firstContentLine.match(/^#(?:redirect|넘겨주기)\s+(.+)$/i);
  return cleanWikiMarkupTarget(match?.[1] ?? "");
}

function looksLikeHtmlShell(text: string) {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(text);
}

function dokuWikiId(title: string) {
  return normalizeLooseTitle(title).replace(/\s+/g, "_").toLocaleLowerCase();
}

function namespaceGuess(title: string) {
  const prefix = title.split(":")[0]?.toLocaleLowerCase();
  if (!prefix || prefix === title.toLocaleLowerCase()) {
    return 0;
  }
  if (["file", "image", "파일", "이미지"].includes(prefix)) {
    return 6;
  }
  if (["category", "분류"].includes(prefix)) {
    return 14;
  }
  if (["template", "틀"].includes(prefix)) {
    return 10;
  }
  if (["user", "사용자"].includes(prefix)) {
    return 2;
  }
  if (["talk", "토론"].includes(prefix)) {
    return 1;
  }
  if (["special", "특수"].includes(prefix)) {
    return -1;
  }
  return 0;
}

function pageUrlFromTitle(baseUrl: string, title: string) {
  const base = safeUrl(baseUrl);
  const encoded = title.split("/").map(encodeURIComponent).join("/");
  return base
    ? new URL(`/wiki/${encoded.replace(/%20/g, "_")}`, base.origin).toString()
    : encoded;
}

function numericPageId(pageId: string) {
  return /^\d+$/.test(pageId);
}

function encodeTitlePath(title: string) {
  return title
    .split("/")
    .map((part) => encodeURIComponent(part.replace(/\s/g, "_")))
    .join("/");
}

function joinPath(basePath: string, nextPath: string) {
  const left = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const right = nextPath.startsWith("/") ? nextPath.slice(1) : nextPath;
  return `${left}/${right}`;
}

function stripTags(value: string) {
  return decodeHtmlAttribute(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeUrl(value: string, base?: URL) {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function safePublicUrl(value: string | URL, base?: URL) {
  const url =
    value instanceof URL
      ? new URL(value.toString())
      : base
        ? safeUrl(value, base)
        : safeUrl(value);
  if (!url || isBlockedHostname(url.hostname)) {
    return null;
  }
  url.username = "";
  url.password = "";
  return url;
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLocaleLowerCase().replace(/\.$/g, "");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPrivateIpv4(ipv4);
  }

  return isPrivateIpv6(normalized.replace(/^\[|\]$/g, ""));
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== parts[index],
    )
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isPrivateIpv4([first, second]: [number, number, number, number]) {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPrivateIpv6(hostname: string) {
  if (!hostname.includes(":")) {
    return false;
  }
  if (hostname === "::1" || hostname === "::") {
    return true;
  }
  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedIpv4) {
    const ipv4 = parseIpv4(mappedIpv4);
    return !ipv4 || isPrivateIpv4(ipv4);
  }
  const firstHextet = Number.parseInt(hostname.split(":")[0] ?? "", 16);
  return (
    Number.isFinite(firstHextet) &&
    ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80)
  );
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(code: ErrorCode, message: string) {
  return Response.json(failurePayload(code, message), {
    status:
      code === "NETWORK_ERROR" || code === "SITE_RATE_LIMITED"
        ? 502
        : code === "INVALID_REQUEST" || code === "INVALID_WIKI_SITE"
          ? 400
          : 200,
  });
}

function failurePayload(code: ErrorCode, message: string) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

class SpeedrunError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
