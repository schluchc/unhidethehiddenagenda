const DEFAULT_APERTUS_URL = "https://api.publicai.co/v1/chat/completions";
const DEFAULT_ARTICLE_TIMEOUT_MS = 20000;
const DEFAULT_MODEL_TIMEOUT_MS = 65000;

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
    if (!isLikelyHttpUrl(articleUrl)) {
      return json({ error: "Invalid URL. Use a full http(s) URL." }, 400, corsHeaders);
    }

    const providerConfig = resolveModelProvider(env);
    if (!providerConfig.apiKey) {
      return json(
        {
          error:
            "Missing APERTUS_API_KEY (or AI_API_KEY) in Cloudflare environment variables."
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
    const analysis = await analyzeWithModel(article, providerConfig, trace, env);

    trace.mark("analysis_complete", {
      author_detected: article.author !== "Unknown author"
    });

    const payload = { article, analysis };
    if (debugEnabled) {
      payload.debug = trace.finish({
        article_chars: article.text_excerpt.length,
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

  const author = getFirstMatch(html, [
    /<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']article:author["']\s+content=["']([^"']+)["']/i,
    /\bby\s+([A-Z][A-Za-z\-.'\s]{1,80})/i
  ]);

  const articleText = extractReadableText(html).slice(0, 12000);

  if (!articleText || articleText.length < 400) {
    throw appError(
      422,
      "Could not extract enough article text for analysis. The page may be paywalled or script-rendered.",
      "ARTICLE_TEXT_TOO_SHORT",
      `Extracted ${articleText.length} chars from article text`
    );
  }

  trace.mark("article_parsed", {
    html_chars: html.length,
    text_chars: articleText.length,
    author_detected: Boolean(author)
  });

  return {
    url,
    title: title || "Unknown title",
    author: author || "Unknown author",
    text_excerpt: articleText
  };
}

async function analyzeWithModel(article, providerConfig, trace, env) {
  const prompt = `You are an investigative analyst.
Task: assess potential author motivations or bias pressures for a specific article.

Article title: ${article.title}
Author: ${article.author}
Article URL: ${article.url}
Article excerpt:\n${article.text_excerpt}

Instructions:
- Focus on motivations that might impact honesty: affiliations, current/previous employers, funding incentives, political incentives, reputational pressure, legal pressure, fear, or career incentives.
- If evidence is weak, state uncertainty clearly.
- Avoid definitive accusations.
- Extract 4-8 key claim sentences from the article excerpt and connect each to a caveat.

Return STRICT JSON only with this schema:
{
  "author_profile": "short paragraph",
  "motivations": [
    {"factor": "string", "impact": "string", "evidence_strength": "high|medium|low"}
  ],
  "key_claim_checks": [
    {
      "claim_sentence": "string",
      "potential_motivation_link": "string",
      "caveat": "string",
      "confidence": "high|medium|low"
    }
  ]
}`;

  trace.mark("model_request_started", {
    base_url: providerConfig.baseUrl,
    model: providerConfig.model
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
          {
            role: "system",
            content:
              "You produce cautious, evidence-aware analysis as strict JSON. No markdown, no extra keys."
          },
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
    provider_response_chars: responseText.length
  });

  return parsed;
}

function resolveModelProvider(env) {
  return {
    apiKey: env.APERTUS_API_KEY || env.AI_API_KEY || env.OPENAI_API_KEY || "",
    baseUrl: env.AI_API_BASE_URL || env.APERTUS_API_BASE_URL || DEFAULT_APERTUS_URL,
    model: env.AI_MODEL || env.APERTUS_MODEL || env.OPENAI_MODEL || "swiss-ai/apertus-8b-instruct",
    userAgent: env.AI_USER_AGENT || env.APERTUS_USER_AGENT || "truth-check/0.1"
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
      throw error;
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
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

function extractReadableText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const noTags = cleaned.replace(/<[^>]+>/g, " ");
  return decodeHtml(noTags).replace(/\s+/g, " ").trim();
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

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}
