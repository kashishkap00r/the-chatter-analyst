import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  generateThreadDraft,
  ingestThreadEditionFromSubstackUrl,
  ingestThreadEditionFromText,
  parsePdfToText,
  regenerateThreadTweet,
  shortlistThreadCandidates,
} from "../services/geminiService";
import type {
  ModelType,
  ProviderType,
  ThreadEditionSource,
  ThreadQuoteCandidate,
} from "../types";
import {
  buildThreadCardFileName,
  buildThreadQuoteImage,
  copyDataUrlImageToClipboard,
  copyTextAndDataUrlImageToClipboard,
  downloadDataUrlImage,
} from "../utils/threadImageExport";

type ComposerStatus = "idle" | "loading" | "ready" | "error";
type ComposerView = "selection" | "results";
type ThreadTweetKind = "intro" | "insight" | "outro";

interface ThreadTweetCard {
  id: string;
  kind: ThreadTweetKind;
  text: string;
  quoteId?: string;
}

interface ThreadComposerProps {
  provider: ProviderType;
  model: ModelType;
  disabled?: boolean;
}

interface PersistedThreadComposerState {
  schemaVersion: 1;
  substackUrl: string;
  source: ThreadEditionSource | null;
  composerView?: ComposerView;
  shortlistedQuoteIds?: string[];
  selectedQuoteIds: string[];
  tweets: ThreadTweetCard[];
}

const THREAD_COMPOSER_STORAGE_KEY = "chatter-thread-composer-v1";

const normalizeClipboardError = (error: unknown): string => {
  const message = String((error as any)?.message || "Clipboard action failed.");
  if (!message) return "Clipboard action failed.";
  return message;
};

