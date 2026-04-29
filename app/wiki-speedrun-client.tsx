"use client";

import {
  ApartmentOutlined,
  ApiOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  FileSearchOutlined,
  GlobalOutlined,
  LinkOutlined,
  MoonOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  SunOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  ConfigProvider,
  Divider,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type Locale = "ko" | "en" | "ja";
type ColorMode = "light" | "dark";
type WikiEngine =
  | "mediawiki"
  | "the-seed"
  | "opennamu"
  | "dokuwiki"
  | "moniwiki";
type RedirectMode = "auto" | "count";
type ViewMode = "iframe" | "compact";

type NamespacePolicy = {
  file: boolean;
  category: boolean;
  template: boolean;
  user: boolean;
  talk: boolean;
  special: boolean;
};

type LocalSettings = {
  locale: Locale;
  mode: ColorMode;
  siteKey: string;
  customBaseUrl: string;
  customApiEndpoint: string;
  customEngine: WikiEngine;
  startTitle: string;
  targetTitle: string;
  includeFootnotes: boolean;
  redirectMode: RedirectMode;
  namespacePolicy: NamespacePolicy;
  requiredEnabled: boolean;
  requiredPosition: number;
  requiredTitle: string;
  maxDepth: number;
  maxNodes: number;
  viewMode: ViewMode;
};

type PresetSite = {
  key: string;
  label: string;
  engine: WikiEngine;
  baseUrl: string;
  apiEndpoint?: string;
};

type PathNode = {
  id: string;
  pageId: string | null;
  title: string;
  url: string;
  kind: "page" | "redirect";
  redirectedFrom?: string;
};

type SpeedrunResponse =
  | {
      ok: true;
      endpoint: string;
      path: PathNode[];
      clicks: number;
      expanded: number;
      backlinkMode: "api" | "html" | "best_effort";
      checks: {
        startOutLinks: number;
        targetBacklinks: number | null;
      };
      start: { pageId: string; title: string; url: string };
      target: { pageId: string; title: string; url: string };
      required: { pageId: string; title: string; url: string } | null;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

type SearchProgress = {
  stage: string;
  message: string;
  percent: number;
  expanded?: number;
  queued?: number;
  depth?: number;
  title?: string;
};

type StreamEvent =
  | (SearchProgress & { type: "progress" })
  | { type: "result"; data: SpeedrunResponse };

const presets: PresetSite[] = [
  {
    key: "ko-wikipedia",
    label: "한국어 위키백과",
    engine: "mediawiki",
    baseUrl: "https://ko.wikipedia.org/wiki/",
    apiEndpoint: "https://ko.wikipedia.org/w/api.php",
  },
  {
    key: "wikipedia",
    label: "English Wikipedia",
    engine: "mediawiki",
    baseUrl: "https://en.wikipedia.org/wiki/",
    apiEndpoint: "https://en.wikipedia.org/w/api.php",
  },
  {
    key: "mediawiki",
    label: "MediaWiki.org",
    engine: "mediawiki",
    baseUrl: "https://www.mediawiki.org/wiki/",
    apiEndpoint: "https://www.mediawiki.org/w/api.php",
  },
  {
    key: "namuwiki",
    label: "나무위키",
    engine: "the-seed",
    baseUrl: "https://namu.wiki/w/",
    apiEndpoint: "https://wiki-api.namu.la/api",
  },
  {
    key: "opennamu-onts",
    label: "openNAMU ONTS",
    engine: "opennamu",
    baseUrl: "https://openna.mu.io.kr/w/",
    apiEndpoint: "https://openna.mu.io.kr/api",
  },
  {
    key: "dokuwiki",
    label: "DokuWiki.org",
    engine: "dokuwiki",
    baseUrl: "https://www.dokuwiki.org/",
  },
  {
    key: "moniwiki-kldp",
    label: "MoniWiki KLDP",
    engine: "moniwiki",
    baseUrl: "https://wiki.kldp.org/wiki.php/",
  },
  {
    key: "custom",
    label: "사용자 설정 위키",
    engine: "mediawiki",
    baseUrl: "",
  },
];

const engineOptions: Array<{ label: string; value: WikiEngine }> = [
  { label: "MediaWiki", value: "mediawiki" },
  { label: "the seed", value: "the-seed" },
  { label: "openNAMU", value: "opennamu" },
  { label: "DokuWiki", value: "dokuwiki" },
  { label: "MoniWiki", value: "moniwiki" },
];

const text = {
  ko: {
    subtitle: "정규화, 리다이렉트, 유효 링크 필터를 포함한 위키 경로 탐색기",
    setup: "게임 설정",
    setupDesc: "출발/도착 문서와 위키 엔진 옵션을 정합니다.",
    wiki: "위키 사이트",
    customBase: "사용자 사이트 URL",
    customApi: "API URL",
    apiToken: "API 토큰",
    engine: "엔진",
    start: "출발 문서",
    target: "도착 문서",
    startPlaceholder: "예: 나무위키, Seoul, 대한민국",
    targetPlaceholder: "예: 철학, Tokyo, MediaWiki",
    rules: "규칙 옵션",
    includeFootnotes: "각주 링크 포함",
    redirectMode: "리다이렉트 계산",
    autoRedirect: "자동 해석",
    countRedirect: "클릭으로 계산",
    namespaceFilters: "문서 네임스페이스 허용",
    requiredNth: "N번째 문서 강제",
    requiredPosition: "문서 순번",
    requiredTitle: "필수 문서명",
    maxDepth: "최대 클릭",
    maxNodes: "최대 탐색 문서",
    run: "경로 찾기",
    running: "탐색 중",
    result: "스피드런 시각화",
    resultDesc: "가장 먼저 발견된 최단 경로를 문서 노드와 링크로 표시합니다.",
    emptyTitle: "아직 경로를 찾지 않았습니다.",
    emptyCopy:
      "MediaWiki, DokuWiki, openNAMU는 가능한 경우 API를 우선 사용합니다. the seed는 토큰 없이 공개 HTML로도 탐색하며, 토큰이 있으면 API를 사용합니다.",
    iframe: "GUI",
    compact: "URL",
    iframeWarning:
      "일부 위키는 보안 정책으로 iframe 표시를 차단합니다. 차단되면 URL 모드로 확인하세요.",
    iframeBlocked: "iframe 표시가 차단되었을 수 있습니다.",
    clicks: "클릭",
    expanded: "탐색",
    outLinks: "출발 링크",
    backlinks: "도착 백링크",
    endpoint: "API",
    backlinkMode: "백링크 확인",
    noResult: "실패",
    success: "성공",
    errorCode: "오류 코드",
    progress: "진행 상황",
    queue: "대기",
    depth: "깊이",
  },
  en: {
    subtitle:
      "Wiki route finder with normalization, redirects, and valid-link filters",
    setup: "Game Setup",
    setupDesc: "Choose documents, wiki engine, and route rules.",
    wiki: "Wiki site",
    customBase: "Custom site URL",
    customApi: "API URL",
    apiToken: "API token",
    engine: "Engine",
    start: "Start document",
    target: "Target document",
    startPlaceholder: "e.g. Seoul, Namuwiki, Korea",
    targetPlaceholder: "e.g. Philosophy, Tokyo, MediaWiki",
    rules: "Rule Options",
    includeFootnotes: "Include footnote links",
    redirectMode: "Redirect handling",
    autoRedirect: "Resolve automatically",
    countRedirect: "Count as click",
    namespaceFilters: "Allowed namespaces",
    requiredNth: "Force Nth document",
    requiredPosition: "Position",
    requiredTitle: "Required title",
    maxDepth: "Max clicks",
    maxNodes: "Max explored pages",
    run: "Find route",
    running: "Searching",
    result: "Speedrun Visualization",
    resultDesc:
      "The first shortest path found is shown as page nodes and links.",
    emptyTitle: "No route yet.",
    emptyCopy:
      "MediaWiki, DokuWiki, and openNAMU prefer APIs when available. the seed can search public HTML without a token and uses the API when a token is supplied.",
    iframe: "GUI",
    compact: "URL",
    iframeWarning:
      "Some wikis block iframe rendering via security policy. Use URL mode when blocked.",
    iframeBlocked: "The iframe may be blocked.",
    clicks: "Clicks",
    expanded: "Explored",
    outLinks: "Start links",
    backlinks: "Target backlinks",
    endpoint: "API",
    backlinkMode: "Backlink check",
    noResult: "Failed",
    success: "Success",
    errorCode: "Error code",
    progress: "Progress",
    queue: "Queued",
    depth: "Depth",
  },
  ja: {
    subtitle: "正規化、リダイレクト、有効リンク判定を含むWiki経路探索",
    setup: "ゲーム設定",
    setupDesc: "文書、Wikiエンジン、探索ルールを選びます。",
    wiki: "Wikiサイト",
    customBase: "カスタムサイトURL",
    customApi: "API URL",
    apiToken: "APIトークン",
    engine: "エンジン",
    start: "開始文書",
    target: "到着文書",
    startPlaceholder: "例: Seoul, Namuwiki, Korea",
    targetPlaceholder: "例: Philosophy, Tokyo, MediaWiki",
    rules: "ルール",
    includeFootnotes: "脚注リンクを含める",
    redirectMode: "リダイレクト",
    autoRedirect: "自動解決",
    countRedirect: "クリックに数える",
    namespaceFilters: "許可する名前空間",
    requiredNth: "N番目の文書を固定",
    requiredPosition: "順番",
    requiredTitle: "必須文書名",
    maxDepth: "最大クリック",
    maxNodes: "最大探索文書",
    run: "経路検索",
    running: "探索中",
    result: "スピードラン可視化",
    resultDesc: "最初に見つかった最短経路を文書ノードとリンクで表示します。",
    emptyTitle: "まだ経路がありません。",
    emptyCopy:
      "MediaWiki、DokuWiki、openNAMUは可能な場合APIを優先します。the seedはトークンなしの公開HTML探索に対応し、トークンがある場合はAPIを使います。",
    iframe: "GUI",
    compact: "URL",
    iframeWarning:
      "一部のWikiはセキュリティ設定でiframe表示をブロックします。URL表示を使ってください。",
    iframeBlocked: "iframe表示がブロックされた可能性があります。",
    clicks: "クリック",
    expanded: "探索",
    outLinks: "開始リンク",
    backlinks: "到着バックリンク",
    endpoint: "API",
    backlinkMode: "バックリンク確認",
    noResult: "失敗",
    success: "成功",
    errorCode: "エラーコード",
    progress: "進行状況",
    queue: "待機",
    depth: "深さ",
  },
} satisfies Record<Locale, Record<string, string>>;

const namespaceLabels: Array<{ key: keyof NamespacePolicy; label: string }> = [
  { key: "file", label: "File" },
  { key: "category", label: "Category" },
  { key: "template", label: "Template" },
  { key: "user", label: "User" },
  { key: "talk", label: "Talk" },
  { key: "special", label: "Special" },
];

const localSettingsKey = "LocalSettings";
const defaultNamespacePolicy: NamespacePolicy = {
  file: false,
  category: false,
  template: false,
  user: false,
  talk: false,
  special: false,
};

const defaultLocalSettings: LocalSettings = {
  locale: "ko",
  mode: "light",
  siteKey: "ko-wikipedia",
  customBaseUrl: "",
  customApiEndpoint: "",
  customEngine: "mediawiki",
  startTitle: "대한민국",
  targetTitle: "철학",
  includeFootnotes: false,
  redirectMode: "auto",
  namespacePolicy: defaultNamespacePolicy,
  requiredEnabled: false,
  requiredPosition: 2,
  requiredTitle: "",
  maxDepth: 4,
  maxNodes: 140,
  viewMode: "iframe",
};

const localeLabels: Record<Locale, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
};

export default function WikiSpeedrunClient() {
  const [mode, setMode] = useState<ColorMode>("light");

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, [mode]);

  return (
    <ConfigProvider
      theme={{
        algorithm:
          mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          borderRadius: 8,
          colorPrimary: "#2563eb",
          colorBgBase: mode === "dark" ? "#10151d" : "#f4f7fb",
          colorBgContainer: mode === "dark" ? "#151c26" : "#ffffff",
          colorBorder: mode === "dark" ? "#293444" : "#dbe3ef",
          colorTextBase: mode === "dark" ? "#e7edf7" : "#172033",
          colorTextSecondary: mode === "dark" ? "#9aa8bd" : "#667085",
          fontFamily: "var(--font-geist-sans), Arial, sans-serif",
        },
      }}
    >
      <AntApp>
        <WikiSpeedrunSurface mode={mode} setMode={setMode} />
      </AntApp>
    </ConfigProvider>
  );
}

