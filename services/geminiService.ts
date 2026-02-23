import {
  ChatterAnalysisResult,
  ModelType,
  PointsAndFiguresResult,
  ProgressEvent,
  ProviderType,
  SelectedSlide,
  ThreadDraftResult,
  ThreadEditionSource,
  ThreadQuoteCandidate,
} from "../types";

const CHATTER_ANALYZE_ENDPOINT = "/api/chatter/analyze";
const POINTS_ANALYZE_ENDPOINT = "/api/points/analyze";
const CHATTER_THREAD_INGEST_ENDPOINT = "/api/chatter/thread/ingest";
const CHATTER_THREAD_GENERATE_ENDPOINT = "/api/chatter/thread/generate";
const CHATTER_THREAD_REGENERATE_ENDPOINT = "/api/chatter/thread/regenerate";

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    reasonCode?: string;
    details?: unknown;
  };
  message?: string;
}

interface PointsAnalyzeApiSlide {
  selectedPageNumber: number;
  context: string;
}

interface PointsAnalyzeApiResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  zerodhaStockUrl?: string;
  slides: PointsAnalyzeApiSlide[];
}

interface ThreadGenerateInsightApiItem {
  quoteId: string;
  tweet: string;
}

interface ThreadGenerateApiResult {
  introTweet: string;
  insightTweets: ThreadGenerateInsightApiItem[];
  outroTweet: string;
}

interface PdfImageConversionOptions {
  startPage?: number;
  endPage?: number;
  scale?: number;
  jpegQuality?: number;
}

interface HighQualityRenderOptions {
  scale?: number;
  pngDataUrlMaxChars?: number;
  jpegFallbackQuality?: number;
  onProgress?: (event: HighQualityRenderProgressEvent) => void;
}

interface HighQualityRenderProgressEvent {
  current: number;
  total: number;
  pageNumber: number;
}

interface HighQualityRenderFailure {
  pageNumber: number;
  reason: string;
}

export interface HighQualityRenderResult {
  imagesByPage: Record<number, string>;
  downgradedPages: number[];
  failedPages: HighQualityRenderFailure[];
}

const parseRetryAfterSeconds = (response: Response): number | null => {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.ceil(parsed);
};

const parseApiErrorMessage = async (response: Response): Promise<string> => {
  let fallbackMessage = `Request failed with status ${response.status}.`;
  const retryAfterSeconds = parseRetryAfterSeconds(response);
  const retrySuffix = retryAfterSeconds ? ` Retry in about ${retryAfterSeconds}s.` : "";
  const clonedResponse = response.clone();

  try {
    const payload = (await response.json()) as ApiErrorPayload;
    if (payload?.error?.message) {
      const reason = payload?.error?.reasonCode ? ` [${payload.error.reasonCode}]` : "";
      const details =
        typeof payload?.error?.details === "string"
          ? ` ${payload.error.details}`
          : payload?.error?.details
            ? ` ${JSON.stringify(payload.error.details)}`
            : "";
      return `${payload.error.message}${reason}${details}${retrySuffix}`.trim();
    }
    if (payload?.message) {
      return `${payload.message}${retrySuffix}`.trim();
    }
  } catch {
    // Ignore invalid JSON and try text fallback.
  }

  try {
    const rawText = (await clonedResponse.text()).trim();
    if (rawText) {
      if (/<!doctype html|<html[\s>]/i.test(rawText)) {
        if (response.status >= 500) {
          return `Temporary gateway error (status ${response.status}). Please retry.${retrySuffix}`;
        }
        return `${fallbackMessage}${retrySuffix}`.trim();
      }
      if (/^error code:\s*5\d{2}$/i.test(rawText)) {
        return `Temporary gateway error (status ${response.status}). Please retry.${retrySuffix}`.trim();
      }
      const snippet = rawText.length > 320 ? `${rawText.slice(0, 320)}...` : rawText;
      return `${fallbackMessage} ${snippet}${retrySuffix}`.trim();
    }
  } catch {
    // Ignore text read failures and fall back to status text.
  }

  if (response.statusText) {
    fallbackMessage = `${fallbackMessage} ${response.statusText}`;
  }

  return fallbackMessage;
};

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await parseApiErrorMessage(response);
    throw new Error(message);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Server returned invalid JSON.");
  }
};

