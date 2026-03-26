# Plotline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Plotline tab from keyword-based extraction + auto-story-generation into a thesis-driven semantic extraction tool with curation UI and Claude-ready clipboard export. Plus create a `/plotline-finder` Claude Code skill for authoring.

**Architecture:** The Plotline feature becomes a two-tool pipeline. Chatter Analyst (Gemini) handles semantic extraction and curation — user describes a thesis, feeds transcripts, Gemini finds all relevant quotes, user curates, copies a structured brief. Claude Code skill (`/plotline-finder`) handles authoring — brainstorms structure with user, writes the edition, learns from each session.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Cloudflare Pages Functions, Gemini API, Claude Code skills

---

## File Map

### Files to Create
- `functions/api/plotline/analyze.ts` — full rewrite (semantic extraction)
- `utils/plotlineCopyExport.ts` — full rewrite (plain text Claude-ready brief)
- `~/.claude/skills/plotline-finder/SKILL.md` — new Claude Code skill
- `~/.claude/skills/plotline-finder/session-learnings.md` — empty learnings file

### Files to Modify
- `types.ts` — replace plotline type definitions
- `functions/_shared/gemini.ts` — replace extract prompt/schema, delete plan/write prompts/schemas
- `services/geminiService.ts` — update analyze function, delete summarize/write functions
- `src/features/plotline/PlotlineWorkspace.tsx` — full rewrite (thesis input + curation UI)
- `src/features/plotline/usePlotlineFeature.ts` — full rewrite (new state shape, curation logic)
- `src/shared/state/sessionTypes.ts` — update PlotlineSessionSlice
- `src/shared/state/sessionPersistence.ts` — update plotline sanitizer
- `src/shared/state/sessionMigration.ts` — update plotline migration/validation

### Files to Delete
- `functions/api/plotline/summarize.ts`
- `functions/api/plotline/write.ts`

---

## Task 1: Update Type Definitions

**Files:**
- Modify: `types.ts:147-240`
- Modify: `src/shared/state/sessionTypes.ts:43-47`

- [ ] **Step 1: Replace plotline types in types.ts**

Replace lines 147-240 (everything from `// --- "Plotline" Types ---` to the end of `PlotlineNarrativeResult`) with:

```typescript
// --- "Plotline" Types ---

export interface PlotlineQuote {
  quoteId: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  periodLabel: string;
  periodSortKey: number;
  selected: boolean;
}

export interface PlotlineFileResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  quotes: PlotlineQuote[];
}

export interface PlotlineBatchFile {
  id: string;
  name: string;
  content: string;
  status: 'pending' | 'parsing' | 'ready' | 'analyzing' | 'complete' | 'error';
  result?: PlotlineFileResult;
  error?: string;
  progress?: ProgressEvent;
}

export interface PlotlineCompanyGroup {
  companyKey: string;
  companyName: string;
  nseScrip: string;
  industry: string;
  periods: string[];
  quotes: PlotlineQuote[];
}
```

Key changes:
- `PlotlineQuoteMatch` → `PlotlineQuote`: removed `matchedKeywords`, added `selected: boolean`
- `PlotlineFileResult`: removed `companyDescription` (not needed in export)
- Added `PlotlineCompanyGroup` for the curation view
- Deleted: `PlotlineCompanyResult`, `PlotlineStoryPlanSection`, `PlotlineStoryPlanResult`, `PlotlineStorySection`, `PlotlineSummaryResult`, `PlotlineNarrativeRequestCompany`, `PlotlineNarrativeResult`

- [ ] **Step 2: Update PlotlineSessionSlice in sessionTypes.ts**

Replace lines 43-47:

```typescript
export interface PlotlineSessionSlice {
  batchFiles: PlotlineBatchFile[];
  thesis: string;
  companyGroups: PlotlineCompanyGroup[];
}
```

Also update the import on line 1 — remove `PlotlineSummaryResult` from the import, add `PlotlineCompanyGroup`:

```typescript
import type {
  AppMode,
  BatchFile,
  ChatterAnalysisState,
  ModelType,
  PointsBatchFile,
  PlotlineBatchFile,
  PlotlineCompanyGroup,
  ProviderType,
  ProgressEvent,
} from '../../../types';
```

- [ ] **Step 3: Verify TypeScript compiles (expect errors in downstream files — that's expected)**

Run: `cd "/home/kashish.kapoor/vibecoding projects/chatter-analyst" && npx tsc --noEmit 2>&1 | head -30`

Expected: Errors in geminiService.ts, usePlotlineFeature.ts, PlotlineWorkspace.tsx, sessionMigration.ts, sessionPersistence.ts — these files still reference old types. This is fine; we'll fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add types.ts src/shared/state/sessionTypes.ts
git commit -m "refactor(plotline): replace type definitions for thesis-driven extraction"
```

---

## Task 2: Rewrite Backend — Extraction Prompt & Schema

**Files:**
- Modify: `functions/_shared/gemini.ts`

- [ ] **Step 1: Replace PLOTLINE_EXTRACT_PROMPT**

Find the existing `PLOTLINE_EXTRACT_PROMPT` (starts around line 483) and replace it with:

```typescript
export const PLOTLINE_EXTRACT_PROMPT = `
ROLE
You are a research analyst extracting evidence from an earnings call transcript for a thematic newsletter edition.

GOAL
The user has described a thesis or theme they are investigating. Your job is to read the full transcript and find every management quote that is relevant to that thesis — directly or tangentially.

INPUT
You will receive:
1) A thesis description — the user's narrative of what they are investigating
2) A full earnings call transcript

EXTRACTION RULES
- Include only management remarks. Exclude analyst questions.
- A quote is relevant if it connects to the thesis — it does not need to use exact words from the thesis.
- Cast a wide net. Include quotes that are tangentially relevant, offer useful context, or provide a contrasting perspective on the thesis.
- Return ALL relevant quotes. Do not limit, consolidate, or summarize. Err on the side of inclusion. If a company talks about the thesis extensively, return every distinct point they make.
- For each quote, return a paragraph-style excerpt of 2-3 sentences that preserves the full context:
  1) One sentence before the key statement (if available)
  2) The key statement itself
  3) One sentence after (if available)
- Do not paraphrase. Use the exact words from the transcript.
- If the transcript contains no quotes relevant to the thesis, return an empty quotes array.
- Infer periodLabel from transcript context (e.g., "Q3 FY26", "Mar'26").
- Infer periodSortKey as integer YYYYMM (e.g., for Mar'26 => 202603).
- If the same point is made in both prepared remarks and Q&A, keep both — the Q&A version often has more candid detail.

OUTPUT
- Return valid JSON with: companyName, fiscalPeriod, nseScrip, marketCapCategory, industry, quotes.
- nseScrip must be uppercase A-Z0-9 only.
- Each quote object: { quote, speakerName, speakerDesignation, periodLabel, periodSortKey }.
`.trim();
```

- [ ] **Step 2: Replace PLOTLINE_EXTRACT_RESPONSE_SCHEMA**

Find the existing `PLOTLINE_EXTRACT_RESPONSE_SCHEMA` (starts around line 156) and replace with:

```typescript
export const PLOTLINE_EXTRACT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyName: { type: "STRING" },
    fiscalPeriod: { type: "STRING" },
    nseScrip: { type: "STRING" },
    marketCapCategory: { type: "STRING" },
    industry: { type: "STRING" },
    quotes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          quote: { type: "STRING" },
          speakerName: { type: "STRING" },
          speakerDesignation: { type: "STRING" },
          periodLabel: { type: "STRING" },
          periodSortKey: { type: "INTEGER" },
        },
        required: [
          "quote",
          "speakerName",
          "speakerDesignation",
          "periodLabel",
          "periodSortKey",
        ],
      },
    },
  },
  required: [
    "companyName",
    "fiscalPeriod",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "quotes",
  ],
};
```

Key change: removed `matchedKeywords` from schema, removed `companyDescription`.

- [ ] **Step 3: Delete plan and write prompts/schemas**

Delete these exports entirely from gemini.ts:
- `PLOTLINE_PLAN_PROMPT` (around line 518-544)
- `PLOTLINE_WRITE_PROMPT` (around line 546-575)
- `PLOTLINE_PLAN_RESPONSE_SCHEMA` (around line 202-230)
- `PLOTLINE_WRITE_RESPONSE_SCHEMA` (around line 232-262)

- [ ] **Step 4: Commit**

```bash
git add functions/_shared/gemini.ts
git commit -m "refactor(plotline): semantic extraction prompt, remove plan/write prompts"
```

---

## Task 3: Rewrite Backend — analyze.ts

**Files:**
- Rewrite: `functions/api/plotline/analyze.ts`

The current file is 904 lines of keyword regex matching, window building, match scanning, dedup logic, and fallbacks. The new version is dramatically simpler: receive thesis + transcript, send both to Gemini, validate and return quotes.

- [ ] **Step 1: Rewrite analyze.ts**

Replace the entire file with:

```typescript
import {
  callGeminiJson,
  callOpenRouterJson,
  PLOTLINE_EXTRACT_PROMPT,
  PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
} from '../../_shared/gemini';

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface PlotlineAnalyzeRequest {
  thesis: string;
  transcript: string;
  provider: 'gemini' | 'openrouter';
  model: string;
}