const ThreadComposer: React.FC<ThreadComposerProps> = ({ provider, model, disabled = false }) => {
  const [substackUrl, setSubstackUrl] = useState("");
  const [ingestStatus, setIngestStatus] = useState<ComposerStatus>("idle");
  const [ingestError, setIngestError] = useState("");
  const [source, setSource] = useState<ThreadEditionSource | null>(null);
  const [composerView, setComposerView] = useState<ComposerView>("selection");
  const [shortlistStatus, setShortlistStatus] = useState<ComposerStatus>("idle");
  const [shortlistError, setShortlistError] = useState("");
  const [shortlistedQuoteIds, setShortlistedQuoteIds] = useState<string[]>([]);
  const [selectedQuoteIds, setSelectedQuoteIds] = useState<string[]>([]);

  const [threadStatus, setThreadStatus] = useState<ComposerStatus>("idle");
  const [threadError, setThreadError] = useState("");
  const [tweets, setTweets] = useState<ThreadTweetCard[]>([]);

  const [busyTweetId, setBusyTweetId] = useState<string | null>(null);
  const [tweetFeedback, setTweetFeedback] = useState<Record<string, string>>({});

  const [imageCache, setImageCache] = useState<Record<string, string>>({});
  const [imageActionBusy, setImageActionBusy] = useState<string | null>(null);
  const [imageActionError, setImageActionError] = useState<string>("");

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const shortlistRunTokenRef = useRef(0);

  const allQuotes = useMemo(() => {
    if (!source) return [] as ThreadQuoteCandidate[];
    return source.companies.flatMap((company) => company.quotes);
  }, [source]);

  const quoteById = useMemo(() => {
    const map = new Map<string, ThreadQuoteCandidate>();
    for (const quote of allQuotes) {
      map.set(quote.id, quote);
    }
    return map;
  }, [allQuotes]);

  const shortlistedQuotes = useMemo(() => {
    return shortlistedQuoteIds
      .map((id) => quoteById.get(id))
      .filter((quote): quote is ThreadQuoteCandidate => Boolean(quote));
  }, [quoteById, shortlistedQuoteIds]);

  const selectedQuotes = useMemo(() => {
    return selectedQuoteIds
      .map((id) => quoteById.get(id))
      .filter((quote): quote is ThreadQuoteCandidate => Boolean(quote));
  }, [quoteById, selectedQuoteIds]);

  const selectedCount = selectedQuotes.length;
  const totalQuoteCount = allQuotes.length;
  const shortlistedCount = shortlistedQuotes.length;
  const hasGeneratedThread = tweets.length > 0;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(THREAD_COMPOSER_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedThreadComposerState;
      if (!parsed || parsed.schemaVersion !== 1) return;

      setSubstackUrl(typeof parsed.substackUrl === "string" ? parsed.substackUrl : "");
      setSource(parsed.source ?? null);
      setShortlistedQuoteIds(Array.isArray(parsed.shortlistedQuoteIds) ? parsed.shortlistedQuoteIds : []);
      setSelectedQuoteIds(Array.isArray(parsed.selectedQuoteIds) ? parsed.selectedQuoteIds : []);
      setTweets(Array.isArray(parsed.tweets) ? parsed.tweets : []);
      if (parsed.composerView === "selection" || parsed.composerView === "results") {
        setComposerView(parsed.composerView);
      } else {
        setComposerView(Array.isArray(parsed.tweets) && parsed.tweets.length > 0 ? "results" : "selection");
      }
      setIngestStatus(parsed.source ? "ready" : "idle");
      setShortlistStatus(parsed.source && Array.isArray(parsed.shortlistedQuoteIds) ? "ready" : "idle");
      setShortlistError("");
      setThreadStatus(Array.isArray(parsed.tweets) && parsed.tweets.length > 0 ? "ready" : "idle");
    } catch {
      // Ignore invalid stored state and start fresh.
    }
  }, []);

  useEffect(() => {
    const payload: PersistedThreadComposerState = {
      schemaVersion: 1,
      substackUrl,
      source,
      composerView,
      shortlistedQuoteIds,
      selectedQuoteIds,
      tweets,
    };

    try {
      window.localStorage.setItem(THREAD_COMPOSER_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage write failures; feature remains functional.
    }
  }, [composerView, selectedQuoteIds, shortlistedQuoteIds, source, substackUrl, tweets]);

  const setFeedbackForTweet = (tweetId: string, message: string) => {
    setTweetFeedback((prev) => ({ ...prev, [tweetId]: message }));
    window.setTimeout(() => {
      setTweetFeedback((prev) => {
        if (!prev[tweetId]) return prev;
        const next = { ...prev };
        delete next[tweetId];
        return next;
      });
    }, 1800);
  };

  const clearThreadDraft = () => {
    setThreadStatus("idle");
    setThreadError("");
    setTweets([]);
    setBusyTweetId(null);
    setTweetFeedback({});
    setImageActionBusy(null);
    setImageActionError("");
    setImageCache({});
  };

  const resetComposer = () => {
    shortlistRunTokenRef.current = Date.now();
    setSubstackUrl("");
    setIngestStatus("idle");
    setIngestError("");
    setSource(null);
    setComposerView("selection");
    setShortlistStatus("idle");
    setShortlistError("");
    setShortlistedQuoteIds([]);
    setSelectedQuoteIds([]);
    clearThreadDraft();
    try {
      window.localStorage.removeItem(THREAD_COMPOSER_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  };

  const buildShortlist = async (nextSource: ThreadEditionSource) => {
    const token = Date.now() + Math.random();
    shortlistRunTokenRef.current = token;

    const quoteUniverse = nextSource.companies.flatMap((company) => company.quotes);
    if (quoteUniverse.length === 0) {
      setShortlistedQuoteIds([]);
      setShortlistStatus("ready");
      setShortlistError("");
      return;
    }

    if (quoteUniverse.length <= 25) {
      setShortlistedQuoteIds(quoteUniverse.map((quote) => quote.id));
      setShortlistStatus("ready");
      setShortlistError("");
      return;
    }

    setShortlistStatus("loading");
    setShortlistError("");

    try {
      const shortlist = await shortlistThreadCandidates(quoteUniverse, provider, model, {
        maxCandidates: 25,
        maxPerCompany: 2,
      });

      if (shortlistRunTokenRef.current !== token) {
        return;
      }

      const quoteIdSet = new Set(quoteUniverse.map((quote) => quote.id));
      const normalizedIds = shortlist.shortlistedQuoteIds.filter((id) => quoteIdSet.has(id));
      setShortlistedQuoteIds(normalizedIds);
      setShortlistStatus("ready");
      setShortlistError("");
    } catch (error: any) {
      if (shortlistRunTokenRef.current !== token) {
        return;
      }
      setShortlistStatus("error");
      setShortlistError(String(error?.message || "Unable to build Top 25 shortlist."));
      setShortlistedQuoteIds([]);
    }
  };

  const hydrateGeneratedImages = (quotes: ThreadQuoteCandidate[]) => {
    const next: Record<string, string> = {};
    for (const quote of quotes) {
      try {
        next[quote.id] = buildThreadQuoteImage(quote);
      } catch {
        // Keep per-card fallback handling for image generation errors.
      }
    }
    setImageCache(next);
  };

  const handleLoadFromUrl = async () => {
    const trimmedUrl = substackUrl.trim();
    if (!trimmedUrl) return;

    setIngestStatus("loading");
    setIngestError("");
    setComposerView("selection");
    clearThreadDraft();
    setShortlistedQuoteIds([]);
    setShortlistStatus("idle");
    setShortlistError("");

    try {
      const parsed = await ingestThreadEditionFromSubstackUrl(trimmedUrl);
      setSource(parsed);
      setSelectedQuoteIds([]);
      setIngestStatus("ready");
      await buildShortlist(parsed);
    } catch (error: any) {
      setIngestStatus("error");
      setIngestError(String(error?.message || "Unable to load Substack edition."));
      setSource(null);
      setShortlistedQuoteIds([]);
      setShortlistStatus("idle");
      setShortlistError("");
      setSelectedQuoteIds([]);
    }
  };

  const handleLoadFromPdf = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIngestStatus("loading");
    setIngestError("");
    setComposerView("selection");
    clearThreadDraft();
    setShortlistedQuoteIds([]);
    setShortlistStatus("idle");
    setShortlistError("");

    try {
      const extractedText = await parsePdfToText(file);
      const parsed = await ingestThreadEditionFromText(extractedText);
      setSource(parsed);
      setSelectedQuoteIds([]);
      setIngestStatus("ready");
      await buildShortlist(parsed);
    } catch (error: any) {
      setIngestStatus("error");
      setIngestError(String(error?.message || "Unable to parse PDF edition."));
      setSource(null);
      setShortlistedQuoteIds([]);
      setShortlistStatus("idle");
      setShortlistError("");
      setSelectedQuoteIds([]);
    } finally {
      if (pdfInputRef.current) {
        pdfInputRef.current.value = "";
      }
    }
  };

  const toggleQuoteSelection = (quoteId: string) => {
    setSelectedQuoteIds((prev) => {
      if (prev.includes(quoteId)) {
        return prev.filter((id) => id !== quoteId);
      }
      return [...prev, quoteId];
    });
  };

  const selectAllQuotes = () => {
    setSelectedQuoteIds(allQuotes.map((quote) => quote.id));
  };

  const selectTopShortlist = () => {
    setSelectedQuoteIds(shortlistedQuotes.map((quote) => quote.id));
  };

  const clearSelectedQuotes = () => {
    setSelectedQuoteIds([]);
  };

  const handleGenerateThread = async () => {
    if (!source || selectedQuotes.length === 0) return;

    setComposerView("selection");
    setThreadStatus("loading");
    setThreadError("");
    setTweets([]);
    setImageActionError("");

    try {
      const draft = await generateThreadDraft(
        selectedQuotes,
        {
          editionTitle: source.editionTitle,
          editionUrl: source.editionUrl,
          editionDate: source.editionDate,
          companiesCovered: source.companiesCovered,
          industriesCovered: source.industriesCovered,
        },
        provider,
        model,
      );

      const builtTweets: ThreadTweetCard[] = [
        {
          id: "intro",
          kind: "intro",
          text: draft.introTweet,
        },
        ...draft.insightTweets.map((tweet, index) => ({
          id: `insight-${tweet.quoteId}-${index}`,
          kind: "insight" as const,
          quoteId: tweet.quoteId,
          text: tweet.tweet,
        })),
        {
          id: "outro",
          kind: "outro",
          text: draft.outroTweet,
        },
      ];

      setTweets(builtTweets);
      hydrateGeneratedImages(selectedQuotes);
      setThreadStatus("ready");
      setComposerView("results");
    } catch (error: any) {
      setThreadStatus("error");
      setThreadError(String(error?.message || "Thread generation failed."));
    }
  };

  const handleCopyTweet = async (tweet: ThreadTweetCard, position: number) => {
    if (tweet.kind === "insight" && tweet.quoteId) {
      const imageData = getImageForQuote(tweet.quoteId);
      if (imageData) {
        try {
          const copyMode = await copyTextAndDataUrlImageToClipboard(tweet.text, imageData);
          if (copyMode === "combined") {
            setFeedbackForTweet(tweet.id, `Tweet ${position} + image copied.`);
          } else {
            setFeedbackForTweet(tweet.id, `Tweet ${position} copied. Use Download PNG for image.`);
          }
          return;
        } catch (error) {
          setFeedbackForTweet(tweet.id, normalizeClipboardError(error));
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(tweet.text);
      setFeedbackForTweet(tweet.id, `Tweet ${position} copied.`);
    } catch (error) {
      setFeedbackForTweet(tweet.id, normalizeClipboardError(error));
    }
  };

  const handleRegenerateTweet = async (tweet: ThreadTweetCard) => {
    if (!source) return;

    const targetQuote = tweet.quoteId ? quoteById.get(tweet.quoteId) : undefined;
    if (tweet.kind === "insight" && !targetQuote) {
      setFeedbackForTweet(tweet.id, "Missing quote context for this tweet.");
      return;
    }

    const usedTweetTexts = tweets.filter((item) => item.id !== tweet.id).map((item) => item.text);

    setBusyTweetId(tweet.id);
    setThreadError("");

    try {
      const regenerated = await regenerateThreadTweet({
        tweetKind: tweet.kind,
        currentTweet: tweet.text,
        usedTweetTexts,
        targetQuote,
        editionMetadata: {
          editionTitle: source.editionTitle,
          editionUrl: source.editionUrl,
          editionDate: source.editionDate,
        },
        provider,
        modelId: model,
      });

      setTweets((prev) => prev.map((item) => (item.id === tweet.id ? { ...item, text: regenerated } : item)));
      setFeedbackForTweet(tweet.id, "Regenerated.");
    } catch (error: any) {
      setFeedbackForTweet(tweet.id, String(error?.message || "Unable to regenerate tweet."));
    } finally {
      setBusyTweetId(null);
    }
  };

  const getImageForQuote = (quoteId: string): string | null => {
    const cached = imageCache[quoteId];
    if (cached) return cached;

    const quote = quoteById.get(quoteId);
    if (!quote) return null;

    try {
      const generated = buildThreadQuoteImage(quote);
      setImageCache((prev) => ({ ...prev, [quoteId]: generated }));
      return generated;
    } catch {
      return null;
    }
  };

  const handleCopyImage = async (tweet: ThreadTweetCard, position: number) => {
    if (!tweet.quoteId) return;
    const imageData = getImageForQuote(tweet.quoteId);
    if (!imageData) {
      setImageActionError("Unable to render image card for this quote.");
      return;
    }

    setImageActionBusy(tweet.id);
    setImageActionError("");
    try {
      await copyDataUrlImageToClipboard(imageData);
      setFeedbackForTweet(tweet.id, `Image ${position} copied.`);
    } catch (error: any) {
      setImageActionError(String(error?.message || "Image copy failed."));
    } finally {
      setImageActionBusy(null);
    }
  };

  const handleDownloadImage = (tweet: ThreadTweetCard, position: number) => {
    if (!tweet.quoteId) return;
    const imageData = getImageForQuote(tweet.quoteId);
    const quote = quoteById.get(tweet.quoteId);
    if (!imageData || !quote) {
      setImageActionError("Unable to render image card for this quote.");
      return;
    }

    const fileName = buildThreadCardFileName(quote, position);
    downloadDataUrlImage(imageData, fileName);
    setFeedbackForTweet(tweet.id, `Image ${position} downloaded.`);
  };

  const renderQuoteCandidateCard = (
    quote: ThreadQuoteCandidate,
    options?: { badgeLabel?: string },
  ) => {
    const isSelected = selectedQuoteIds.includes(quote.id);

    return (
      <div
        key={quote.id}
        className={`rounded-xl border p-3 ${isSelected ? "border-brand/50 bg-brand-soft/25" : "border-line bg-canvas/25"}`}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs uppercase tracking-[0.12em] text-stone">
              {options?.badgeLabel || `Insight ${quote.sourceOrder}`}
            </p>
            <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[11px] font-semibold text-stone">
              {quote.companyName}
            </span>
          </div>
          <button
            onClick={() => toggleQuoteSelection(quote.id)}
            disabled={disabled}
            className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${
              isSelected
                ? "border-brand bg-brand text-white"
                : "border-line bg-white text-stone hover:text-ink"
            }`}
          >
            {isSelected ? "Selected" : "Use in Thread"}
          </button>
        </div>

        <p className="text-sm text-ink/90 mb-2">{quote.summary}</p>
        <blockquote className="border-l-4 border-brand pl-3">
          <p className="text-sm italic text-ink">"{quote.quote}"</p>
        </blockquote>
        <p className="text-xs text-stone mt-2">- {quote.speakerName}, {quote.speakerDesignation}</p>
      </div>
    );
  };

  return (
    <section className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6 space-y-5">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Distribution Desk</p>
            <h3 className="font-serif text-2xl text-ink">Thread Composer (X)</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-brand/25 bg-brand-soft/55 px-3 py-1 text-xs font-semibold text-brand">
              {provider === "gemini" ? "Gemini" : "OpenRouter"} • {model}
            </span>
            <button
              onClick={resetComposer}
              disabled={disabled}
              className="rounded-lg border border-line bg-white px-3 py-1 text-xs font-semibold text-stone hover:text-ink disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </div>
        <p className="text-sm text-stone">
          Paste final Substack URL to auto-build an AI-picked Top 25 quote universe, then add any misses from the full list and generate your post-ready thread.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3">
        <input
          value={substackUrl}
          onChange={(event) => setSubstackUrl(event.target.value)}
          disabled={disabled || ingestStatus === "loading"}
          placeholder="https://thechatter.zerodha.com/p/..."
          className="w-full rounded-xl border border-line bg-canvas/40 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/35"
        />
        <button
          onClick={handleLoadFromUrl}
          disabled={disabled || ingestStatus === "loading" || !substackUrl.trim()}
          className="rounded-xl border border-brand bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 hover:bg-brand/90"
        >
          {ingestStatus === "loading" ? "Loading..." : "Load Edition"}
        </button>
        <button
          onClick={() => pdfInputRef.current?.click()}
          disabled={disabled || ingestStatus === "loading"}
          className="rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-semibold text-stone disabled:opacity-50 hover:text-ink"
        >
          PDF Fallback
        </button>
        <input
          ref={pdfInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={handleLoadFromPdf}
          disabled={disabled || ingestStatus === "loading"}
        />
      </div>

      {ingestError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{ingestError}</div>
      )}

      {source && (
        <div className="rounded-xl border border-line bg-canvas/35 px-4 py-3 text-sm text-stone flex flex-wrap items-center justify-between gap-2">
          <p>
            <span className="font-semibold text-ink">{source.editionTitle}</span>
            {source.editionDate ? ` • ${source.editionDate}` : ""}
          </p>
          <p>
            {source.companies.length} companies • {totalQuoteCount} total quotes
            {shortlistStatus === "ready" ? ` • ${shortlistedCount} Top candidates` : ""}
          </p>
        </div>
      )}

      {(source || hasGeneratedThread) && (
        <div className="sticky top-4 z-10 rounded-xl border border-line bg-white/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-line bg-canvas p-1">
              <button
                onClick={() => setComposerView("selection")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  composerView === "selection" ? "bg-white text-ink shadow-sm" : "text-stone hover:text-ink"
                }`}
              >
                Selection
              </button>
              <button
                onClick={() => setComposerView("results")}
                disabled={!hasGeneratedThread}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  composerView === "results"
                    ? "bg-white text-ink shadow-sm"
                    : "text-stone hover:text-ink disabled:opacity-50 disabled:hover:text-stone"
                }`}
              >
                Generated Thread
              </button>
            </div>
            <p className="text-xs text-stone">
              {composerView === "results" && hasGeneratedThread
                ? `${tweets.length} tweets ready to publish.`
                : source
                  ? `${selectedCount} selected from ${totalQuoteCount}.`
                  : "Load an edition to start selecting quotes."}
            </p>
          </div>
        </div>
      )}

      {source && composerView === "selection" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-stone">
              Selected: <span className="font-semibold text-ink">{selectedCount}</span> / {totalQuoteCount} (from Top 25 or Full Universe)
            </p>
            <div className="flex gap-2">
              <button
                onClick={selectTopShortlist}
                disabled={disabled || shortlistStatus !== "ready" || shortlistedCount === 0}
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone disabled:opacity-50 hover:text-ink"
              >
                Select Top 25
              </button>
              <button
                onClick={selectAllQuotes}
                disabled={disabled || totalQuoteCount === 0}
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone disabled:opacity-50 hover:text-ink"
              >
                Select Universe
              </button>
              <button
                onClick={clearSelectedQuotes}
                disabled={disabled || selectedCount === 0}
                className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone disabled:opacity-50 hover:text-ink"
              >
                Clear Selection
              </button>
              <button
                onClick={handleGenerateThread}
                disabled={disabled || selectedCount === 0 || threadStatus === "loading"}
                className="rounded-lg border border-brand bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 hover:bg-brand/90"
              >
                {threadStatus === "loading" ? "Generating..." : `Generate Thread (${selectedCount})`}
              </button>
            </div>
          </div>

          {threadError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{threadError}</div>
          )}

          {shortlistStatus === "loading" && (
            <div className="rounded-xl border border-brand/30 bg-brand-soft/30 px-4 py-3 text-sm text-brand">
              Building AI-picked Top 25 candidate universe...
            </div>
          )}

          {shortlistError && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Top 25 shortlist could not be generated: {shortlistError}
            </div>
          )}

          <article className="rounded-xl border border-line bg-white p-4">
            <header className="mb-3">
              <h4 className="font-serif text-xl text-ink">Top 25 Candidates (AI-picked)</h4>
              <p className="text-sm text-stone">
                Start from this smaller universe, then add any missed quotes from the full universe below.
              </p>
            </header>

            {shortlistStatus === "loading" ? (
              <div className="rounded-lg border border-dashed border-line bg-canvas/30 px-4 py-6 text-sm text-stone text-center">
                Building candidate shortlist...
              </div>
            ) : shortlistedQuotes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line bg-canvas/30 px-4 py-6 text-sm text-stone text-center">
                No shortlist candidates available yet. You can still choose from the full universe below.
              </div>
            ) : (
              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                {shortlistedQuotes.map((quote, index) =>
                  renderQuoteCandidateCard(quote, { badgeLabel: `Candidate ${index + 1}` }),
                )}
              </div>
            )}
          </article>

          <article className="rounded-xl border border-line bg-white p-4">
            <header className="mb-3">
              <h4 className="font-serif text-xl text-ink">Full Universe (Manual Additions)</h4>
              <p className="text-sm text-stone">
                Add any quote you had in mind that did not make the Top 25 shortlist.
              </p>
            </header>

            <div className="space-y-4 max-h-[560px] overflow-y-auto pr-1">
              {source.companies.map((company) => (
                <article key={`${company.companyName}-${company.industry}`} className="rounded-xl border border-line bg-canvas/20 p-4">
                  <header className="mb-3">
                    <h5 className="font-serif text-lg text-ink">{company.companyName}</h5>
                    <p className="text-xs text-stone">
                      {company.marketCapCategory} | {company.industry}
                    </p>
                  </header>

                  <div className="space-y-3">
                    {company.quotes.map((quote) => renderQuoteCandidateCard(quote))}
                  </div>
                </article>
              ))}
            </div>
          </article>
        </div>
      )}

      {composerView === "results" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-stone">
              Generated output is isolated here to keep quote selection uncluttered.
            </p>
            <button
              onClick={() => setComposerView("selection")}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone hover:text-ink"
            >
              Back to Selection
            </button>
          </div>

          {!hasGeneratedThread && (
            <div className="rounded-xl border border-dashed border-line bg-canvas/30 px-4 py-8 text-center text-sm text-stone">
              No generated thread yet. Select quotes and click Generate Thread to populate this view.
            </div>
          )}

          {threadError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{threadError}</div>
          )}

          {hasGeneratedThread && (
            <>
          <div className="rounded-xl border border-line bg-canvas/30 px-4 py-3 text-sm text-stone">
            {tweets.length} tweet blocks ready. For insight tweets, Copy Tweet attempts text + image together; Download PNG is always available.
          </div>

          {imageActionError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{imageActionError}</div>
          )}

          <div className="space-y-4">
            {tweets.map((tweet, index) => {
              const tweetNumber = index + 1;
              const quote = tweet.quoteId ? quoteById.get(tweet.quoteId) : undefined;
              const imageData = tweet.quoteId ? getImageForQuote(tweet.quoteId) : null;

              return (
                <article key={tweet.id} className="rounded-2xl border border-line bg-white p-4 sm:p-5 space-y-4">
                  <header className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-line bg-canvas px-2.5 py-1 text-xs font-semibold text-stone">
                        Tweet {tweetNumber}
                      </span>
                      <span className="rounded-full border border-brand/25 bg-brand-soft/40 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-brand">
                        {tweet.kind}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCopyTweet(tweet, tweetNumber)}
                        className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone hover:text-ink"
                      >
                        {tweet.kind === "insight" ? "Copy Tweet + Image" : "Copy Tweet"}
                      </button>
                      <button
                        onClick={() => handleRegenerateTweet(tweet)}
                        disabled={busyTweetId === tweet.id}
                        className="rounded-lg border border-brand bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 hover:bg-brand/90"
                      >
                        {busyTweetId === tweet.id ? "Regenerating..." : "Regenerate"}
                      </button>
                    </div>
                  </header>

                  <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{tweet.text}</p>

                  {tweetFeedback[tweet.id] && (
                    <p className="text-xs font-semibold text-brand">{tweetFeedback[tweet.id]}</p>
                  )}

                  {tweet.kind === "insight" && quote && (
                    <div className="rounded-xl border border-line bg-canvas/20 p-3 space-y-3">
                      {imageData ? (
                        <img
                          src={imageData}
                          alt={`Quote card for ${quote.companyName}`}
                          className="w-full rounded-lg border border-line object-cover"
                        />
                      ) : (
                        <div className="rounded-lg border border-dashed border-line bg-white px-4 py-8 text-center text-xs text-stone">
                          Image preview unavailable for this quote.
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => handleCopyImage(tweet, tweetNumber)}
                          disabled={!imageData || imageActionBusy === tweet.id}
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone disabled:opacity-50 hover:text-ink"
                        >
                          {imageActionBusy === tweet.id ? "Copying..." : "Copy Image"}
                        </button>
                        <button
                          onClick={() => handleDownloadImage(tweet, tweetNumber)}
                          disabled={!imageData}
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-stone disabled:opacity-50 hover:text-ink"
                        >
                          Download PNG
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default ThreadComposer;