const transcriptProgressDefaults: ProgressEvent[] = [
  { stage: "preparing", message: "Normalizing transcript and validating structure...", percent: 8 },
  { stage: "uploading", message: "Sending transcript to provider...", percent: 22 },
  { stage: "analyzing", message: "Extracting strategic quotes and implications...", percent: 62 },
  { stage: "finalizing", message: "Structuring insights for output...", percent: 88 },
];

// --- PDF Processing ---

const getPdfDocument = async (file: File) => {
  // @ts-ignore
  if (typeof window === "undefined" || !window.pdfjsLib) {
    throw new Error("PDF processing library is not loaded.");
  }
  // @ts-ignore
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  loadingTask.onPassword = () => {
    throw new Error("Password protected PDFs are not supported.");
  };
  return loadingTask.promise;
};

export const parsePdfToText = async (file: File): Promise<string> => {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("PDF file is too large (max 10MB).");
  }
  const pdf = await getPdfDocument(file);
  const maxPages = 80;
  if (pdf.numPages > maxPages) {
    throw new Error(`PDF is too long (${pdf.numPages} pages).`);
  }

  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      // @ts-ignore
      const pageText = textContent.items.map((item) => item.str).join(" ");
      fullText += `--- Page ${i} ---\n${pageText}\n\n`;
    } catch {
      fullText += `--- Page ${i} [Extraction Failed] ---\n\n`;
    }
  }

  if (fullText.length < 50) {
    throw new Error("PDF appears empty or contains only images.");
  }

  return fullText;
};

export const getPdfPageCount = async (file: File): Promise<number> => {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error("Presentation PDF is too large (max 25MB).");
  }
  const pdf = await getPdfDocument(file);
  return pdf.numPages;
};

export const convertPdfToImages = async (
  file: File,
  onProgress: (msg: string) => void,
  options?: PdfImageConversionOptions,
): Promise<string[]> => {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error("Presentation PDF is too large (max 25MB).");
  }

  const pdf = await getPdfDocument(file);
  const totalPages = pdf.numPages;
  const startPage = Math.max(1, options?.startPage ?? 1);
  const endPage = Math.min(totalPages, options?.endPage ?? totalPages);
  if (startPage > endPage) {
    throw new Error("Invalid page range requested for presentation conversion.");
  }
  const pageCountInRange = endPage - startPage + 1;
  const maxPagesPerRequest = 60;
  if (pageCountInRange > maxPagesPerRequest) {
    throw new Error(`Too many pages selected (${pageCountInRange}, max ${maxPagesPerRequest}).`);
  }

  const imagePromises: Promise<string>[] = [];
  onProgress(`Converting ${pageCountInRange} pages to images (pages ${startPage}-${endPage} of ${totalPages})...`);

  const pages = [];
  for (let i = startPage; i <= endPage; i++) {
    pages.push(await pdf.getPage(i));
  }

  await Promise.all(
    pages.map(async (page, index) => {
      const pageWithinRange = index + 1;
      const viewport = page.getViewport({ scale: options?.scale ?? 1.15 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (context) {
        await page.render({ canvasContext: context, viewport }).promise;
        imagePromises[index] = Promise.resolve(canvas.toDataURL("image/jpeg", options?.jpegQuality ?? 0.75));
      }
      onProgress(`Converted page ${pageWithinRange} of ${pageCountInRange}`);
    }),
  );

  return Promise.all(imagePromises);
};

export const renderPdfPagesHighQuality = async (
  file: File,
  pageNumbers: number[],
  options?: HighQualityRenderOptions,
): Promise<HighQualityRenderResult> => {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error("Presentation PDF is too large (max 25MB).");
  }

  const uniquePages = Array.from(
    new Set(
      pageNumbers
        .filter((value) => Number.isInteger(value))
        .map((value) => Number(value))
        .filter((value) => value > 0),
    ),
  ).sort((a, b) => a - b);

  if (uniquePages.length === 0) {
    return {
      imagesByPage: {},
      downgradedPages: [],
      failedPages: [],
    };
  }

  const pdf = await getPdfDocument(file);
  const pdfPageCount = pdf.numPages;
  const renderScale = options?.scale ?? 2.0;
  const maxPngChars = options?.pngDataUrlMaxChars ?? 4_800_000;
  const jpegFallbackQuality = options?.jpegFallbackQuality ?? 0.92;

  const imagesByPage: Record<number, string> = {};
  const downgradedPages: number[] = [];
  const failedPages: HighQualityRenderFailure[] = [];
  const total = uniquePages.length;

  for (let index = 0; index < uniquePages.length; index++) {
    const pageNumber = uniquePages[index];
    options?.onProgress?.({
      current: index + 1,
      total,
      pageNumber,
    });

    if (pageNumber > pdfPageCount) {
      failedPages.push({
        pageNumber,
        reason: `Page ${pageNumber} is out of range for a ${pdfPageCount}-page PDF.`,
      });
      continue;
    }

    try {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        failedPages.push({
          pageNumber,
          reason: "Unable to initialize canvas rendering context.",
        });
        continue;
      }

      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await page.render({ canvasContext: context, viewport }).promise;

      let imageDataUrl = canvas.toDataURL("image/png");
      if (imageDataUrl.length > maxPngChars) {
        imageDataUrl = canvas.toDataURL("image/jpeg", jpegFallbackQuality);
        downgradedPages.push(pageNumber);
      }

      imagesByPage[pageNumber] = imageDataUrl;

      canvas.width = 0;
      canvas.height = 0;
    } catch (error: any) {
      failedPages.push({
        pageNumber,
        reason: String(error?.message || "Unknown render failure."),
      });
    }
  }

  return {
    imagesByPage,
    downgradedPages,
    failedPages,
  };
};