interface PlotlineQuoteRaw {
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  periodLabel: string;
  periodSortKey: number;
}

interface PlotlineAnalyzeResponse {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  quotes: PlotlineQuoteRaw[];
}

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_THESIS_CHARS = 2_000;

const DEDUPE_STRONG_SIMILARITY = 0.88;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'will', 'would', 'about', 'there', 'their', 'into', 'our', 'your',
  'which', 'while', 'were', 'are', 'has', 'had', 'also', 'just', 'more',
  'than', 'they', 'them', 'over', 'some', 'such',
]);

const toTokenSet = (text: string): Set<string> => {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  return new Set(tokens.filter(t => t.length >= 3 && !STOP_WORDS.has(t)));
};

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  const union = a.size + b.size - overlap;
  return union > 0 ? overlap / union : 0;
};

const dedupeQuotes = (quotes: PlotlineQuoteRaw[]): PlotlineQuoteRaw[] => {
  const deduped: PlotlineQuoteRaw[] = [];
  for (const candidate of quotes) {
    const candidateTokens = toTokenSet(candidate.quote);
    let isDuplicate = false;
    for (const existing of deduped) {
      if (jaccardSimilarity(candidateTokens, toTokenSet(existing.quote)) >= DEDUPE_STRONG_SIMILARITY) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) deduped.push(candidate);
  }
  return deduped;
};

const sanitizeString = (value: unknown, maxLen: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
};

const sanitizeNseScrip = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
};

const clampPeriodSortKey = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(190001, Math.min(210012, Math.round(num)));
};

const sanitizeQuote = (raw: unknown): PlotlineQuoteRaw | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const quote = sanitizeString(r.quote, 1500);
  const speakerName = sanitizeString(r.speakerName, 200);
  const speakerDesignation = sanitizeString(r.speakerDesignation, 200);
  const periodLabel = sanitizeString(r.periodLabel, 30);
  const periodSortKey = clampPeriodSortKey(r.periodSortKey);
  if (!quote || !speakerName) return null;
  return { quote, speakerName, speakerDesignation, periodLabel, periodSortKey };
};

