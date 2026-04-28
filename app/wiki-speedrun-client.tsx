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
import { useMemo, useState } from "react";
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
  },
  {
    key: "opennamu-onts",
    label: "openNAMU ONTS",
    engine: "opennamu",
    baseUrl: "https://openna.mu.io.kr/w/",
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
    customApi: "MediaWiki API URL",
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
      "MediaWiki는 API로, the seed/openNAMU/DokuWiki/MoniWiki는 HTML 링크 추출로 탐색합니다. 큰 위키에서는 최대 탐색 문서를 낮게 시작하는 편이 좋습니다.",
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
  },
  en: {
    subtitle:
      "Wiki route finder with normalization, redirects, and valid-link filters",
    setup: "Game Setup",
    setupDesc: "Choose documents, wiki engine, and route rules.",
    wiki: "Wiki site",
    customBase: "Custom site URL",
    customApi: "MediaWiki API URL",
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
      "MediaWiki uses its API; the seed/openNAMU/DokuWiki/MoniWiki use HTML link extraction. Start with a lower page limit on large wikis.",
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
  },
  ja: {
    subtitle: "正規化、リダイレクト、有効リンク判定を含むWiki経路探索",
    setup: "ゲーム設定",
    setupDesc: "文書、Wikiエンジン、探索ルールを選びます。",
    wiki: "Wikiサイト",
    customBase: "カスタムサイトURL",
    customApi: "MediaWiki API URL",
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
      "MediaWikiはAPI、the seed/openNAMU/DokuWiki/MoniWikiはHTMLリンク抽出で探索します。大きなWikiでは探索上限を低めにしてください。",
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

export default function WikiSpeedrunClient() {
  const [mode, setMode] = useState<ColorMode>("light");

  return (
    <ConfigProvider
      theme={{
        algorithm:
          mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          borderRadius: 8,
          colorPrimary: "#2563eb",
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
  const [locale, setLocale] = useState<Locale>("ko");
  const [siteKey, setSiteKey] = useState("ko-wikipedia");
  const selectedPreset =
    presets.find((site) => site.key === siteKey) ?? presets[0];
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiEndpoint, setCustomApiEndpoint] = useState("");
  const [customEngine, setCustomEngine] = useState<WikiEngine>("mediawiki");
  const [startTitle, setStartTitle] = useState("대한민국");
  const [targetTitle, setTargetTitle] = useState("철학");
  const [includeFootnotes, setIncludeFootnotes] = useState(false);
  const [redirectMode, setRedirectMode] = useState<RedirectMode>("auto");
  const [namespacePolicy, setNamespacePolicy] = useState<NamespacePolicy>({
    file: false,
    category: false,
    template: false,
    user: false,
    talk: false,
    special: false,
  });
  const [requiredEnabled, setRequiredEnabled] = useState(false);
  const [requiredPosition, setRequiredPosition] = useState(2);
  const [requiredTitle, setRequiredTitle] = useState("");
  const [maxDepth, setMaxDepth] = useState(4);
  const [maxNodes, setMaxNodes] = useState(140);
  const [viewMode, setViewMode] = useState<ViewMode>("iframe");
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SpeedrunResponse | null>(null);
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
      };
    }
    return selectedPreset;
  }, [customApiEndpoint, customBaseUrl, customEngine, selectedPreset, siteKey]);

  const success = result?.ok ? result : null;
  const failure = result && !result.ok ? result : null;
  const activeNode = success?.path[activeIndex] ?? success?.path[0];

  async function runSearch() {
    setLoading(true);
    setResult(null);
    setActiveIndex(0);

    try {
      const response = await fetch("/api/speedrun", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine: site.engine,
          baseUrl: site.baseUrl,
          apiEndpoint: site.apiEndpoint || undefined,
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
        }),
      });
      const payload = (await response.json()) as SpeedrunResponse;
      setResult(payload);
      if (payload.ok) {
        message.success(`${t.success}: ${payload.clicks}`);
      } else {
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

  function showIframeNotice() {
    modal.info({
      title: t.iframeBlocked,
      content: t.iframeWarning,
    });
  }

  return (
    <div className={styles.shell}>
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
            <Segmented
              value={locale}
              onChange={(value) => setLocale(value as Locale)}
              options={[
                { label: "KO", value: "ko" },
                { label: "EN", value: "en" },
                { label: "JA", value: "ja" },
              ]}
            />
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
                </>
              ) : (
                <Alert
                  showIcon
                  type="success"
                  title={`${site.label} / ${site.engine}`}
                  description={
                    site.engine === "mediawiki"
                      ? site.baseUrl
                      : `${site.baseUrl} · HTML adapter`
                  }
                />
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
              <Progress percent={65} status="active" showInfo={false} />
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
