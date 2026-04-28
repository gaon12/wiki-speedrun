type WikiEngine =
  | "mediawiki"
  | "the-seed"
  | "opennamu"
  | "dokuwiki"
  | "moniwiki";

type ErrorCode =
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

export async function POST(request: Request) {
  try {
    const body = normalizeRequest((await request.json()) as SpeedrunRequest);
    const adapter =
      body.engine === "mediawiki"
        ? await createMediaWikiAdapter(body)
        : createHtmlWikiAdapter(body);

    const start = await adapter.resolvePage(body.startTitle);
    if (!start) {
      return fail(
        "START_NOT_FOUND",
        "The start document could not be resolved to an existing page.",
      );
    }

    const target = await adapter.resolvePage(body.targetTitle);
    if (!target) {
      return fail(
        "TARGET_NOT_FOUND",
        "The target document could not be resolved to an existing page.",
      );
    }

    const required = body.requiredStep?.enabled
      ? await adapter.resolvePage(body.requiredStep.title)
      : null;
    if (body.requiredStep?.enabled && !required) {
      return fail(
        "REQUIRED_STEP_NOT_FOUND",
        "The required Nth document could not be resolved.",
      );
    }

    if (start.pageId === target.pageId) {
      return fail(
        "SAME_DOCUMENT",
        "Start and target resolve to the same canonical page.",
      );
    }

    const startLinks = await adapter.getOutgoingLinks(start);
    if (startLinks.length === 0) {
      return fail(
        "START_HAS_NO_VALID_OUT_LINKS",
        "The start document exists, but it has no valid outgoing links under the current options.",
      );
    }

    const targetBacklinks = await adapter.getBacklinkCount(target);
    if (targetBacklinks === 0) {
      return fail(
        "TARGET_HAS_NO_VALID_IN_LINKS",
        "The target document exists, but no valid backlinks were found under the current options.",
      );
    }

    const result = await findPath(adapter, start, target, required, body, {
      [start.pageId]: startLinks,
    });

    return Response.json({
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
    });
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

async function findPath(
  adapter: WikiAdapter,
  start: ResolvedPage,
  target: ResolvedPage,
  required: ResolvedPage | null,
  request: SpeedrunRequest,
  seededLinks: Record<string, Candidate[]>,
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
  const cached = jsonCache.get(url);
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
  });
  const data = await response.json();
  if (data.error) {
    throw new SpeedrunError(
      "NETWORK_ERROR",
      data.error.info ?? "MediaWiki API error.",
    );
  }
  jsonCache.set(url, { expires: Date.now() + 1000 * 60 * 8, value: data });
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
    html: await response.text(),
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
  const requestUrl = new URL(url);
  await scheduleHost(requestUrl.origin);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
        headers: {
          ...headers,
          "user-agent": userAgent,
        },
      });
    } catch (error) {
      if (attempt === 2) {
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

function normalizeRequest(request: SpeedrunRequest): SpeedrunRequest {
  return {
    ...request,
    startTitle: request.startTitle.trim(),
    targetTitle: request.targetTitle.trim(),
    baseUrl: request.baseUrl.trim(),
    apiEndpoint: request.apiEndpoint?.trim(),
    search: {
      maxDepth: clamp(Math.trunc(request.search.maxDepth || 1), 1, 8),
      maxNodes: clamp(Math.trunc(request.search.maxNodes || 80), 10, 1200),
    },
  };
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
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    {
      status:
        code === "NETWORK_ERROR" || code === "SITE_RATE_LIMITED" ? 502 : 200,
    },
  );
}

class SpeedrunError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
