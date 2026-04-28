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
  pageId: number;
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
  pageId: number | null;
  title: string;
  url: string;
  kind: "page" | "redirect";
  redirectedFrom?: string;
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

const namespaceGroups = {
  file: new Set([6, 7]),
  category: new Set([14, 15]),
  template: new Set([10, 11]),
  user: new Set([2, 3]),
  talk: new Set([1, 3, 5, 7, 9, 11, 13, 15]),
  special: new Set([-1]),
};

const userAgent = "wiki-speedrun/0.1 (local development)";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SpeedrunRequest;

    if (body.engine !== "mediawiki") {
      return fail(
        "BACKLINK_LOOKUP_UNSUPPORTED",
        "This engine is registered in the UI, but only MediaWiki path search is implemented in this first version.",
      );
    }

    const endpoint = await discoverMediaWikiEndpoint(
      body.baseUrl,
      body.apiEndpoint,
    );
    const [start, target, required] = await Promise.all([
      resolvePage(endpoint, body.startTitle, body.baseUrl),
      resolvePage(endpoint, body.targetTitle, body.baseUrl),
      body.requiredStep?.enabled
        ? resolvePage(endpoint, body.requiredStep.title, body.baseUrl)
        : Promise.resolve(null),
    ]);

    if (!start) {
      return fail(
        "START_NOT_FOUND",
        "The start document could not be resolved to an existing page.",
      );
    }
    if (!target) {
      return fail(
        "TARGET_NOT_FOUND",
        "The target document could not be resolved to an existing page.",
      );
    }
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

    const [startLinks, targetBacklinks] = await Promise.all([
      getOutgoingLinks(endpoint, body.baseUrl, start, body),
      getBacklinks(endpoint, target, body.namespacePolicy),
    ]);

    if (startLinks.length === 0) {
      return fail(
        "START_HAS_NO_VALID_OUT_LINKS",
        "The start document exists, but it has no valid outgoing links under the current options.",
      );
    }
    if (targetBacklinks.length === 0) {
      return fail(
        "TARGET_HAS_NO_VALID_IN_LINKS",
        "The target document exists, but no valid backlinks were found under the current options.",
      );
    }

    const result = await findPath(
      endpoint,
      body.baseUrl,
      start,
      target,
      required,
      body,
    );

    return Response.json({
      ok: true,
      endpoint,
      start,
      target,
      required,
      ...result,
      checks: {
        startOutLinks: startLinks.length,
        targetBacklinks: targetBacklinks.length,
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
  endpoint: string,
  baseUrl: string,
  start: ResolvedPage,
  target: ResolvedPage,
  required: ResolvedPage | null,
  request: SpeedrunRequest,
) {
  type QueueEntry = {
    current: ResolvedPage;
    hops: Candidate[];
  };

  const queue: QueueEntry[] = [{ current: start, hops: [] }];
  const visited = new Set<number>([start.pageId]);
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

    const links = await getOutgoingLinks(
      endpoint,
      baseUrl,
      entry.current,
      request,
    );
    for (const candidate of links) {
      if (candidate.page.pageId === entry.current.pageId) {
        continue;
      }

      const nextHops = [...entry.hops, candidate];
      if (!passesRequiredStep(start, required, nextHops, request)) {
        continue;
      }

      if (candidate.page.pageId === target.pageId) {
        const nodes = buildPathNodes(start, nextHops, request.redirectMode);
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

async function resolvePage(
  endpoint: string,
  rawInput: string,
  baseUrl: string,
) {
  const title = normalizeTitleInput(rawInput, baseUrl);
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
    pageId: page.pageid,
    title: page.title,
    url: page.fullurl ?? pageUrlFromTitle(baseUrl, page.title),
    ns: page.ns,
    inputTitle: rawInput,
    redirectedFrom,
  } satisfies ResolvedPage;
}

async function resolvePages(
  endpoint: string,
  titles: string[],
  baseUrl: string,
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
          pageId: page.pageid,
          title: page.title,
          url: page.fullurl ?? pageUrlFromTitle(baseUrl, page.title),
          ns: page.ns,
          inputTitle,
          redirectedFrom: redirect?.from,
        },
      });
    }
  }

  return resolved;
}