// --- "The Chatter" Analysis ---

export const analyzeTranscript = async (
  transcript: string,
  provider: ProviderType = ProviderType.GEMINI,
  modelId: ModelType = ModelType.FLASH,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ChatterAnalysisResult> => {
  if (!transcript.trim()) {
    throw new Error("Transcript is empty.");
  }

  let progressInterval: ReturnType<typeof setInterval> | undefined;
  let index = 0;

  if (onProgress) {
    onProgress(transcriptProgressDefaults[0]);
    progressInterval = setInterval(() => {
      index = Math.min(index + 1, transcriptProgressDefaults.length - 1);
      onProgress(transcriptProgressDefaults[index]);
    }, 1500);
  }

  try {
    const result = await postJson<ChatterAnalysisResult>(CHATTER_ANALYZE_ENDPOINT, {
      provider,
      transcript,
      model: modelId,
    });

    onProgress?.({ stage: "complete", message: "Insights ready.", percent: 100 });
    return result;
  } catch (error) {
    onProgress?.({ stage: "error", message: "Analysis failed. Please retry.", percent: 100 });
    throw error;
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
    }
  }
};

// --- "Points & Figures" Analysis ---

export const analyzePresentation = async (
  pageImages: string[],
  onProgress: (msg: string) => void,
  pageOffset = 0,
  provider: ProviderType = ProviderType.GEMINI,
  modelId: ModelType = ModelType.FLASH,
  chunkRange?: { startPage: number; endPage: number },
): Promise<PointsAndFiguresResult> => {
  if (!Array.isArray(pageImages) || pageImages.length === 0) {
    throw new Error("No presentation pages found to analyze.");
  }

  onProgress("Analyzing slides with AI...");
  const result = await postJson<PointsAnalyzeApiResult>(POINTS_ANALYZE_ENDPOINT, {
    provider,
    pageImages,
    model: modelId,
    chunkStartPage: chunkRange?.startPage,
    chunkEndPage: chunkRange?.endPage,
  });

  if (!result.slides || result.slides.length === 0) {
    throw new Error("AI did not return any selected slides.");
  }

  const slidesWithImages: SelectedSlide[] = result.slides
    .map((slide) => {
      const pageIndex = slide.selectedPageNumber - 1;
      if (pageIndex < 0 || pageIndex >= pageImages.length) {
        return null;
      }
      return {
        ...slide,
        selectedPageNumber: slide.selectedPageNumber + pageOffset,
        pageAsImage: pageImages[pageIndex],
      };
    })
    .filter((slide): slide is SelectedSlide => Boolean(slide));

  if (slidesWithImages.length === 0) {
    throw new Error("AI returned invalid page numbers.");
  }

  const sortedSlides = slidesWithImages.sort((a, b) => a.selectedPageNumber - b.selectedPageNumber);

  return {
    companyName: result.companyName,
    fiscalPeriod: result.fiscalPeriod,
    nseScrip: result.nseScrip,
    marketCapCategory: result.marketCapCategory,
    industry: result.industry,
    companyDescription: result.companyDescription,
    zerodhaStockUrl: result.zerodhaStockUrl,
    slides: sortedSlides,
  };
};

