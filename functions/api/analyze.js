const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_ARTICLE_TIMEOUT_MS = 20000;
const DEFAULT_MODEL_TIMEOUT_MS = 65000;
const DEFAULT_SUPPLEMENTAL_TIMEOUT_MS = 12000;
const DEFAULT_SUPPLEMENTAL_MAX_PAGES = 5;
const DEFAULT_PUBLISHER_SEARCH_TIMEOUT_MS = 10000;
const DEFAULT_PUBLISHER_SEARCH_MAX_PAGES = 6;

export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  let trace = createTrace(false);

  try {
    const { request, env } = context;
    const body = await request.json().catch(() => ({}));
    const debugEnabled = Boolean(body.debug) || env.DEBUG_ANALYZE === "1";
    trace = createTrace(debugEnabled);
    trace.mark("request_received");

    const articleUrl = (body.url || "").trim();
    const language = normalizeLanguage(body.lang || body.language);
    if (!isLikelyHttpUrl(articleUrl)) {
      return json({ error: "Invalid URL. Use a full http(s) URL." }, 400, corsHeaders);
    }

    const providerConfig = resolveModelProvider(env);
    if (!providerConfig.apiKey) {
      return json(
        {
          error:
            "Missing OPENAI_API_KEY (or AI_API_KEY) in Cloudflare environment variables."
        },
        500,
        corsHeaders
      );
    }

    trace.mark("provider_resolved", {
      base_url: providerConfig.baseUrl,
      model: providerConfig.model
    });

    const article = await fetchArticle(articleUrl, trace, env);
    const analysis = await analyzeWithModel(article, providerConfig, trace, env, language);

    trace.mark("analysis_complete", {
      author_detected: article.author !== "Unknown author"
    });

    const payload = { article, analysis };
    if (debugEnabled) {
      payload.debug = trace.finish({
        article_chars: article.text_excerpt.length,
        author_source: article.author_source,
        analysis_subject: article.author,
        extracted_author: article.extracted_author,
        extracted_author_source: article.extracted_author_source,
        supplemental_checked_urls: article.supplemental_context?.checked_urls || [],
        supplemental_usable_pages: article.supplemental_context?.chunks?.length || 0,
        text_source: article.text_source || "unknown",
        publisher_search_triggered: article.publisher_search_context?.triggered || false,
        publisher_search_checked_urls: article.publisher_search_context?.checked_urls || [],
        publisher_search_usable_pages: article.publisher_search_context?.chunks?.length || 0,
        language,
        model: providerConfig.model,
        base_url: providerConfig.baseUrl
      });
    }

    return json(payload, 200, corsHeaders);
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = {
      error: normalized.userMessage
    };

    if (trace.enabled) {
      payload.debug = trace.finish({
        error_code: normalized.code,
        error_detail: normalized.devMessage,
        upstream_status: normalized.upstreamStatus || null
      });
    }

    return json(payload, normalized.status, corsHeaders);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

async function fetchArticle(url, trace, env) {
  trace.mark("article_fetch_started", { url });

  const timeoutMs = parseTimeout(env.ARTICLE_FETCH_TIMEOUT_MS, DEFAULT_ARTICLE_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "truth-check-bot/0.1"
      }
    },
    timeoutMs,
    "Article fetch"
  );

  if (!response.ok) {
    throw appError(
      502,
      `Unable to fetch article (${response.status}).`,
      "ARTICLE_FETCH_FAILED",
      `Article source returned HTTP ${response.status}`,
      response.status
    );
  }

  const html = await response.text();
  const title = getFirstMatch(html, [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ]);
  const publisherName = getFirstMatch(html, [
    /<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i,
    /<meta\s+name=["']application-name["']\s+content=["']([^"']+)["']/i
  ]);

  const authorResult = extractAuthor(html);
  const subjectResult = resolveAnalysisSubject(title || "", authorResult);
  const author = subjectResult.name;

  const articleTextResult = extractPrimaryArticleText(html);
  const articleText = articleTextResult.text.slice(0, 12000);

  if (!articleText || articleText.length < 400) {
    throw appError(
      422,
      "Could not extract enough article text for analysis. The page may be paywalled or script-rendered.",
      "ARTICLE_TEXT_TOO_SHORT",
      `Extracted ${articleText.length} chars from article text`
    );
  }

  const supplementalContext = await gatherSupplementalContext(url, html, author, trace, env);
  const baseContextText = [articleText, buildSupplementalContextForPrompt({ supplemental_context: supplementalContext })].join("\n\n");
  const publisherSearchContext = hasLeadEditorSignal(baseContextText)
    ? { triggered: false, checked_urls: [], chunks: [] }
    : await gatherPublisherSearchContext(url, trace, env);
  trace.mark("article_parsed", {
    html_chars: html.length,
    text_chars: articleText.length,
    text_source: articleTextResult.source,
    author_detected: author !== "Unknown author",
    author_source: subjectResult.source,
    extracted_author: authorResult.name,
    extracted_author_source: authorResult.source,
    supplemental_pages_checked: supplementalContext.checked_urls.length,
    supplemental_pages_usable: supplementalContext.chunks.length,
    publisher_search_triggered: publisherSearchContext.triggered,
    publisher_search_pages_checked: publisherSearchContext.checked_urls.length,
    publisher_search_pages_usable: publisherSearchContext.chunks.length
  });

  return {
    url,
    title: title || "Unknown title",
    publisher_name: publisherName || "Unknown publisher",
    author: author || "Unknown author",
    author_source: subjectResult.source,
    extracted_author: authorResult.name,
    extracted_author_source: authorResult.source,
    text_excerpt: articleText,
    text_source: articleTextResult.source,
    supplemental_context: supplementalContext,
    publisher_search_context: publisherSearchContext
  };
}

async function analyzeWithModel(article, providerConfig, trace, env, language) {
  const authorStep = await analyzeAuthorStep(article, providerConfig, trace, env, language);
  const publisherName =
    authorStep?.publisher_name_guess ||
    authorStep?.publisher_name ||
    article.publisher_name ||
    "Unknown publisher";
  const publisherStep = await analyzePublisherStep(
    article,
    publisherName,
    providerConfig,
    trace,
    env,
    language
  );

  return mergeAuthorPublisherAnalysis(authorStep, publisherStep);
}

async function analyzeAuthorStep(article, providerConfig, trace, env, language) {
  const supplementalContextText = buildSupplementalContextForPrompt(article);
  const languageName = language === "de" ? "German" : "English";
  const languageRule =
    language === "de"
      ? "Write ALL natural-language fields in German. Do not use English except when quoting the article."
      : "Write ALL natural-language fields in English.";

  const prompt = `You are an investigative analyst.
Task: assess author background and motivations for a specific article.

Article title: ${article.title}
Publisher (from metadata): ${article.publisher_name || "Unknown publisher"}
Author: ${article.author}
Article URL: ${article.url}
Article excerpt:\n${article.text_excerpt}
\nSupplemental context from publisher/author pages:\n${supplementalContextText}
Output language: ${languageName}. All natural-language fields must be written in ${languageName}.

Instructions:
- ${languageRule}
- Analyze the exact Author above as the primary subject throughout the output.
- Do not switch the primary subject to another person/entity even if other names appear.
- Identify the publisher name as best you can from the article metadata or context.
- You may and should use public background research beyond the article when it helps, including Wikipedia, reliable independent journalism, public biographies, official organization pages, and other credible public sources.
- Query multiple independent sources whenever possible instead of relying on a single source.
- Prefer independent sources over self-descriptions when researching the author; if you rely mainly on self-published bios or publisher pages, state that clearly.
- You may list multiple supporting source URLs for the user in the relevant "source_urls" fields.
- Focus on motivations that might impact honesty: affiliations, current/previous employers, funding incentives, political incentives, reputational pressure, legal pressure, fear, or career incentives.
- If evidence is weak, state uncertainty clearly.
- Avoid definitive accusations.
- For each motivation, include a short "evidence_hint" that explains the basis (e.g., article wording pattern, publication framing, known role history, or explicit uncertainty).
- Extract 4-8 key claim sentences from the article excerpt and connect each to a caveat. Keep claim_sentence text in the original article language.

Return STRICT JSON only with this schema:
{
  "publisher_name_guess": "string or Unknown",
  "author_profile": "short paragraph",
  "author_profile_source_urls": ["string URL"],
  "background_checks": {
    "author_affiliations": [
      {
        "name": "string",
        "relationship": "current|former|unknown",
        "evidence_hint": "string",
        "source_urls": ["string URL"]
      }
    ],
    "author_country_of_residence": {
      "country": "string or Unknown",
      "evidence_hint": "string",
      "source_urls": ["string URL"]
    }
  },
  "motivations": [
    {
      "factor": "string",
      "impact": "string",
      "evidence_hint": "string",
      "source_urls": ["string URL"]
    }
  ],
  "key_claim_checks": [
    {
      "claim_sentence": "string",
      "potential_motivation_link": "string",
      "caveat": "string",
      "source_urls": ["string URL"]
    }
  ]
}`;

  return runModelRequest(providerConfig, trace, env, prompt, "author_step");
}

async function analyzePublisherStep(article, publisherName, providerConfig, trace, env, language) {
  const publisherSearchContextText = buildPublisherSearchContextForPrompt(article);
  const supplementalContextText = buildSupplementalContextForPrompt(article);
  const languageName = language === "de" ? "German" : "English";
  const languageRule =
    language === "de"
      ? "Write ALL natural-language fields in German. Do not use English except when quoting the article."
      : "Write ALL natural-language fields in English.";

  const prompt = `You are an investigative analyst.
Task: assess publisher background, leadership, and funding/ownership signals.

Publisher: ${publisherName}
Article URL: ${article.url}
Publisher-focused search context (used when editor/redactor is unclear):\n${publisherSearchContextText}
\nSupplemental context from publisher/author pages:\n${supplementalContextText}
Output language: ${languageName}. All natural-language fields must be written in ${languageName}.

Instructions:
- ${languageRule}
- Identify publisher lead editor/redactor if possible; otherwise state uncertainty explicitly.
- Identify funding or ownership signals (owners, parent companies, foundations, major sponsors, known funding bodies). If unclear, say so.
- If you can identify a likely owner or parent organization, investigate that owner as well and summarize why that ownership may matter. If no owner can be identified with reasonable confidence, state that clearly.
- You may and should use public background research beyond the publisher site when it helps, including Wikipedia, reliable independent journalism, public records, official organization pages, and other credible public sources.
- Query multiple independent sources whenever possible instead of relying on a single source.
- Use short evidence hints.
- You may list multiple supporting source URLs for the user in the relevant "source_urls" fields.
- Treat publisher self-descriptions as potentially biased. Prefer independent sources (e.g., Wikipedia, independent journalism) when available, and explicitly highlight where independent sources differ from publisher claims. If only publisher sources are available, state this clearly.

Return STRICT JSON only with this schema:
{
  "publisher_profile": "short paragraph",
  "publisher_profile_source_urls": ["string URL"],
  "publisher_owner_investigation": {
    "name": "string or Unknown",
    "relationship": "owner|parent_company|foundation|major_shareholder|unknown",
    "summary": "short paragraph",
    "evidence_hint": "string",
    "source_urls": ["string URL"]
  },
  "publisher_funding_sources": [
    {
      "name": "string",
      "evidence_hint": "string",
      "source_urls": ["string URL"]
    }
  ],
  "publisher_lead_editor_or_redactor": {
    "name": "string or Unknown",
    "role": "string",
    "evidence_hint": "string",
    "source_urls": ["string URL"]
  }
}`;

  return runModelRequest(providerConfig, trace, env, prompt, "publisher_step");
}

function mergeAuthorPublisherAnalysis(authorStep, publisherStep) {
  const authorBackground = authorStep?.background_checks || {};
  const mergedBackground = {
    ...authorBackground,
    publisher_lead_editor_or_redactor:
      publisherStep?.publisher_lead_editor_or_redactor || {
        name: "Unknown",
        role: "unknown",
        evidence_hint: "No details.",
        source_urls: []
      },
    publisher_owner_investigation: publisherStep?.publisher_owner_investigation || {
      name: "Unknown",
      relationship: "unknown",
      summary: "",
      evidence_hint: "No details.",
      source_urls: []
    },
    publisher_funding_sources: publisherStep?.publisher_funding_sources || []
  };

  return {
    author_profile: authorStep?.author_profile || "No profile generated by the model.",
    author_profile_source_urls:
      normalizeSourceUrls(authorStep?.author_profile_source_urls || authorStep?.author_profile_evidence_url),
    publisher_profile: publisherStep?.publisher_profile || "",
    publisher_profile_source_urls:
      normalizeSourceUrls(
        publisherStep?.publisher_profile_source_urls || publisherStep?.publisher_profile_evidence_url
      ),
    background_checks: mergedBackground,
    motivations: authorStep?.motivations || [],
    key_claim_checks: authorStep?.key_claim_checks || []
  };
}

function normalizeSourceUrls(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

async function runModelRequest(providerConfig, trace, env, prompt, label) {
  const systemPrompt =
    "You produce cautious, evidence-aware analysis as strict JSON. No markdown, no extra keys.";

  trace.mark("model_request_started", {
    base_url: providerConfig.baseUrl,
    model: providerConfig.model,
    stage: label
  });

  const timeoutMs = parseTimeout(env.AI_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    providerConfig.baseUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerConfig.apiKey}`,
        "User-Agent": providerConfig.userAgent
      },
      body: JSON.stringify({
        model: providerConfig.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      })
    },
    timeoutMs,
    "Model request"
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw buildModelApiError(
      response.status,
      response.headers.get("content-type") || "",
      responseText
    );
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw appError(
      502,
      "Model provider returned non-JSON data. Try again in a moment.",
      "MODEL_RESPONSE_NOT_JSON",
      `Non-JSON model response: ${safeSnippet(responseText)}`
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw appError(
      502,
      "Model provider returned no usable output.",
      "MODEL_RESPONSE_EMPTY",
      "choices[0].message.content missing"
    );
  }

  let parsed;
  try {
    parsed = parseJsonFromModel(content);
  } catch (error) {
    throw appError(
      502,
      "Model output format was invalid. Try running again.",
      "MODEL_OUTPUT_INVALID_JSON",
      error instanceof Error ? error.message : "Unknown parsing failure"
    );
  }

  trace.mark("model_response_parsed", {
    provider_response_chars: responseText.length,
    stage: label
  });

  return parsed;
}

function resolveModelProvider(env) {
  return {
    apiKey: env.OPENAI_API_KEY || env.AI_API_KEY || env.APERTUS_API_KEY || "",
    baseUrl:
      env.OPENAI_API_BASE_URL ||
      env.AI_API_BASE_URL ||
      env.APERTUS_API_BASE_URL ||
      DEFAULT_OPENAI_URL,
    model: env.OPENAI_MODEL || env.AI_MODEL || env.APERTUS_MODEL || "gpt-4.1-mini",
    userAgent: env.OPENAI_USER_AGENT || env.AI_USER_AGENT || env.APERTUS_USER_AGENT || "truth-check/0.1"
  };
}

function createTrace(enabled) {
  const startedAt = Date.now();
  const events = [];

  return {
    enabled,
    mark(stage, details = {}) {
      if (!enabled) return;
      events.push({
        t_ms: Date.now() - startedAt,
        stage,
        details
      });
    },
    finish(extra = {}) {
      if (!enabled) return undefined;
      return {
        total_ms: Date.now() - startedAt,
        events,
        extra
      };
    }
  };
}

function parseTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  })
    .catch((error) => {
      if (error?.name === "AbortError") {
        throw appError(
          504,
          `${label} timed out after ${Math.round(timeoutMs / 1000)}s. Please retry.`,
          "REQUEST_TIMEOUT",
          `${label} exceeded timeout of ${timeoutMs}ms`
        );
      }
      throw buildNetworkFetchError(label, url, error);
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

function buildNetworkFetchError(label, url, error) {
  const isModelCall = label.toLowerCase().includes("model");
  const hostname = safeHostname(url);

  if (isModelCall) {
    return appError(
      502,
      "Could not reach the AI provider network endpoint. Please retry in a moment.",
      "MODEL_NETWORK_ERROR",
      `${label} network failure for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return appError(
    502,
    `Could not load source page${hostname ? ` (${hostname})` : ""}. The site may block automated requests or require browser JS/cookies.`,
    "SOURCE_NETWORK_ERROR",
    `${label} network failure for ${url}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function buildModelApiError(status, contentType, rawBody) {
  const bodySnippet = safeSnippet(rawBody);

  if (status === 504) {
    return appError(
      504,
      "AI provider timed out (HTTP 504). This usually means provider overload. Retry in 30-60 seconds.",
      "MODEL_UPSTREAM_TIMEOUT",
      `Model upstream timeout. Content-Type=${contentType}; body=${bodySnippet}`,
      504
    );
  }

  if (status === 429) {
    return appError(
      429,
      "AI provider rate-limited this request (HTTP 429). Please retry shortly.",
      "MODEL_RATE_LIMIT",
      `Model rate limit. Content-Type=${contentType}; body=${bodySnippet}`,
      429
    );
  }

  if (status >= 500) {
    return appError(
      502,
      `AI provider is currently unavailable (HTTP ${status}). Please retry.`,
      "MODEL_UPSTREAM_5XX",
      `Model upstream error ${status}. Content-Type=${contentType}; body=${bodySnippet}`,
      status
    );
  }

  return appError(
    502,
    `Model API error (HTTP ${status}). Check provider credentials/model settings.`,
    "MODEL_API_ERROR",
    `Model API error ${status}. Content-Type=${contentType}; body=${bodySnippet}`,
    status
  );
}

function appError(status, userMessage, code, devMessage, upstreamStatus) {
  const error = new Error(userMessage);
  error.isAppError = true;
  error.status = status;
  error.userMessage = userMessage;
  error.code = code;
  error.devMessage = devMessage;
  error.upstreamStatus = upstreamStatus;
  return error;
}

function normalizeError(error) {
  if (error?.isAppError) {
    return {
      status: error.status || 500,
      userMessage: error.userMessage || "Unexpected server error.",
      code: error.code || "APP_ERROR",
      devMessage: error.devMessage || "",
      upstreamStatus: error.upstreamStatus || null
    };
  }

  return {
    status: 500,
    userMessage: error instanceof Error ? error.message : "Unexpected server error.",
    code: "UNEXPECTED_ERROR",
    devMessage: error instanceof Error ? error.stack || error.message : String(error),
    upstreamStatus: null
  };
}

function safeSnippet(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function sanitizeAuthor(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown author";

  const collapsed = raw
    .replace(/\s+/g, " ")
    .replace(/^(?:by|written by|author)\s*:?\s+/i, "")
    .split(/\s+\|\s+|\s+-\s+|\s+\/\s+/)[0]
    .trim();
  const lowered = collapsed.toLowerCase();
  if (["now", "today", "opinion", "staff", "admin", "team", "editor"].includes(lowered)) {
    return "Unknown author";
  }

  // Avoid fragments like section names or timestamps posing as a name.
  if (collapsed.length < 3 || collapsed.length > 80 || /\d/.test(collapsed)) {
    return "Unknown author";
  }

  return collapsed;
}

function resolveAnalysisSubject(title, authorResult) {
  const interviewSubject = extractInterviewSubjectFromTitle(title);
  if (interviewSubject !== "Unknown author") {
    return { name: interviewSubject, source: "interview_title" };
  }
  return { name: authorResult.name, source: authorResult.source };
}

function extractInterviewSubjectFromTitle(title) {
  const text = String(title || "").trim();
  if (!text) return "Unknown author";

  const match = text.match(/^(.*?)\binterview\b/i);
  if (!match?.[1]) return "Unknown author";

  const candidate = match[1]
    .replace(/\s+/g, " ")
    .replace(/[|:,\-–—]+$/g, "")
    .trim();

  if (!candidate) return "Unknown author";
  if (candidate.split(/\s+/).length > 5) return "Unknown author";

  return sanitizeAuthor(candidate);
}

function extractAuthor(html) {
  const candidates = [];

  // Common meta author forms across publishers.
  candidates.push({
    source: "meta",
    value: getFirstMatch(html, [
      /<meta\s+name=["']author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\s+content=["']([^"']+)["'][^>]*name=["']author["'][^>]*>/i,
      /<meta\s+property=["']article:author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\s+content=["']([^"']+)["'][^>]*property=["']article:author["'][^>]*>/i
    ])
  });

  // Structured metadata is often more reliable than visible byline text.
  for (const value of extractAuthorsFromJsonLd(html)) {
    candidates.push({ source: "jsonld", value });
  }

  // Visible byline fallback.
  candidates.push({
    source: "byline",
    value: getFirstMatch(html, [
      /\b(?:by|written by|author)\s*:?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){0,4})\b/i
    ])
  });

  for (const candidate of candidates) {
    const cleaned = sanitizeAuthor(candidate.value);
    if (cleaned !== "Unknown author") {
      return { name: cleaned, source: candidate.source };
    }
  }

  return { name: "Unknown author", source: "unknown" };
}

async function gatherSupplementalContext(articleUrl, articleHtml, author, trace, env) {
  const maxPages = Math.max(
    1,
    Math.floor(parseTimeout(env.SUPPLEMENTAL_MAX_PAGES, DEFAULT_SUPPLEMENTAL_MAX_PAGES))
  );
  const timeoutMs = parseTimeout(env.SUPPLEMENTAL_TIMEOUT_MS, DEFAULT_SUPPLEMENTAL_TIMEOUT_MS);
  const origin = new URL(articleUrl).origin;

  const candidates = new Set();
  for (const path of [
    "/about",
    "/about-us",
    "/masthead",
    "/staff",
    "/team",
    "/editorial",
    "/imprint"
  ]) {
    candidates.add(`${origin}${path}`);
  }

  for (const link of extractAuthorProfileLinks(articleHtml, articleUrl, author)) {
    candidates.add(link);
  }

  const targets = [...candidates].slice(0, maxPages);
  const results = await Promise.allSettled(
    targets.map((target) =>
      fetchWithTimeout(
        target,
        {
          headers: {
            "User-Agent": "truth-check-bot/0.1"
          }
        },
        timeoutMs,
        "Supplemental fetch"
      )
    )
  );

  const chunks = [];
  for (let i = 0; i < results.length; i += 1) {
    const res = results[i];
    const url = targets[i];
    if (res.status !== "fulfilled") continue;
    if (!res.value.ok) continue;
    if (!isHtmlResponse(res.value)) continue;
    if (!isSameOrigin(res.value.url, origin)) continue;

    const html = await res.value.text().catch(() => "");
    const backgroundCheck = runBackgroundCheck(url, html);
    if (!backgroundCheck.ok) continue;

    const text = extractReadableText(html).slice(0, 2500);
    if (text.length < 250) continue;

    const pathLabel = new URL(url).pathname || "/";
    chunks.push({
      url,
      label: pathLabel,
      text_excerpt: text
    });
  }

  trace.mark("supplemental_context_collected", {
    checked: targets.length,
    usable: chunks.length,
    urls: targets
  });

  return { checked_urls: targets, chunks };
}

function extractAuthorProfileLinks(html, articleUrl, author) {
  const base = new URL(articleUrl);
  const slugParts = String(author || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const links = [];

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href || href.startsWith("mailto:") || href.startsWith("#")) continue;

    let resolved;
    try {
      resolved = new URL(href, base).toString();
    } catch {
      continue;
    }

    if (!resolved.startsWith(base.origin)) continue;
    const lower = resolved.toLowerCase();
    const likelyAuthorPage =
      lower.includes("/author/") ||
      lower.includes("/authors/") ||
      lower.includes("/profile/") ||
      lower.includes("/people/") ||
      slugParts.some((part) => part.length > 2 && lower.includes(part));

    if (likelyAuthorPage) {
      links.push(resolved);
    }
    if (links.length >= 4) break;
  }

  return dedupeStrings(links);
}

function buildSupplementalContextForPrompt(article) {
  const chunks = article?.supplemental_context?.chunks || [];
  if (chunks.length === 0) {
    return "No supplemental pages could be reliably fetched.";
  }

  return chunks
    .slice(0, 4)
    .map((chunk, index) => {
      return `Source ${index + 1} (${chunk.label}): ${chunk.url}\n${chunk.text_excerpt}`;
    })
    .join("\n\n");
}

async function gatherPublisherSearchContext(articleUrl, trace, env) {
  const maxPages = Math.max(
    1,
    Math.floor(parseTimeout(env.PUBLISHER_SEARCH_MAX_PAGES, DEFAULT_PUBLISHER_SEARCH_MAX_PAGES))
  );
  const timeoutMs = parseTimeout(
    env.PUBLISHER_SEARCH_TIMEOUT_MS,
    DEFAULT_PUBLISHER_SEARCH_TIMEOUT_MS
  );
  const origin = new URL(articleUrl).origin;
  const homepageUrl = `${origin}/`;

  const checkedUrls = [homepageUrl];
  const homepageResponse = await fetchWithTimeout(
    homepageUrl,
    {
      headers: {
        "User-Agent": "truth-check-bot/0.1"
      }
    },
    timeoutMs,
    "Publisher search fetch"
  ).catch(() => null);

  const homepageHtml =
    homepageResponse && homepageResponse.ok ? await homepageResponse.text().catch(() => "") : "";

  const candidateUrls = new Set();
  for (const path of [
    "/masthead",
    "/editorial",
    "/editorial-team",
    "/editors",
    "/about",
    "/about-us",
    "/staff",
    "/team",
    "/leadership",
    "/imprint"
  ]) {
    candidateUrls.add(`${origin}${path}`);
  }

  for (const discovered of extractPublisherSearchLinks(homepageHtml, homepageUrl)) {
    candidateUrls.add(discovered);
  }

  const targets = [...candidateUrls].slice(0, maxPages);
  const results = await Promise.allSettled(
    targets.map((target) =>
      fetchWithTimeout(
        target,
        {
          headers: {
            "User-Agent": "truth-check-bot/0.1"
          }
        },
        timeoutMs,
        "Publisher search fetch"
      )
    )
  );

  const chunks = [];
  for (let i = 0; i < results.length; i += 1) {
    checkedUrls.push(targets[i]);
    const res = results[i];
    if (res.status !== "fulfilled") continue;
    if (!res.value.ok) continue;
    if (!isHtmlResponse(res.value)) continue;
    if (!isSameOrigin(res.value.url, origin)) continue;

    const html = await res.value.text().catch(() => "");
    const backgroundCheck = runBackgroundCheck(targets[i], html);
    if (!backgroundCheck.ok) continue;

    const text = extractReadableText(html).slice(0, 2800);
    if (text.length < 220) continue;

    const label = new URL(targets[i]).pathname || "/";
    chunks.push({
      url: targets[i],
      label,
      text_excerpt: text
    });
  }

  trace.mark("publisher_search_context_collected", {
    checked: checkedUrls.length,
    usable: chunks.length,
    urls: checkedUrls
  });

  return {
    triggered: true,
    checked_urls: dedupeStrings(checkedUrls),
    chunks
  };
}

function hasLeadEditorSignal(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return false;

  return [
    "editor in chief",
    "editor-in-chief",
    "managing editor",
    "executive editor",
    "lead editor",
    "redaktor",
    "redactor"
  ].some((term) => normalized.includes(term));
}

function extractPublisherSearchLinks(html, baseUrl) {
  if (!html) return [];
  const base = new URL(baseUrl);
  const links = [];
  const keywordPattern = /(editor|masthead|staff|team|about|leadership|imprint)/i;
  const hrefRegex = /href=["']([^"']+)["']/gi;

  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;

    let resolved;
    try {
      resolved = new URL(href, base).toString();
    } catch {
      continue;
    }

    if (!resolved.startsWith(base.origin)) continue;
    if (!keywordPattern.test(resolved)) continue;

    links.push(resolved);
    if (links.length >= 8) break;
  }

  return dedupeStrings(links);
}

function buildPublisherSearchContextForPrompt(article) {
  const context = article?.publisher_search_context;
  if (!context?.triggered) {
    return "Fallback publisher-focused search was not needed.";
  }
  if (!context?.chunks?.length) {
    return "Fallback publisher-focused search was attempted but returned no usable pages.";
  }

  return context.chunks
    .slice(0, 5)
    .map((chunk, index) => {
      return `Publisher source ${index + 1} (${chunk.label}): ${chunk.url}\n${chunk.text_excerpt}`;
    })
    .join("\n\n");
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function isHtmlResponse(response) {
  const contentType = response?.headers?.get("content-type") || "";
  return contentType.toLowerCase().includes("text/html");
}

function isSameOrigin(finalUrl, origin) {
  try {
    return new URL(finalUrl).origin === origin;
  } catch {
    return false;
  }
}

function runBackgroundCheck(url, html) {
  if (!html) return { ok: false, reason: "empty_html" };
  const text = extractReadableText(html);
  if (text.length < 200) return { ok: false, reason: "too_short" };
  if (hasBlockSignals(text)) return { ok: false, reason: "blocked_or_captcha" };

  const expected = expectedKeywordsForPath(url);
  if (expected.length > 0) {
    const normalized = text.toLowerCase();
    const hit = expected.some((keyword) => normalized.includes(keyword));
    if (!hit) return { ok: false, reason: "missing_expected_keywords" };
  }

  return { ok: true, reason: "ok" };
}

function expectedKeywordsForPath(url) {
  const path = safePathname(url);
  if (!path) return [];
  if (path.includes("about")) {
    return ["about", "mission", "who we are", "our story", "history"];
  }
  if (path.includes("masthead") || path.includes("editorial")) {
    return ["editor", "editorial", "masthead", "managing editor", "editor-in-chief"];
  }
  if (path.includes("staff") || path.includes("team") || path.includes("leadership")) {
    return ["staff", "team", "leadership", "board", "editor"];
  }
  if (path.includes("imprint")) {
    return ["imprint", "publisher", "editor", "contact"];
  }
  return [];
}

function safePathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function hasBlockSignals(text) {
  const normalized = text.toLowerCase();
  return [
    "access denied",
    "verify you are a human",
    "captcha",
    "enable javascript",
    "subscribe to continue",
    "please subscribe",
    "sign in to continue",
    "cookies are required"
  ].some((phrase) => normalized.includes(phrase));
}

function extractAuthorsFromJsonLd(html) {
  const results = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    const parsed = tryParseJson(raw);
    if (!parsed) continue;

    collectAuthorNames(parsed, results);
  }

  return results;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Some pages include malformed or HTML-escaped JSON-LD; ignore safely.
    return null;
  }
}

function collectAuthorNames(node, results) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) collectAuthorNames(item, results);
    return;
  }

  if (typeof node !== "object") return;

  if (typeof node.author === "string") {
    results.push(node.author);
  } else if (Array.isArray(node.author)) {
    for (const author of node.author) {
      if (typeof author === "string") results.push(author);
      if (author && typeof author === "object" && typeof author.name === "string") {
        results.push(author.name);
      }
    }
  } else if (node.author && typeof node.author === "object" && typeof node.author.name === "string") {
    results.push(node.author.name);
  }

  if (Array.isArray(node["@graph"])) {
    for (const item of node["@graph"]) collectAuthorNames(item, results);
  }
}

function parseJsonFromModel(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model output was not valid JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function getFirstMatch(input, regexes) {
  for (const regex of regexes) {
    const match = input.match(regex);
    if (match?.[1]) {
      return decodeHtml(match[1].trim());
    }
  }
  return "";
}

function extractPrimaryArticleText(html) {
  const cleaned = stripNonContentTags(html);

  const articleBlocks = extractBlocksByTag(cleaned, "article");
  const selectedArticle = selectBestContentBlock(articleBlocks);
  if (selectedArticle.text.length >= 500) {
    return { text: selectedArticle.text, source: "article_tag" };
  }

  const bodyBlocks = [
    ...extractBlocksByAttr(cleaned, "main"),
    ...extractBlocksByAttr(cleaned, "section"),
    ...extractBlocksByAttr(cleaned, "div")
  ];
  const selectedBody = selectBestContentBlock(bodyBlocks);
  if (selectedBody.text.length >= 700) {
    return { text: selectedBody.text, source: "content_container" };
  }

  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] || cleaned;
  const stripped = stripLikelyChrome(bodyHtml);
  const fallbackText = htmlToText(stripped);
  return { text: fallbackText, source: "body_fallback" };
}

function stripNonContentTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
}

function extractBlocksByTag(html, tag) {
  const blocks = [];
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractBlocksByAttr(html, tag) {
  const blocks = [];
  const regex = new RegExp(
    `<${tag}\\b[^>]*(?:id|class)=["'][^"']*(?:article|post|entry|content|story|body|main)[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "gi"
  );
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function selectBestContentBlock(blocks) {
  let best = { text: "", score: -1 };
  for (const block of blocks) {
    const text = htmlToText(stripLikelyChrome(block));
    const score = scoreContentText(text);
    if (score > best.score) {
      best = { text, score };
    }
  }
  return best;
}

function stripLikelyChrome(html) {
  return String(html || "")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<ul[\s\S]*?<\/ul>/gi, " ");
}

function htmlToText(html) {
  const noTags = String(html || "").replace(/<[^>]+>/g, " ");
  return decodeHtml(noTags).replace(/\s+/g, " ").trim();
}

function extractReadableText(html) {
  return htmlToText(stripNonContentTags(html));
}

function scoreContentText(text) {
  const value = String(text || "");
  if (!value) return 0;
  const words = value.split(/\s+/).length;
  const punct = (value.match(/[.!?]/g) || []).length;
  const navPenalty = (value.match(/\b(home|menu|search|newsletter|subscribe|login)\b/gi) || [])
    .length;
  return words + punct * 12 - navPenalty * 30;
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isLikelyHttpUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeLanguage(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.startsWith("de")) return "de";
  return "en";
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}