function WikiSpeedrunSurface({
  mode,
  setMode,
}: {
  mode: ColorMode;
  setMode: (mode: ColorMode | ((mode: ColorMode) => ColorMode)) => void;
}) {
  const [settingsReady, setSettingsReady] = useState(false);
  const [locale, setLocale] = useState<Locale>(defaultLocalSettings.locale);
  const [siteKey, setSiteKey] = useState(defaultLocalSettings.siteKey);
  const selectedPreset =
    presets.find((site) => site.key === siteKey) ?? presets[0];
  const [customBaseUrl, setCustomBaseUrl] = useState(
    defaultLocalSettings.customBaseUrl,
  );
  const [customApiEndpoint, setCustomApiEndpoint] = useState(
    defaultLocalSettings.customApiEndpoint,
  );
  const [customApiToken, setCustomApiToken] = useState("");
  const [customEngine, setCustomEngine] = useState<WikiEngine>(
    defaultLocalSettings.customEngine,
  );
  const [startTitle, setStartTitle] = useState(defaultLocalSettings.startTitle);
  const [targetTitle, setTargetTitle] = useState(
    defaultLocalSettings.targetTitle,
  );
  const [includeFootnotes, setIncludeFootnotes] = useState(
    defaultLocalSettings.includeFootnotes,
  );
  const [redirectMode, setRedirectMode] = useState<RedirectMode>(
    defaultLocalSettings.redirectMode,
  );
  const [namespacePolicy, setNamespacePolicy] = useState<NamespacePolicy>({
    ...defaultLocalSettings.namespacePolicy,
  });
  const [requiredEnabled, setRequiredEnabled] = useState(
    defaultLocalSettings.requiredEnabled,
  );
  const [requiredPosition, setRequiredPosition] = useState(
    defaultLocalSettings.requiredPosition,
  );
  const [requiredTitle, setRequiredTitle] = useState(
    defaultLocalSettings.requiredTitle,
  );
  const [maxDepth, setMaxDepth] = useState(defaultLocalSettings.maxDepth);
  const [maxNodes, setMaxNodes] = useState(defaultLocalSettings.maxNodes);
  const [viewMode, setViewMode] = useState<ViewMode>(
    defaultLocalSettings.viewMode,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SpeedrunResponse | null>(null);
  const [progress, setProgress] = useState<SearchProgress>({
    stage: "idle",
    message: "",
    percent: 0,
  });
  const [progressLog, setProgressLog] = useState<
    Array<{ id: string; text: string }>
  >([]);
  const { message, modal } = AntApp.useApp();
  const t = text[locale];

  const site = useMemo(() => {
    if (siteKey === "custom") {
      return {
        key: "custom",
        label: "Custom",
        engine: customEngine,
        baseUrl: customBaseUrl,
        apiEndpoint: customApiEndpoint,
        apiToken: customApiToken,
      };
    }
    return { ...selectedPreset, apiToken: customApiToken };
  }, [
    customApiEndpoint,
    customApiToken,
    customBaseUrl,
    customEngine,
    selectedPreset,
    siteKey,
  ]);

  const success = result?.ok ? result : null;
  const failure = result && !result.ok ? result : null;
  const activeNode = success?.path[activeIndex] ?? success?.path[0];
  const connectionDescription = describeSiteConnection(site);

  useEffect(() => {
    const saved = readLocalSettings();
    setLocale(saved.locale);
    setMode(saved.mode);
    setSiteKey(saved.siteKey);
    setCustomBaseUrl(saved.customBaseUrl);
    setCustomApiEndpoint(saved.customApiEndpoint);
    setCustomEngine(saved.customEngine);
    setStartTitle(saved.startTitle);
    setTargetTitle(saved.targetTitle);
    setIncludeFootnotes(saved.includeFootnotes);
    setRedirectMode(saved.redirectMode);
    setNamespacePolicy(saved.namespacePolicy);
    setRequiredEnabled(saved.requiredEnabled);
    setRequiredPosition(saved.requiredPosition);
    setRequiredTitle(saved.requiredTitle);
    setMaxDepth(saved.maxDepth);
    setMaxNodes(saved.maxNodes);
    setViewMode(saved.viewMode);
    setSettingsReady(true);
  }, [setMode]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    writeLocalSettings({
      locale,
      mode,
      siteKey,
      customBaseUrl,
      customApiEndpoint,
      customEngine,
      startTitle,
      targetTitle,
      includeFootnotes,
      redirectMode,
      namespacePolicy,
      requiredEnabled,
      requiredPosition,
      requiredTitle,
      maxDepth,
      maxNodes,
      viewMode,
    });
  }, [
    customApiEndpoint,
    customBaseUrl,
    customEngine,
    includeFootnotes,
    locale,
    maxDepth,
    maxNodes,
    mode,
    namespacePolicy,
    redirectMode,
    requiredEnabled,
    requiredPosition,
    requiredTitle,
    settingsReady,
    siteKey,
    startTitle,
    targetTitle,
    viewMode,
  ]);

  async function runSearch() {
    setLoading(true);
    setResult(null);
    setProgress({
      stage: "prepare",
      message: t.running,
      percent: 1,
    });
    setProgressLog([{ id: crypto.randomUUID(), text: t.running }]);
    setActiveIndex(0);

    try {
      const response = await fetch("/api/speedrun?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSearchRequest()),
      });
      const payload = response.body
        ? await readSpeedrunStream(response.body)
        : ((await response.json()) as SpeedrunResponse);
      setResult(payload);
      if (payload.ok) {
        setProgress((current) => ({
          ...current,
          stage: "complete",
          message: `${t.success}: ${payload.clicks}`,
          percent: 100,
        }));
        message.success(`${t.success}: ${payload.clicks}`);
      } else {
        setProgress((current) => ({
          ...current,
          stage: "failed",
          message: `${payload.error.code}: ${payload.error.message}`,
        }));
        message.error(`${t.noResult}: ${payload.error.code}`);
      }
    } catch (error) {
      setResult({
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: error instanceof Error ? error.message : "Request failed",
        },
      });
    } finally {
      setLoading(false);
    }
  }

  function buildSearchRequest() {
    return {
      engine: site.engine,
      baseUrl: site.baseUrl,
      apiEndpoint: site.apiEndpoint || undefined,
      apiToken: site.apiToken?.trim() || undefined,
      startTitle,
      targetTitle,
      includeFootnotes,
      redirectMode,
      namespacePolicy,
      requiredStep: {
        enabled: requiredEnabled,
        position: requiredPosition,
        title: requiredTitle,
      },
      search: {
        maxDepth,
        maxNodes,
      },
    };
  }

  async function readSpeedrunStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalPayload: SpeedrunResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "progress") {
          const nextProgress = {
            stage: event.stage,
            message: event.message,
            percent: event.percent,
            expanded: event.expanded,
            queued: event.queued,
            depth: event.depth,
            title: event.title,
          };
          setProgress(nextProgress);
          setProgressLog((current) =>
            [
              {
                id: crypto.randomUUID(),
                text: `${event.percent}% · ${event.message}`,
              },
              ...current,
            ].slice(0, 8),
          );
        } else {
          finalPayload = event.data;
        }
      }
    }

    if (buffer.trim()) {
      const event = JSON.parse(buffer) as StreamEvent;
      if (event.type === "result") {
        finalPayload = event.data;
      }
    }

    if (!finalPayload) {
      throw new Error("Stream ended without a result.");
    }
    return finalPayload;
  }

  function showIframeNotice() {
    modal.info({
      title: t.iframeBlocked,
      content: t.iframeWarning,
    });
  }

  return (
    <div
      className={`${styles.shell} ${
        mode === "dark" ? styles.darkShell : styles.lightShell
      }`}
    >
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <div className={styles.brandMark}>
              <ThunderboltOutlined />
            </div>
            <div>
              <h1 className={styles.brandTitle}>Wiki Speedrun</h1>
              <p className={styles.brandSubtitle}>{t.subtitle}</p>
            </div>
          </div>
          <div className={styles.headerTools}>
            <Dropdown
              menu={{
                selectable: true,
                selectedKeys: [locale],
                onClick: ({ key }) => setLocale(key as Locale),
                items: [
                  { key: "ko", label: "한국어" },
                  { key: "en", label: "English" },
                  { key: "ja", label: "日本語" },
                ],
              }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button
                aria-label={localeLabels[locale]}
                icon={<GlobalOutlined />}
                title={localeLabels[locale]}
              />
            </Dropdown>
            <Tooltip title={mode === "dark" ? "Light" : "Dark"}>
              <Button
                icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
                onClick={() =>
                  setMode((value) => (value === "dark" ? "light" : "dark"))
                }
              />
            </Tooltip>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={`${styles.panel} ${styles.controlPanel}`}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t.setup}</h2>
              <p className={styles.panelDescription}>{t.setupDesc}</p>
            </div>
            <ApiOutlined />
          </div>
          <div className={styles.panelBody}>
            <div className={styles.fieldStack}>
              <div>
                <span className={styles.fieldLabel}>{t.wiki}</span>
                <Select
                  value={siteKey}
                  onChange={setSiteKey}
                  options={presets.map((siteOption) => ({
                    label: siteOption.label,
                    value: siteOption.key,
                  }))}
                  style={{ width: "100%" }}
                />
              </div>

              {siteKey === "custom" ? (
                <>
                  <div>
                    <span className={styles.fieldLabel}>{t.engine}</span>
                    <Select
                      value={customEngine}
                      onChange={setCustomEngine}
                      options={engineOptions}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <span className={styles.fieldLabel}>{t.customBase}</span>
                    <Input
                      prefix={<GlobalOutlined />}
                      value={customBaseUrl}
                      onChange={(event) => setCustomBaseUrl(event.target.value)}
                      placeholder="https://example.org/wiki/"
                    />
                  </div>
                  <div>
                    <span className={styles.fieldLabel}>{t.customApi}</span>
                    <Input
                      prefix={<ApiOutlined />}
                      value={customApiEndpoint}
                      onChange={(event) =>
                        setCustomApiEndpoint(event.target.value)
                      }
                      placeholder="https://example.org/w/api.php"
                    />
                  </div>
                  <div>
                    <span className={styles.fieldLabel}>{t.apiToken}</span>
                    <Input.Password
                      prefix={<ApiOutlined />}
                      value={customApiToken}
                      onChange={(event) =>
                        setCustomApiToken(event.target.value)
                      }
                      placeholder="Bearer token"
                    />
                  </div>
                </>
              ) : (
                <>
                  <Alert
                    showIcon
                    type="success"
                    title={`${site.label} / ${site.engine}`}
                    description={connectionDescription}
                  />
                  {site.engine !== "mediawiki" ? (
                    <div>
                      <span className={styles.fieldLabel}>{t.apiToken}</span>
                      <Input.Password
                        prefix={<ApiOutlined />}
                        value={customApiToken}
                        onChange={(event) =>
                          setCustomApiToken(event.target.value)
                        }
                        placeholder={
                          site.engine === "the-seed"
                            ? "optional API token"
                            : "optional"
                        }
                      />
                    </div>
                  ) : null}
                </>
              )}

              <div className={styles.splitFields}>
                <div>
                  <span className={styles.fieldLabel}>{t.start}</span>
                  <Input
                    value={startTitle}
                    onChange={(event) => setStartTitle(event.target.value)}
                    placeholder={t.startPlaceholder}
                  />
                </div>
                <div>
                  <span className={styles.fieldLabel}>{t.target}</span>
                  <Input
                    value={targetTitle}
                    onChange={(event) => setTargetTitle(event.target.value)}
                    placeholder={t.targetPlaceholder}
                  />
                </div>
              </div>

              <Divider plain>{t.rules}</Divider>

              <div className={styles.optionGrid}>
                <div className={styles.optionRow}>
                  <span className={styles.optionText}>
                    {t.includeFootnotes}
                  </span>
                  <Switch
                    checked={includeFootnotes}
                    onChange={setIncludeFootnotes}
                  />
                </div>
                <div>
                  <span className={styles.fieldLabel}>{t.redirectMode}</span>
                  <Segmented
                    block
                    value={redirectMode}
                    onChange={(value) => setRedirectMode(value as RedirectMode)}
                    options={[
                      { label: t.autoRedirect, value: "auto" },
                      { label: t.countRedirect, value: "count" },
                    ]}
                  />
                </div>
                <div>
                  <span className={styles.fieldLabel}>
                    {t.namespaceFilters}
                  </span>
                  <Checkbox.Group
                    value={namespaceLabels
                      .filter((item) => namespacePolicy[item.key])
                      .map((item) => item.key)}
                    onChange={(values) => {
                      const allowed = new Set(values);
                      setNamespacePolicy({
                        file: allowed.has("file"),
                        category: allowed.has("category"),
                        template: allowed.has("template"),
                        user: allowed.has("user"),
                        talk: allowed.has("talk"),
                        special: allowed.has("special"),
                      });
                    }}
                    options={namespaceLabels.map((item) => ({
                      label: item.label,
                      value: item.key,
                    }))}
                  />
                </div>
                <div className={styles.optionRow}>
                  <span className={styles.optionText}>{t.requiredNth}</span>
                  <Switch
                    checked={requiredEnabled}
                    onChange={setRequiredEnabled}
                  />
                </div>
                {requiredEnabled ? (
                  <div className={styles.splitFields}>
                    <div>
                      <span className={styles.fieldLabel}>
                        {t.requiredPosition}
                      </span>
                      <InputNumber
                        min={2}
                        value={requiredPosition}
                        onChange={(value) =>
                          setRequiredPosition(Number(value ?? 2))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>
                    <div>
                      <span className={styles.fieldLabel}>
                        {t.requiredTitle}
                      </span>
                      <Input
                        value={requiredTitle}
                        onChange={(event) =>
                          setRequiredTitle(event.target.value)
                        }
                      />
                    </div>
                  </div>
                ) : null}
                <div className={styles.splitFields}>
                  <div>
                    <span className={styles.fieldLabel}>{t.maxDepth}</span>
                    <InputNumber
                      min={1}
                      max={8}
                      value={maxDepth}
                      onChange={(value) => setMaxDepth(Number(value ?? 4))}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <span className={styles.fieldLabel}>{t.maxNodes}</span>
                    <InputNumber
                      min={20}
                      max={1200}
                      step={20}
                      value={maxNodes}
                      onChange={(value) => setMaxNodes(Number(value ?? 140))}
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
              </div>

              <Button
                className={styles.runButton}
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                loading={loading}
                onClick={runSearch}
              >
                {loading ? t.running : t.run}
              </Button>
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t.result}</h2>
              <p className={styles.panelDescription}>{t.resultDesc}</p>
            </div>
            <Space>
              <Segmented
                value={viewMode}
                onChange={(value) => setViewMode(value as ViewMode)}
                options={[
                  { label: t.iframe, value: "iframe" },
                  { label: t.compact, value: "compact" },
                ]}
              />
              <Tooltip title={t.iframeWarning}>
                <Button icon={<WarningOutlined />} onClick={showIframeNotice} />
              </Tooltip>
            </Space>
          </div>
          <div className={styles.panelBody}>
            {loading ? (
              <div className={styles.progressPanel}>
                <div className={styles.progressHeader}>
                  <div>
                    <div className={styles.progressTitle}>{t.progress}</div>
                    <div className={styles.progressMessage}>
                      {progress.message}
                    </div>
                  </div>
                  <Tag color="blue">{progress.stage}</Tag>
                </div>
                <Progress
                  percent={progress.percent}
                  status="active"
                  strokeColor={{ from: "#2563eb", to: "#16a34a" }}
                />
                <div className={styles.progressStats}>
                  <span>
                    {t.expanded}: {progress.expanded ?? 0}
                  </span>
                  <span>
                    {t.queue}: {progress.queued ?? 0}
                  </span>
                  <span>
                    {t.depth}: {progress.depth ?? 0}
                  </span>
                </div>
                <div className={styles.progressLog}>
                  {progressLog.map((item) => (
                    <div key={item.id} className={styles.logLine}>
                      {item.text}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {failure ? (
              <Alert
                showIcon
                type="error"
                title={`${t.errorCode}: ${failure.error.code}`}
                description={failure.error.message}
                style={{ marginBottom: 14 }}
              />
            ) : null}

            {success ? (
              <>
                <div className={styles.statusStrip}>
                  <Metric
                    icon={<ThunderboltOutlined />}
                    label={t.clicks}
                    value={success.clicks}
                  />
                  <Metric
                    icon={<FileSearchOutlined />}
                    label={t.expanded}
                    value={success.expanded}
                  />
                  <Metric
                    icon={<LinkOutlined />}
                    label={t.outLinks}
                    value={success.checks.startOutLinks}
                  />
                  <Metric
                    icon={<ApartmentOutlined />}
                    label={t.backlinks}
                    value={success.checks.targetBacklinks ?? "best effort"}
                  />
                </div>

                <Alert
                  showIcon
                  type="success"
                  icon={<CheckCircleOutlined />}
                  title={`${success.start.title} → ${success.target.title}`}
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text type="secondary">
                        {t.endpoint}: {success.endpoint}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t.backlinkMode}: {success.backlinkMode}
                      </Typography.Text>
                      {success.required ? (
                        <Typography.Text type="secondary">
                          {t.requiredNth}: {success.required.title}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                  style={{ marginBottom: 14 }}
                />

                <div className={styles.pathCanvas}>
                  <div className={styles.pathRail}>
                    {success.path.map((node, index) => (
                      <div
                        key={`${node.id}-${index}`}
                        className={styles.pathRail}
                      >
                        {index > 0 ? (
                          <div className={styles.pathArrow}>→</div>
                        ) : null}
                        <button
                          type="button"
                          className={`${styles.pathNode} ${
                            index === activeIndex ? styles.pathNodeActive : ""
                          }`}
                          onClick={() => setActiveIndex(index)}
                        >
                          <span className={styles.nodeIndex}>
                            #{index + 1}{" "}
                            {node.kind === "redirect" ? "redirect" : "page"}
                          </span>
                          <span className={styles.nodeTitle}>{node.title}</span>
                          {node.redirectedFrom ? (
                            <span className={styles.nodeMeta}>
                              via {node.redirectedFrom}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {viewMode === "iframe" ? (
                  <>
                    <Alert
                      showIcon
                      type="info"
                      title={t.iframeWarning}
                      style={{ marginTop: 14 }}
                    />
                    <div className={styles.viewerShell}>
                      <div className={styles.stepList}>
                        {success.path.map((node, index) => (
                          <button
                            key={`${node.id}-button-${index}`}
                            type="button"
                            className={`${styles.stepButton} ${
                              index === activeIndex
                                ? styles.stepButtonActive
                                : ""
                            }`}
                            onClick={() => setActiveIndex(index)}
                          >
                            <div className={styles.stepButtonTitle}>
                              #{index + 1} {node.title}
                            </div>
                            <div className={styles.stepButtonUrl}>
                              {node.url}
                            </div>
                          </button>
                        ))}
                      </div>
                      <div className={styles.iframeWrap}>
                        {activeNode ? (
                          <iframe
                            key={activeNode.url}
                            className={styles.iframe}
                            src={activeNode.url}
                            title={activeNode.title}
                            onError={showIframeNotice}
                          />
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className={styles.compactUrls}>
                    {success.path.map((node, index) => (
                      <a
                        key={`${node.id}-url-${index}`}
                        className={styles.urlRow}
                        href={node.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className={styles.urlIndex}>#{index + 1}</span>
                        <span className={styles.urlText}>{node.url}</span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.emptyState}>
                <div>
                  <NodeIndexOutlined style={{ fontSize: 42 }} />
                  <div className={styles.emptyTitle}>{t.emptyTitle}</div>
                  <div className={styles.emptyCopy}>{t.emptyCopy}</div>
                  <Space wrap style={{ marginTop: 16 }}>
                    <Tag icon={<BulbOutlined />} color="blue">
                      START_NOT_FOUND
                    </Tag>
                    <Tag color="cyan">SAME_DOCUMENT</Tag>
                    <Tag color="gold">PATH_NOT_FOUND</Tag>
                    <Tag color="red">SITE_RATE_LIMITED</Tag>
                  </Space>
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={false}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>
        <Space size={6}>
          {icon}
          {label}
        </Space>
      </div>
      <div className={styles.metricValue}>{value}</div>
    </div>
  );
}

function describeSiteConnection(site: PresetSite & { apiToken?: string }) {
  if (site.engine === "the-seed" && !site.apiToken?.trim()) {
    return `${site.baseUrl} · public HTML fallback`;
  }
  if (site.apiEndpoint) {
    return `${site.apiEndpoint} · API preferred`;
  }
  return `${site.baseUrl} · RAW/HTML fallback`;
}

function readLocalSettings() {
  if (typeof window === "undefined") {
    return defaultLocalSettings;
  }

  try {
    const raw = window.localStorage.getItem(localSettingsKey);
    if (!raw) {
      return defaultLocalSettings;
    }
    return sanitizeLocalSettings(JSON.parse(raw));
  } catch {
    return defaultLocalSettings;
  }
}

function writeLocalSettings(settings: LocalSettings) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      localSettingsKey,
      JSON.stringify(sanitizeLocalSettings(settings)),
    );
  } catch {
    // Ignore private-mode or quota failures; settings persistence is optional.
  }
}

function sanitizeLocalSettings(value: unknown): LocalSettings {
  if (!value || typeof value !== "object") {
    return defaultLocalSettings;
  }

  const candidate = value as Partial<LocalSettings>;
  const locale = isLocale(candidate.locale)
    ? candidate.locale
    : defaultLocalSettings.locale;
  const mode = isColorMode(candidate.mode)
    ? candidate.mode
    : defaultLocalSettings.mode;
  const siteKey =
    typeof candidate.siteKey === "string" &&
    presets.some((site) => site.key === candidate.siteKey)
      ? candidate.siteKey
      : defaultLocalSettings.siteKey;
  const customEngine = isWikiEngine(candidate.customEngine)
    ? candidate.customEngine
    : defaultLocalSettings.customEngine;
  const redirectMode = isRedirectMode(candidate.redirectMode)
    ? candidate.redirectMode
    : defaultLocalSettings.redirectMode;
  const viewMode = isViewMode(candidate.viewMode)
    ? candidate.viewMode
    : defaultLocalSettings.viewMode;

  return {
    locale,
    mode,
    siteKey,
    customBaseUrl: stringOrDefault(
      candidate.customBaseUrl,
      defaultLocalSettings.customBaseUrl,
    ),
    customApiEndpoint: stringOrDefault(
      candidate.customApiEndpoint,
      defaultLocalSettings.customApiEndpoint,
    ),
    customEngine,
    startTitle: stringOrDefault(
      candidate.startTitle,
      defaultLocalSettings.startTitle,
    ),
    targetTitle: stringOrDefault(
      candidate.targetTitle,
      defaultLocalSettings.targetTitle,
    ),
    includeFootnotes:
      typeof candidate.includeFootnotes === "boolean"
        ? candidate.includeFootnotes
        : defaultLocalSettings.includeFootnotes,
    redirectMode,
    namespacePolicy: sanitizeNamespacePolicy(candidate.namespacePolicy),
    requiredEnabled:
      typeof candidate.requiredEnabled === "boolean"
        ? candidate.requiredEnabled
        : defaultLocalSettings.requiredEnabled,
    requiredPosition: numberOrDefault(
      candidate.requiredPosition,
      defaultLocalSettings.requiredPosition,
      2,
      12,
    ),
    requiredTitle: stringOrDefault(
      candidate.requiredTitle,
      defaultLocalSettings.requiredTitle,
    ),
    maxDepth: numberOrDefault(
      candidate.maxDepth,
      defaultLocalSettings.maxDepth,
      1,
      8,
    ),
    maxNodes: numberOrDefault(
      candidate.maxNodes,
      defaultLocalSettings.maxNodes,
      20,
      1200,
    ),
    viewMode,
  };
}

function sanitizeNamespacePolicy(value: unknown): NamespacePolicy {
  if (!value || typeof value !== "object") {
    return defaultNamespacePolicy;
  }
  const candidate = value as Partial<NamespacePolicy>;
  return {
    file: Boolean(candidate.file),
    category: Boolean(candidate.category),
    template: Boolean(candidate.template),
    user: Boolean(candidate.user),
    talk: Boolean(candidate.talk),
    special: Boolean(candidate.special),
  };
}

function isLocale(value: unknown): value is Locale {
  return value === "ko" || value === "en" || value === "ja";
}

function isColorMode(value: unknown): value is ColorMode {
  return value === "light" || value === "dark";
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

function isRedirectMode(value: unknown): value is RedirectMode {
  return value === "auto" || value === "count";
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "iframe" || value === "compact";
}

function stringOrDefault(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function numberOrDefault(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