async function getOutgoingLinks(
  endpoint: string,
  baseUrl: string,
  page: ResolvedPage,
  request: SpeedrunRequest,
) {
  try {
    const rawLinks = request.includeFootnotes
      ? await getOutgoingLinksFromQuery(endpoint, page)
      : await getOutgoingLinksFromHtml(endpoint, baseUrl, page);

    const filteredTitles = rawLinks
      .filter((link) => namespaceAllowed(link.ns, request.namespacePolicy))
      .map((link) => link.title)
      .filter((title) => !titlesEqual(title, page.title));

    const resolved = await resolvePages(endpoint, filteredTitles, baseUrl);
    const seen = new Set<number>();

    return resolved
      .filter((candidate) =>
        namespaceAllowed(candidate.page.ns, request.namespacePolicy),
      )
      .filter((candidate) => candidate.page.pageId !== page.pageId)
      .filter((candidate) => {
        if (seen.has(candidate.page.pageId)) {
          return false;
        }
        seen.add(candidate.page.pageId);
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

async function getOutgoingLinksFromQuery(endpoint: string, page: ResolvedPage) {
  const links: Array<{ ns: number; title: string }> = [];
  let continuation: Record<string, string> | undefined;

  do {
    const data = await mwApi(endpoint, {
      action: "query",
      prop: "links",
      pllimit: "max",
      pageids: String(page.pageId),
      ...(continuation ?? {}),
    });
    const pageData = firstPage(data);
    links.push(...(pageData?.links ?? []));
    continuation = data.continue;
  } while (continuation);

  return links;
}

async function getOutgoingLinksFromHtml(
  endpoint: string,
  baseUrl: string,
  page: ResolvedPage,
) {
  const data = await mwApi(endpoint, {
    action: "parse",
    pageid: String(page.pageId),
    prop: "text",
    disableeditsection: "1",
  });
  const html = stripReferenceHtml(data.parse?.text ?? "");
  const titles = extractInternalTitles(html, baseUrl);

  return titles.map((title) => ({
    ns: namespaceGuess(title),
    title,
  }));
}

async function getBacklinks(
  endpoint: string,
  target: ResolvedPage,
  namespacePolicy: NamespacePolicy,
) {
  const links: Array<{ ns: number; title: string }> = [];
  let continuation: Record<string, string> | undefined;

  do {
    const data = await mwApi(endpoint, {
      action: "query",
      prop: "linkshere",
      lhlimit: "max",
      pageids: String(target.pageId),
      ...(continuation ?? {}),
    });
    const page = firstPage(data);
    links.push(...(page?.linkshere ?? []));
    continuation = data.continue;
  } while (continuation);

  return links.filter((link) => namespaceAllowed(link.ns, namespacePolicy));
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

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": userAgent,
    },
  });

  if (response.status === 429) {
    throw new SpeedrunError(
      "SITE_RATE_LIMITED",
      "The wiki API returned HTTP 429.",
    );
  }
  if (!response.ok) {
    throw new SpeedrunError(
      "NETWORK_ERROR",
      `The wiki API returned HTTP ${response.status}.`,
    );
  }

  const data = await response.json();
  if (data.error) {
    throw new SpeedrunError(
      "NETWORK_ERROR",
      data.error.info ?? "MediaWiki API error.",
    );
  }
  return data;
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

    const queryTitle = asUrl.searchParams.get("title");
    if (queryTitle) {
      return normalizeLooseTitle(queryTitle);
    }

    const wikiIndex = asUrl.pathname.indexOf("/wiki/");
    if (wikiIndex >= 0) {
      return normalizeLooseTitle(asUrl.pathname.slice(wikiIndex + 6));
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
  return (
    normalizeLooseTitle(left).toLocaleLowerCase() ===
    normalizeLooseTitle(right).toLocaleLowerCase()
  );
}

function stripReferenceHtml(html: string) {
  return html
    .replace(
      /<ol\b[^>]*class=["'][^"']*references[^"']*["'][\s\S]*?<\/ol>/gi,
      "",
    )
    .replace(
      /<sup\b[^>]*class=["'][^"']*reference[^"']*["'][\s\S]*?<\/sup>/gi,
      "",
    )
    .replace(
      /<span\b[^>]*class=["'][^"']*mw-ref[^"']*["'][\s\S]*?<\/span>/gi,
      "",
    );
}

function extractInternalTitles(html: string, baseUrl: string) {
  const titles: string[] = [];
  const hrefPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>/gi;
  let match = hrefPattern.exec(html);

  while (match) {
    const href = match[2];
    const title = titleFromHref(href, baseUrl);
    if (title) {
      titles.push(title);
    }
    match = hrefPattern.exec(html);
  }

  return [...new Set(titles)];
}

function titleFromHref(href: string, baseUrl: string) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
    return "";
  }

  const base = safeUrl(baseUrl);
  const url = base ? safeUrl(href, base) : null;
  if (!url || (base && url.origin !== base.origin)) {
    return "";
  }
  if (
    url.searchParams.has("action") ||
    url.searchParams.has("oldid") ||
    url.searchParams.has("diff")
  ) {
    return "";
  }
  if (url.searchParams.get("redlink") === "1") {
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