export const ingestThreadEditionFromSubstackUrl = async (
  substackUrl: string,
): Promise<ThreadEditionSource> => {
  if (!substackUrl.trim()) {
    throw new Error("Substack URL is required.");
  }

  return postJson<ThreadEditionSource>(CHATTER_THREAD_INGEST_ENDPOINT, {
    substackUrl: substackUrl.trim(),
  });
};

export const ingestThreadEditionFromText = async (
  editionText: string,
): Promise<ThreadEditionSource> => {
  if (!editionText.trim()) {
    throw new Error("Edition text is required.");
  }

  return postJson<ThreadEditionSource>(CHATTER_THREAD_INGEST_ENDPOINT, {
    editionText: editionText.trim(),
  });
};

export const generateThreadDraft = async (
  selectedQuotes: ThreadQuoteCandidate[],
  editionMetadata: {
    editionTitle: string;
    editionUrl?: string;
    editionDate?: string;
    companiesCovered?: number;
    industriesCovered?: number;
  },
  provider: ProviderType = ProviderType.GEMINI,
  modelId: ModelType = ModelType.FLASH,
): Promise<ThreadDraftResult> => {
  if (!Array.isArray(selectedQuotes) || selectedQuotes.length === 0) {
    throw new Error("Select at least one quote to generate the thread.");
  }

  const result = await postJson<ThreadGenerateApiResult>(CHATTER_THREAD_GENERATE_ENDPOINT, {
    provider,
    model: modelId,
    selectedQuotes,
    editionMetadata,
  });

  if (!Array.isArray(result.insightTweets) || !result.introTweet || !result.outroTweet) {
    throw new Error("Thread generation returned an invalid payload.");
  }

  return {
    introTweet: result.introTweet,
    insightTweets: result.insightTweets.map((item) => ({
      quoteId: item.quoteId,
      tweet: item.tweet,
    })),
    outroTweet: result.outroTweet,
  };
};

export const regenerateThreadTweet = async (params: {
  tweetKind: "intro" | "insight" | "outro";
  currentTweet: string;
  usedTweetTexts: string[];
  editionMetadata: {
    editionTitle: string;
    editionUrl?: string;
    editionDate?: string;
  };
  targetQuote?: ThreadQuoteCandidate;
  provider?: ProviderType;
  modelId?: ModelType;
}): Promise<string> => {
  const provider = params.provider ?? ProviderType.GEMINI;
  const modelId = params.modelId ?? ModelType.FLASH;

  const result = await postJson<{ tweet: string }>(CHATTER_THREAD_REGENERATE_ENDPOINT, {
    provider,
    model: modelId,
    tweetKind: params.tweetKind,
    currentTweet: params.currentTweet,
    usedTweetTexts: params.usedTweetTexts,
    editionMetadata: params.editionMetadata,
    targetQuote: params.targetQuote,
  });

  if (!result?.tweet || typeof result.tweet !== "string") {
    throw new Error("Regenerated tweet is empty.");
  }

  return result.tweet;
};