const buildUserContent = (thesis: string, transcript: string): string =>
  `THESIS\n${thesis}\n\nTRANSCRIPT\n${transcript}`;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const requestId = crypto.randomUUID().slice(0, 8);

  let body: PlotlineAnalyzeRequest;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { thesis, transcript, provider, model } = body;

  if (!thesis || typeof thesis !== 'string' || thesis.trim().length < 10) {
    return Response.json({ error: 'Thesis must be at least 10 characters.' }, { status: 400 });
  }
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 100) {
    return Response.json({ error: 'Transcript must be at least 100 characters.' }, { status: 400 });
  }

  const clampedThesis = thesis.trim().slice(0, MAX_THESIS_CHARS);
  const clampedTranscript = transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  const userContent = buildUserContent(clampedThesis, clampedTranscript);

  let result: PlotlineAnalyzeResponse;

  try {
    if (provider === 'openrouter') {
      const apiKey = context.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return Response.json({ error: 'OpenRouter API key not configured.' }, { status: 500 });
      }
      result = await callOpenRouterJson({
        apiKey,
        model,
        messageContent: [
          { type: 'text', text: PLOTLINE_EXTRACT_PROMPT },
          { type: 'text', text: userContent },
        ],
        requestId,
        referer: context.env.OPENROUTER_SITE_URL,
        appTitle: context.env.OPENROUTER_APP_TITLE,
      });
    } else {
      const apiKey = context.env.GEMINI_API_KEY;
      if (!apiKey) {
        return Response.json({ error: 'Gemini API key not configured.' }, { status: 500 });
      }
      result = await callGeminiJson({
        apiKey,
        vertexApiKey: context.env.VERTEX_API_KEY,
        model,
        contents: [
          { role: 'user', parts: [{ text: PLOTLINE_EXTRACT_PROMPT + '\n\n' + userContent }] },
        ],
        responseSchema: PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
        providerPreference: (context.env.GEMINI_PROVIDER as any) || 'ai_studio',
        requestId,
      });
    }
  } catch (error: any) {
    const message = error?.message || 'Unknown extraction error.';
    const isRetriable = /rate|limit|timeout|503|429|500/i.test(message);
    return Response.json(
      { error: message, retriable: isRetriable },
      { status: isRetriable ? 503 : 500 },
    );
  }

  // Sanitize response
  const companyName = sanitizeString(result.companyName, 200);
  const fiscalPeriod = sanitizeString(result.fiscalPeriod, 30);
  const nseScrip = sanitizeNseScrip(result.nseScrip);
  const marketCapCategory = sanitizeString(result.marketCapCategory, 30);
  const industry = sanitizeString(result.industry, 100);

  const rawQuotes = Array.isArray(result.quotes) ? result.quotes : [];
  const sanitizedQuotes = rawQuotes.map(sanitizeQuote).filter((q): q is PlotlineQuoteRaw => q !== null);
  const dedupedQuotes = dedupeQuotes(sanitizedQuotes);

  return Response.json({
    companyName,
    fiscalPeriod,
    nseScrip,
    marketCapCategory,
    industry,
    quotes: dedupedQuotes,
  });
};
```

Key changes from old file:
- 904 lines → ~170 lines
- No keyword regex, no window building, no match scanning
- Thesis + full transcript sent directly to Gemini
- Only dedup logic retained (Jaccard similarity for cross-transcript duplicates)
- No quote count caps

- [ ] **Step 2: Delete summarize.ts and write.ts**

```bash
rm "/home/kashish.kapoor/vibecoding projects/chatter-analyst/functions/api/plotline/summarize.ts"
rm "/home/kashish.kapoor/vibecoding projects/chatter-analyst/functions/api/plotline/write.ts"
```

- [ ] **Step 3: Commit**

```bash
git add functions/api/plotline/
git commit -m "refactor(plotline): semantic extraction endpoint, delete summarize+write"
```

---

## Task 4: Update Service Layer

**Files:**
- Modify: `services/geminiService.ts`

- [ ] **Step 1: Update analyzePlotlineTranscript function**

Find the `analyzePlotlineTranscript` function (around line 481) and replace it with:

```typescript
export const analyzePlotlineTranscript = async (
  transcript: string,
  thesis: string,
  provider: ProviderType = ProviderType.GEMINI,
  modelId: ModelType = ModelType.FLASH_3,
  onProgress?: (event: ProgressEvent) => void,
): Promise<PlotlineFileResult> => {
  if (!transcript.trim()) {
    throw new Error("Transcript is empty.");
  }
  if (!thesis.trim()) {
    throw new Error("Thesis description is required.");
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
    const result = await postJson<PlotlineAnalyzeApiResult>(PLOTLINE_ANALYZE_ENDPOINT, {
      provider,
      model: modelId,
      transcript,
      thesis,
    });

    if (!Array.isArray(result?.quotes)) {
      throw new Error("Plotline analysis returned an invalid payload.");
    }

    onProgress?.({ stage: "complete", message: "Plotline extraction ready.", percent: 100 });
    return {
      companyName: result.companyName,
      fiscalPeriod: result.fiscalPeriod,
      nseScrip: result.nseScrip,
      marketCapCategory: result.marketCapCategory,
      industry: result.industry,
      quotes: result.quotes.map((q: any) => ({
        ...q,
        quoteId: q.quoteId || '',
        selected: true,
      })),
    };
  } catch (error) {
    onProgress?.({ stage: "error", message: "Plotline extraction failed. Please retry.", percent: 100 });
    throw error;
  } finally {
    if (progressInterval) clearInterval(progressInterval);
  }
};
```

Key changes: `keywords: string[]` parameter → `thesis: string`, sends `thesis` instead of `keywords` in request body, maps quotes with `selected: true` default.

- [ ] **Step 2: Delete summarizePlotlineTheme and writePlotlineStory functions**

Remove both functions entirely (around lines 538-613). Also remove any type aliases they use if no longer referenced (e.g., `PlotlinePlanApiResult`, `PlotlineStoryApiResult`).

- [ ] **Step 3: Update imports at the top of geminiService.ts**

Remove imports for deleted types:
- `PlotlineStoryPlanResult`
- `PlotlineSummaryResult`
- `PlotlineNarrativeRequestCompany`

Ensure `PlotlineFileResult` and `PlotlineQuote` are imported from `types`.

Also remove endpoint constants:
- `PLOTLINE_SUMMARIZE_ENDPOINT`
- `PLOTLINE_WRITE_ENDPOINT`

- [ ] **Step 4: Commit**

```bash
git add services/geminiService.ts
git commit -m "refactor(plotline): update service layer for thesis-based extraction"
```

---

## Task 5: Rewrite Frontend — usePlotlineFeature.ts

**Files:**
- Rewrite: `src/features/plotline/usePlotlineFeature.ts`

This is the core state management hook. The new version removes all keyword/story state and adds thesis + curation state.

- [ ] **Step 1: Rewrite usePlotlineFeature.ts**

Replace the entire file. The new hook manages:
- `thesis` (string) — user's thesis text
- `batchFiles` (PlotlineBatchFile[]) — uploaded transcript files
- `companyGroups` (PlotlineCompanyGroup[]) — aggregated quotes grouped by company, built after extraction
- Curation actions: `toggleQuote`, `deselectCompany`, `selectAll`
- `groupingMode` ('company' | 'period') — UI toggle
- Copy-to-clipboard export

```typescript
import { useState, useRef, useCallback, useMemo } from 'react';
import type {
  PlotlineBatchFile,
  PlotlineCompanyGroup,
  PlotlineQuote,
  PlotlineFileResult,
  ProgressEvent,
} from '../../../types';
import { ProviderType, ModelType } from '../../../types';
import type { PlotlineSessionSlice } from '../../shared/state/sessionTypes';
import type { BatchProgressState } from '../../shared/state/sessionTypes';
import { analyzePlotlineTranscript, parsePdfToText } from '../../../services/geminiService';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

interface UsePlotlineFeatureParams {
  provider: ProviderType;
  selectedModel: ModelType;
}

export type PlotlineGroupingMode = 'company' | 'period';

export interface PlotlineFeatureController {
  // State
  thesis: string;
  plotlineBatchFiles: PlotlineBatchFile[];
  companyGroups: PlotlineCompanyGroup[];
  isAnalyzingPlotlineBatch: boolean;
  plotlineBatchProgress: BatchProgressState | null;
  groupingMode: PlotlineGroupingMode;
  plotlineCopyStatus: 'idle' | 'copied' | 'error';
  plotlineFileInputRef: React.RefObject<HTMLInputElement>;
  plotlineReadyCount: number;
  selectedQuoteCount: number;
  totalQuoteCount: number;

  // Actions
  setThesis: (value: string) => void;
  setGroupingMode: (mode: PlotlineGroupingMode) => void;
  handlePlotlineFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleAnalyzePlotlineBatch: () => Promise<void>;
  toggleQuote: (companyKey: string, quoteId: string) => void;
  deselectCompany: (companyKey: string) => void;
  selectAllQuotes: () => void;
  handleCopyBrief: () => Promise<void>;
  removePlotlineBatchFile: (id: string) => void;
  clearPlotline: () => void;

  // Session
  sessionSlice: PlotlineSessionSlice;
  restoreFromSessionSlice: (slice: PlotlineSessionSlice) => void;
}

const generateQuoteId = (companyKey: string, index: number, periodSortKey: number): string =>
  `${companyKey}-${periodSortKey}-${index}`;

const buildCompanyKey = (result: PlotlineFileResult): string =>
  result.nseScrip || result.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const aggregateCompanyGroups = (files: PlotlineBatchFile[]): PlotlineCompanyGroup[] => {
  const groupMap = new Map<string, PlotlineCompanyGroup>();

  for (const file of files) {
    if (file.status !== 'complete' || !file.result) continue;
    const result = file.result;
    const key = buildCompanyKey(result);

    let group = groupMap.get(key);
    if (!group) {
      group = {
        companyKey: key,
        companyName: result.companyName,
        nseScrip: result.nseScrip,
        industry: result.industry,
        periods: [],
        quotes: [],
      };
      groupMap.set(key, group);
    }

    if (result.fiscalPeriod && !group.periods.includes(result.fiscalPeriod)) {
      group.periods.push(result.fiscalPeriod);
    }

    for (let i = 0; i < result.quotes.length; i++) {
      const q = result.quotes[i];
      const quoteId = q.quoteId || generateQuoteId(key, group.quotes.length, q.periodSortKey);
      group.quotes.push({ ...q, quoteId, selected: q.selected ?? true });
    }
  }

  // Sort quotes chronologically within each group
  for (const group of groupMap.values()) {
    group.quotes.sort((a, b) => a.periodSortKey - b.periodSortKey);
    group.periods.sort();
  }

  // Sort groups by company name
  return Array.from(groupMap.values()).sort((a, b) =>
    a.companyName.localeCompare(b.companyName),
  );
};

const buildClipboardBrief = (thesis: string, groups: PlotlineCompanyGroup[]): string => {
  const selectedGroups = groups
    .map(g => ({
      ...g,
      quotes: g.quotes.filter(q => q.selected),
    }))
    .filter(g => g.quotes.length > 0);

  if (selectedGroups.length === 0) return '';

  const lines: string[] = [];

  lines.push('THEME');
  lines.push(thesis.trim());
  lines.push('');
  lines.push('COMPANIES COVERED');
  for (const g of selectedGroups) {
    const periods = [...new Set(g.quotes.map(q => q.periodLabel))].join(', ');
    lines.push(`${g.companyName} (${g.nseScrip}) — ${periods}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('QUOTES');

  for (const g of selectedGroups) {
    lines.push('');
    for (const q of g.quotes) {
      lines.push(`${g.companyName} | ${q.periodLabel}`);
      lines.push(`Speaker: ${q.speakerName}, ${q.speakerDesignation}`);
      lines.push(`"${q.quote}"`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const usePlotlineFeature = ({
  provider,
  selectedModel,
}: UsePlotlineFeatureParams): PlotlineFeatureController => {
  const [thesis, setThesis] = useState('');
  const [batchFiles, setBatchFiles] = useState<PlotlineBatchFile[]>([]);
  const [companyGroups, setCompanyGroups] = useState<PlotlineCompanyGroup[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [groupingMode, setGroupingMode] = useState<PlotlineGroupingMode>('company');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readyCount = useMemo(
    () => batchFiles.filter(f => f.status === 'ready').length,
    [batchFiles],
  );

  const totalQuoteCount = useMemo(
    () => companyGroups.reduce((sum, g) => sum + g.quotes.length, 0),
    [companyGroups],
  );

  const selectedQuoteCount = useMemo(
    () => companyGroups.reduce((sum, g) => sum + g.quotes.filter(q => q.selected).length, 0),
    [companyGroups],
  );

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList) return;

    const newFiles: PlotlineBatchFile[] = [];
    for (const file of Array.from(fileList)) {
      const id = crypto.randomUUID();
      const isPdf = file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        newFiles.push({ id, name: file.name, content: '', status: 'parsing', progress: undefined });
        try {
          const text = await parsePdfToText(file);
          newFiles[newFiles.length - 1] = { id, name: file.name, content: text, status: 'ready', progress: undefined };
        } catch (err: any) {
          newFiles[newFiles.length - 1] = { id, name: file.name, content: '', status: 'error', error: err.message, progress: undefined };
        }
      } else {
        const text = await file.text();
        newFiles.push({ id, name: file.name, content: text, status: 'ready', progress: undefined });
      }
    }

    setBatchFiles(prev => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleAnalyzeBatch = useCallback(async () => {
    if (!thesis.trim() || readyCount === 0) return;

    setIsAnalyzing(true);
    const readyFiles = batchFiles.filter(f => f.status === 'ready');
    const total = readyFiles.length;
    let completed = 0;
    let failed = 0;

    setBatchProgress({ total, completed: 0, failed: 0 });

    for (const file of readyFiles) {
      setBatchFiles(prev =>
        prev.map(f => f.id === file.id ? { ...f, status: 'analyzing' as const } : f),
      );
      setBatchProgress({ total, completed, failed, currentLabel: file.name });

      let attempt = 0;
      let success = false;

      while (attempt <= MAX_RETRIES && !success) {
        try {
          const result = await analyzePlotlineTranscript(
            file.content,
            thesis,
            provider,
            selectedModel,
            (progress: ProgressEvent) => {
              setBatchFiles(prev =>
                prev.map(f => f.id === file.id ? { ...f, progress } : f),
              );
            },
          );

          setBatchFiles(prev =>
            prev.map(f => f.id === file.id
              ? { ...f, status: 'complete' as const, result, progress: undefined }
              : f,
            ),
          );
          success = true;
          completed++;
        } catch (err: any) {
          attempt++;
          if (attempt > MAX_RETRIES) {
            setBatchFiles(prev =>
              prev.map(f => f.id === file.id
                ? { ...f, status: 'error' as const, error: err.message, progress: undefined }
                : f,
              ),
            );
            failed++;
          } else {
            await wait(RETRY_BASE_DELAY_MS * attempt);
          }
        }
      }

      setBatchProgress({ total, completed, failed });
    }

    // Aggregate after all files processed
    setBatchFiles(prev => {
      const groups = aggregateCompanyGroups(prev);
      setCompanyGroups(groups);
      return prev;
    });

    setIsAnalyzing(false);
  }, [thesis, batchFiles, readyCount, provider, selectedModel]);

  const toggleQuote = useCallback((companyKey: string, quoteId: string) => {
    setCompanyGroups(prev =>
      prev.map(g =>
        g.companyKey !== companyKey ? g : {
          ...g,
          quotes: g.quotes.map(q =>
            q.quoteId !== quoteId ? q : { ...q, selected: !q.selected },
          ),
        },
      ),
    );
  }, []);

  const deselectCompany = useCallback((companyKey: string) => {
    setCompanyGroups(prev =>
      prev.map(g =>
        g.companyKey !== companyKey ? g : {
          ...g,
          quotes: g.quotes.map(q => ({ ...q, selected: false })),
        },
      ),
    );
  }, []);

  const selectAllQuotes = useCallback(() => {
    setCompanyGroups(prev =>
      prev.map(g => ({
        ...g,
        quotes: g.quotes.map(q => ({ ...q, selected: true })),
      })),
    );
  }, []);

  const handleCopyBrief = useCallback(async () => {
    const brief = buildClipboardBrief(thesis, companyGroups);
    if (!brief) return;

    try {
      await navigator.clipboard.writeText(brief);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1800);
    } catch {
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('idle'), 3500);
    }
  }, [thesis, companyGroups]);

  const removeBatchFile = useCallback((id: string) => {
    setBatchFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const clearPlotline = useCallback(() => {
    setThesis('');
    setBatchFiles([]);
    setCompanyGroups([]);
    setIsAnalyzing(false);
    setBatchProgress(null);
    setCopyStatus('idle');
  }, []);

  const sessionSlice: PlotlineSessionSlice = useMemo(() => ({
    batchFiles,
    thesis,
    companyGroups,
  }), [batchFiles, thesis, companyGroups]);

  const restoreFromSessionSlice = useCallback((slice: PlotlineSessionSlice) => {
    setBatchFiles(slice.batchFiles || []);
    setThesis(slice.thesis || '');
    setCompanyGroups(slice.companyGroups || []);
  }, []);

  return {
    thesis,
    plotlineBatchFiles: batchFiles,
    companyGroups,
    isAnalyzingPlotlineBatch: isAnalyzing,
    plotlineBatchProgress: batchProgress,
    groupingMode,
    plotlineCopyStatus: copyStatus,
    plotlineFileInputRef: fileInputRef,
    plotlineReadyCount: readyCount,
    selectedQuoteCount,
    totalQuoteCount,
    setThesis,
    setGroupingMode,
    handlePlotlineFileUpload: handleFileUpload,
    handleAnalyzePlotlineBatch: handleAnalyzeBatch,
    toggleQuote,
    deselectCompany,
    selectAllQuotes,
    handleCopyBrief,
    removePlotlineBatchFile: removeBatchFile,
    clearPlotline,
    sessionSlice,
    restoreFromSessionSlice,
  };
};
```

- [ ] **Step 2: Commit**

```bash
git add src/features/plotline/usePlotlineFeature.ts
git commit -m "refactor(plotline): rewrite feature hook for thesis + curation"
```

---

## Task 6: Rewrite Frontend — PlotlineWorkspace.tsx

**Files:**
- Rewrite: `src/features/plotline/PlotlineWorkspace.tsx`

- [ ] **Step 1: Rewrite PlotlineWorkspace.tsx**

Replace the entire file. The new workspace has three sections:
1. **Input panel** (left): thesis textarea + file upload
2. **Curation panel** (right): quote cards with checkboxes, grouping toggle, deselect actions, copy button

```typescript
import type { PlotlineFeatureController } from './usePlotlineFeature';
import { AnalysisProgressPanel } from '../../../components/AnalysisProgressPanel';

interface PlotlineWorkspaceProps {
  feature: PlotlineFeatureController;
  disabled: boolean;
}

export const PlotlineWorkspace = ({ feature, disabled }: PlotlineWorkspaceProps) => {
  const hasResults = feature.companyGroups.length > 0;
  const canAnalyze = feature.thesis.trim().length >= 10 && feature.plotlineReadyCount > 0 && !feature.isAnalyzingPlotlineBatch;

  return (
    <div className="flex gap-6 items-start w-full max-w-[1280px] mx-auto">
      {/* Input Panel */}
      <div className="w-[440px] shrink-0 bg-white rounded-z-md shadow-panel p-6 flex flex-col gap-5">
        <div>
          <p className="text-xs text-stone uppercase tracking-wider mb-1">Input Desk</p>
          <h2 className="text-2xl font-medium text-gray-900">Plotline Input</h2>
        </div>

        {/* Thesis Textarea */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700">Thesis / Theme</label>
          <textarea
            className="w-full h-32 p-3 rounded-z-sm border border-line text-sm text-gray-900 resize-y placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            placeholder="Describe what you're investigating. E.g., 'How FMCG companies are responding to quick commerce — channel cannibalization, distribution restructuring, and separate QC strategies.'"
            value={feature.thesis}
            onChange={(e) => feature.setThesis(e.target.value)}
            disabled={disabled || feature.isAnalyzingPlotlineBatch}
          />
          <p className="text-xs text-stone">
            {feature.thesis.trim().length < 10
              ? `${10 - feature.thesis.trim().length} more characters needed`
              : 'Gemini will find all quotes relevant to this thesis'}
          </p>
        </div>

        {/* File Upload */}
        <div>
          <div
            className="border-2 border-dashed border-blue-200 bg-blue-50/30 rounded-z-sm p-6 text-center cursor-pointer hover:bg-blue-50/60 transition"
            onClick={() => !disabled && feature.plotlineFileInputRef.current?.click()}
          >
            <p className="text-sm text-gray-600">Drop or select transcript files</p>
            <p className="text-xs text-stone mt-1">Supports PDF and TXT</p>
            <input
              ref={feature.plotlineFileInputRef as any}
              type="file"
              accept=".pdf,.txt"
              multiple
              className="hidden"
              onChange={feature.handlePlotlineFileUpload}
              disabled={disabled || feature.isAnalyzingPlotlineBatch}
            />
          </div>
        </div>

        {/* File Queue */}
        <div className="border border-line rounded-z-sm p-3 min-h-[48px]">
          {feature.plotlineBatchFiles.length === 0 ? (
            <p className="text-sm text-stone text-center">No files queued yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {feature.plotlineBatchFiles.map((file) => (
                <li key={file.id} className="flex items-center justify-between text-sm">
                  <span className="truncate max-w-[260px]">{file.name}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${
                      file.status === 'complete' ? 'text-green-600' :
                      file.status === 'error' ? 'text-red-500' :
                      file.status === 'analyzing' ? 'text-brand' :
                      'text-stone'
                    }`}>
                      {file.status === 'complete' ? `✓ ${file.result?.quotes.length ?? 0} quotes` :
                       file.status === 'error' ? '✗ Error' :
                       file.status === 'analyzing' ? 'Analyzing…' :
                       file.status === 'parsing' ? 'Parsing…' :
                       'Ready'}
                    </span>
                    {(file.status === 'ready' || file.status === 'error') && (
                      <button
                        className="text-xs text-stone hover:text-red-500 transition"
                        onClick={() => feature.removePlotlineBatchFile(file.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-1">
          <button
            className="text-sm text-stone hover:text-gray-700 transition"
            onClick={feature.clearPlotline}
            disabled={disabled || feature.isAnalyzingPlotlineBatch}
          >
            Clear
          </button>
          <button
            className="flex-1 py-2.5 rounded-z-sm text-sm font-medium text-white bg-brand hover:bg-brand/90 transition disabled:opacity-50"
            onClick={feature.handleAnalyzePlotlineBatch}
            disabled={!canAnalyze || disabled}
          >
            {feature.isAnalyzingPlotlineBatch
              ? 'Analyzing…'
              : `Analyze ${feature.plotlineReadyCount} File${feature.plotlineReadyCount !== 1 ? 's' : ''}`}
          </button>
        </div>

        {feature.plotlineBatchProgress && feature.isAnalyzingPlotlineBatch && (
          <AnalysisProgressPanel progress={feature.plotlineBatchProgress} />
        )}
      </div>

      {/* Curation Panel */}
      <div className="flex-1 min-w-0">
        {!hasResults ? (
          <div className="bg-gray-50 rounded-z-md p-10 text-center">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Ready for Plotline</h3>
            <p className="text-sm text-stone max-w-md mx-auto">
              Describe your thesis, upload transcript files, and run extraction. You'll curate the quotes here before copying.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Curation Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {feature.selectedQuoteCount} of {feature.totalQuoteCount} quotes selected
                </h3>
                <div className="flex items-center gap-1 bg-gray-100 rounded-z-sm p-0.5">
                  <button
                    className={`px-3 py-1 text-xs rounded-z-sm transition ${
                      feature.groupingMode === 'company'
                        ? 'bg-white shadow-sm text-gray-900'
                        : 'text-stone hover:text-gray-700'
                    }`}
                    onClick={() => feature.setGroupingMode('company')}
                  >
                    By Company
                  </button>
                  <button
                    className={`px-3 py-1 text-xs rounded-z-sm transition ${
                      feature.groupingMode === 'period'
                        ? 'bg-white shadow-sm text-gray-900'
                        : 'text-stone hover:text-gray-700'
                    }`}
                    onClick={() => feature.setGroupingMode('period')}
                  >
                    By Period
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 text-xs text-stone hover:text-gray-700 transition"
                  onClick={feature.selectAllQuotes}
                >
                  Select All
                </button>
                <button
                  className="px-4 py-2 text-sm font-medium text-white bg-brand rounded-z-sm hover:bg-brand/90 transition disabled:opacity-50"
                  onClick={feature.handleCopyBrief}
                  disabled={feature.selectedQuoteCount === 0}
                >
                  {feature.plotlineCopyStatus === 'copied' ? 'Copied!' :
                   feature.plotlineCopyStatus === 'error' ? 'Copy Failed' :
                   'Copy Brief'}
                </button>
              </div>
            </div>

            {/* Quote Groups */}
            {feature.groupingMode === 'company' ? (
              feature.companyGroups.map((group) => (
                <CompanyQuoteGroup
                  key={group.companyKey}
                  group={group}
                  onToggle={feature.toggleQuote}
                  onDeselectAll={feature.deselectCompany}
                />
              ))
            ) : (
              <PeriodQuoteGroups
                groups={feature.companyGroups}
                onToggle={feature.toggleQuote}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ---- Sub-components ---- */

const CompanyQuoteGroup = ({
  group,
  onToggle,
  onDeselectAll,
}: {
  group: import('../../../types').PlotlineCompanyGroup;
  onToggle: (companyKey: string, quoteId: string) => void;
  onDeselectAll: (companyKey: string) => void;
}) => {
  const selectedCount = group.quotes.filter(q => q.selected).length;

  return (
    <div className="bg-white rounded-z-md shadow-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-base font-semibold text-gray-900">
            {group.companyName}
            <span className="ml-2 text-xs text-stone font-normal">{group.nseScrip} · {group.industry}</span>
          </h4>
          <p className="text-xs text-stone mt-0.5">
            {group.periods.join(', ')} · {selectedCount}/{group.quotes.length} selected
          </p>
        </div>
        <button
          className="text-xs text-stone hover:text-red-500 transition"
          onClick={() => onDeselectAll(group.companyKey)}
        >
          Deselect All
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {group.quotes.map((quote) => (
          <QuoteCard
            key={quote.quoteId}
            quote={quote}
            companyKey={group.companyKey}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
};

const PeriodQuoteGroups = ({
  groups,
  onToggle,
}: {
  groups: import('../../../types').PlotlineCompanyGroup[];
  onToggle: (companyKey: string, quoteId: string) => void;
}) => {
  // Flatten all quotes with company info, sort by period
  const allQuotes = groups.flatMap(g =>
    g.quotes.map(q => ({ ...q, companyKey: g.companyKey, companyName: g.companyName, nseScrip: g.nseScrip })),
  );
  allQuotes.sort((a, b) => a.periodSortKey - b.periodSortKey);

  // Group by periodLabel
  const periodMap = new Map<string, typeof allQuotes>();
  for (const q of allQuotes) {
    const existing = periodMap.get(q.periodLabel) || [];
    existing.push(q);
    periodMap.set(q.periodLabel, existing);
  }

  return (
    <>
      {Array.from(periodMap.entries()).map(([period, quotes]) => (
        <div key={period} className="bg-white rounded-z-md shadow-panel p-5">
          <h4 className="text-base font-semibold text-gray-900 mb-4">{period}</h4>
          <div className="flex flex-col gap-3">
            {quotes.map((q) => (
              <QuoteCard
                key={q.quoteId}
                quote={q}
                companyKey={q.companyKey}
                companyLabel={`${q.companyName} (${q.nseScrip})`}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
};

const QuoteCard = ({
  quote,
  companyKey,
  companyLabel,
  onToggle,
}: {
  quote: import('../../../types').PlotlineQuote;
  companyKey: string;
  companyLabel?: string;
  onToggle: (companyKey: string, quoteId: string) => void;
}) => (
  <label
    className={`flex gap-3 p-3 rounded-z-sm border cursor-pointer transition ${
      quote.selected
        ? 'border-brand/30 bg-blue-50/30'
        : 'border-line bg-gray-50/50 opacity-60'
    }`}
  >
    <input
      type="checkbox"
      checked={quote.selected}
      onChange={() => onToggle(companyKey, quote.quoteId)}
      className="mt-1 shrink-0 accent-brand"
    />
    <div className="flex-1 min-w-0">
      {companyLabel && (
        <p className="text-xs text-brand font-medium mb-1">{companyLabel}</p>
      )}
      <p className="text-sm text-gray-800 leading-relaxed">{quote.quote}</p>
      <p className="text-xs text-stone mt-1.5">
        — {quote.speakerName}{quote.speakerDesignation ? `, ${quote.speakerDesignation}` : ''}
        <span className="ml-2">{quote.periodLabel}</span>
      </p>
    </div>
  </label>
);
```

- [ ] **Step 2: Update plotlineFeature.tsx re-export**

Read and update `src/features/plotline/plotlineFeature.tsx` to export the new types:

```typescript
export { PlotlineWorkspace } from './PlotlineWorkspace';
export { usePlotlineFeature } from './usePlotlineFeature';
export type { PlotlineFeatureController, PlotlineGroupingMode } from './usePlotlineFeature';
```

- [ ] **Step 3: Commit**

```bash
git add src/features/plotline/
git commit -m "refactor(plotline): rewrite workspace with thesis input + curation UI"
```

---

## Task 7: Rewrite Export Utility

**Files:**
- Rewrite: `utils/plotlineCopyExport.ts`

- [ ] **Step 1: Replace plotlineCopyExport.ts**

The export function is now embedded in usePlotlineFeature.ts as `buildClipboardBrief()`. This file can be simplified to just re-export it, or deleted if not imported elsewhere.

Check if any file imports from `utils/plotlineCopyExport.ts`:

```bash
grep -r "plotlineCopyExport" "/home/kashish.kapoor/vibecoding projects/chatter-analyst/src/" "/home/kashish.kapoor/vibecoding projects/chatter-analyst/components/"
```

If only imported by the old PlotlineWorkspace or usePlotlineFeature, delete the file:

```bash
rm "/home/kashish.kapoor/vibecoding projects/chatter-analyst/utils/plotlineCopyExport.ts"
```

- [ ] **Step 2: Commit**

```bash
git add utils/
git commit -m "chore(plotline): remove old copy export utility"
```

---

## Task 8: Update Session Persistence & Migration

**Files:**
- Modify: `src/shared/state/sessionPersistence.ts`
- Modify: `src/shared/state/sessionMigration.ts`

- [ ] **Step 1: Update sessionPersistence.ts**

Replace the plotline section of `buildPersistableSession` (lines 149-153). The sanitizer no longer needs to handle `summary` or `keywords`:

Replace:
```typescript
  plotline: {
    ...snapshot.plotline,
    batchFiles: snapshot.plotline.batchFiles.map((file) => sanitizePlotlineBatchFile(file)),
    summary: sanitizePlotlineSummary(snapshot.plotline.summary),
  },
```

With:
```typescript
  plotline: {
    batchFiles: snapshot.plotline.batchFiles.map((file) => sanitizePlotlineBatchFile(file)),
    thesis: snapshot.plotline.thesis || '',
    companyGroups: snapshot.plotline.companyGroups || [],
  },
```

Also delete `sanitizePlotlineSummary` function (lines 133-136) and remove `PlotlineSummaryResult` from imports. Add `PlotlineCompanyGroup` to imports.

- [ ] **Step 2: Update sessionMigration.ts**

Replace `normalizePlotlineSlice` (lines 278-294):

```typescript
const normalizePlotlineSlice = (candidate: Record<string, unknown>): PlotlineSessionSlice => {
  const batchFiles = toArray<PlotlineBatchFile>(candidate.batchFiles).map(normalizeRecoveredPlotlineFile);
  const thesis = typeof candidate.thesis === 'string' ? candidate.thesis : '';
  const companyGroups = toArray<PlotlineCompanyGroup>(candidate.companyGroups);

  return {
    batchFiles,
    thesis,
    companyGroups,
  };
};
```

Also update `normalizeLegacyV1Session` (lines 342-374) — the plotline section:

```typescript
    plotline: {
      batchFiles: candidate.plotlineBatchFiles,
      thesis: '',
      companyGroups: [],
    },
```

Delete `isValidPlotlineSummary` function (lines 170-195), `isValidPlotlineQuote` (lines 156-168), `normalizeKeyword` (lines 150-154), and `MAX_PLOTLINE_KEYWORDS` constant (line 52).

Update imports: remove `PlotlineQuoteMatch`, `PlotlineSummaryResult`. Add `PlotlineCompanyGroup`.

- [ ] **Step 3: Commit**

```bash
git add src/shared/state/
git commit -m "refactor(plotline): update session persistence for thesis + companyGroups"
```

---

## Task 9: Update App.tsx

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Update App.tsx for new PlotlineFeatureController interface**

The `usePlotlineFeature` hook now returns a different interface. The main changes in App.tsx:

1. The hook call stays the same (just `provider` and `selectedModel` params)
2. The `PlotlineWorkspace` component still receives `feature` and `disabled` — no change needed
3. The `sessionSlice` property still exists on the controller — no change needed
4. `restoreFromSessionSlice` still exists — no change needed

Verify by reading App.tsx and confirming no direct references to `plotlineKeywords`, `plotlineSummary`, or other removed fields exist outside the hook.

If any references exist, update them. If not, no changes needed.

- [ ] **Step 2: Build and verify**

```bash
cd "/home/kashish.kapoor/vibecoding projects/chatter-analyst" && npm run build 2>&1 | tail -20
```

Expected: Build succeeds or shows minor type errors to fix.

- [ ] **Step 3: Fix any remaining TypeScript errors**

Address any errors from the build step. Common issues:
- Stale imports referencing deleted types
- `AnalysisProgressPanel` props mismatch (check if its interface changed)
- `parsePdfToText` import in usePlotlineFeature (ensure it's exported from geminiService)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(plotline): fix build errors, verify full compilation"
```

---

## Task 10: Create /plotline-finder Claude Code Skill

**Files:**
- Create: `~/.claude/skills/plotline-finder/SKILL.md`
- Create: `~/.claude/skills/plotline-finder/session-learnings.md`

- [ ] **Step 1: Create skill directory and SKILL.md**

Create `/home/kashish.kapoor/.claude/skills/plotline-finder/SKILL.md`:

```markdown
---
name: plotline-finder
description: Use when writing a Plotline edition for The Chatter newsletter — takes a curated quote brief (from Chatter Analyst tool), brainstorms cluster structure with the user, then writes a high-quote-density narrative essay. Self-learning — improves with each session.
---

# Plotline Finder

Write Plotline editions for The Chatter by Zerodha. Takes a curated brief of management quotes organized by company and writes a focused, thesis-driven narrative essay where the quotes are the story.

---

## Automatic Learning Loop

**This runs silently every session. The user never needs to invoke it.**

### On skill load (start of session):

1. Read `/home/kashish.kapoor/.claude/skills/plotline-finder/session-learnings.md` — if it exists, treat every entry as a **hard rule** equal in authority to this skill. Recent entries override older ones on the same topic.

### During the session — feedback detection:

Whenever the user gives feedback on the draft — corrections, preferences, approvals, rewrites, or any reaction to your output — **immediately and silently** append a learning to `session-learnings.md`. Do NOT ask permission. Do NOT announce you're saving. Just do it.

**Feedback signals to watch for:**
- Structure preferences: "I liked the chronological approach", "group by sub-theme instead"
- Tone corrections: "too much narration", "more quotes, less text", "tighter"
- Quote handling: "weave that quote in differently", "that quote doesn't belong here"
- Approvals: "this section is perfect", "yes, exactly like this"
- Rejections: "no", "try again", "not what I wanted"
- Style directions: "more conversational", "too formal", "explain that simply"

**Append format:**
```
### [YYYY-MM-DD] Topic
**Trigger:** What the user said (verbatim or paraphrased)
**Rule:** The generalized principle for future sessions
```

---

## Workflow

### Step 1: Ingest the Brief

The user will paste a structured brief from the Chatter Analyst tool. It looks like this:

```
THEME
[Thesis description]

COMPANIES COVERED
Company Name (SCRIP) — Q2 FY26, Q3 FY26
...

---

QUOTES

Company Name | Q3 FY26
Speaker: Name, Designation
"Quote text"

...
```

When you receive this:
1. Parse it — count companies, quotes, time periods
2. Confirm: "I see X quotes from Y companies across Z quarters on [theme]. Let me read through all of them."
3. Read every quote carefully. Identify natural clusters, narrative threads, tensions, and evolution over time.

### Step 2: Brainstorm Structure

Present 2-3 structural options. For each option, show:
- The proposed sections/clusters with names
- Which companies fall where
- The narrative arc (how the argument builds)

**Structural approaches to consider:**
- **Thematic clustering**: Group by what the quotes say (e.g., "Acknowledging the shift" → "Adapting the playbook" → "The holdouts")
- **Chronological arc**: Show how the conversation evolved across quarters (e.g., "Q2: Early signals" → "Q3: Acceleration")
- **Hybrid**: Mix of thematic and chronological
- **Contrarian framing**: Lead with the surprising angle, use quotes to build the case

Ask the user which structure they prefer, or if they want to modify. Discuss. Iterate until they approve.

### Step 3: Write the Edition

**Structure:**
1. **Opening** (1-2 paragraphs): Frame the thesis. Set up what the reader is about to learn. Why this matters now.
2. **Body** (quote clusters with connective tissue): The quotes build the argument. The narration connects them.
3. **Closing** (1 paragraph + what to watch): Tie the threads together. 3-5 forward-looking lines.

**Target:** 2,000-3,000 words for 5-8 companies.

---

## Editorial Voice — THE RULES

These are non-negotiable. They define what makes a Plotline a Plotline and not a Daily Brief.

### The quotes ARE the story
- Quotes are the backbone. They carry 70%+ of the content weight.
- The narrative is connective tissue between quotes — context, transitions, and "why this matters."
- If you find yourself writing 3+ sentences without a quote, you're doing it wrong. Pull back.

### This is NOT the Daily Brief
- The Daily Brief explains and analyzes with its own voice, using quotes as supporting evidence.
- Plotlines does the opposite: quotes speak, the narration merely bridges and contextualizes.
- Never write a paragraph that could stand on its own without the quotes around it. The narration should feel incomplete without the quotes — because it is.

### Connective tissue style
Between quotes, use 1-3 sentences that:
- Explain WHY the previous quote matters ("This isn't just a metro story anymore.")
- Set up the NEXT quote ("And it's forcing a rethink even for companies built on distribution depth.")
- Add context the reader needs ("Two quarters ago, quick commerce was a rounding error outside the top 8 cities.")

### Tone
- Plain English. Conversational. Like explaining to a smart friend over coffee.
- Short sentences. Active voice. Concrete nouns.
- No jargon without immediate translation.
- Be analytical, not neutral — the narrative should have a point of view.
- No hype, no hedging, no weasel words.

### Quote formatting
Every quote must be in a blockquote with attribution:

> "Quote text here."
>
> — Speaker Name, Designation, Company Name | Period

### Opening rules
- Frame the thesis in 1-2 paragraphs
- Make the reader understand why this matters RIGHT NOW
- End the opening with a transition that pulls into the first quote cluster

### Closing rules
- One paragraph tying the threads together — what's the takeaway?
- "What to Watch" section: 3-5 specific, forward-looking lines
- Each "watch" item should be concrete and time-bound where possible

---

## Anti-Patterns — NEVER DO THESE

- **Don't write a Daily Brief**: If your narration could be published without the quotes, you've written a Daily Brief, not a Plotline. Start over.
- **Don't summarize quotes**: Never say "Company X said they are focusing on AI" and then show the quote saying the same thing. The quote should reveal new information, not repeat the narration.
- **Don't use filler transitions**: No "Moving on to...", "Let's now look at...", "Another company that..."
- **Don't over-narrate**: If the quotes flow naturally from one to the next, you don't need narration between them. Silence is fine.
- **Don't editorialize after quotes**: Don't explain what a quote "means" when it's already clear. Trust the reader.
- **Don't cluster by company**: This is The Chatter's format. Plotlines clusters by thesis, not by company. A company can appear in multiple clusters.

---

## Output Format

Present the draft in clean markdown:
- H2 for the title
- Italic for the dek/subtitle
- Blockquotes for all management quotes with attribution
- H3 for section headers (if using them)
- Bulleted list for "What to Watch"

After presenting, ask: "How does this look? Any sections to tighten, restructure, or quotes to swap?"
```

- [ ] **Step 2: Create empty session-learnings.md**

Create `/home/kashish.kapoor/.claude/skills/plotline-finder/session-learnings.md`:

```markdown
# Plotline Finder — Session Learnings

Learnings are appended automatically after each session. Recent entries override older ones on the same topic.

---
```

- [ ] **Step 3: Commit skill files**

```bash
cd /home/kashish.kapoor && git -C .claude/skills/plotline-finder init 2>/dev/null; echo "done"
```

(Skills don't need a git repo — they're read directly by Claude Code.)

---

## Task 11: End-to-End Verification

- [ ] **Step 1: Build the project**

```bash
cd "/home/kashish.kapoor/vibecoding projects/chatter-analyst" && npm run build
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 2: Start dev server and test**

```bash
cd "/home/kashish.kapoor/vibecoding projects/chatter-analyst" && npm run dev
```

Open `http://localhost:3000`, navigate to Plotline tab. Verify:
- Thesis textarea appears (no keyword input)
- File upload works
- Can type a thesis (10+ chars enables analyze button)
- Points & Figures and Chatter tabs still work (no regression)

- [ ] **Step 3: Test with a real transcript**

Upload a real earnings call transcript PDF. Enter a thesis. Run analysis. Verify:
- Quotes appear in the curation panel
- Checkboxes work (toggle individual, deselect company, select all)
- Grouping toggle switches between Company and Period views
- "Copy Brief" produces the correct plain-text format in clipboard

- [ ] **Step 4: Test the skill**

In a new Claude Code session, type `/plotline-finder` and paste a sample brief. Verify:
- Skill loads correctly
- Brainstorms structure as expected
- Writes in the correct editorial voice

- [ ] **Step 5: Final commit**

```bash
cd "/home/kashish.kapoor/vibecoding projects/chatter-analyst"
git add -A
git commit -m "feat(plotline): complete redesign — thesis extraction + curation + /plotline-finder skill"
```
