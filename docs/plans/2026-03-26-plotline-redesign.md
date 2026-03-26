# Plotline Redesign: Semantic Extraction + Claude Authoring

**Date:** 2026-03-26
**Status:** Approved (brainstormed with Kashish)

## Context

Plotlines was discontinued because the format never worked. The old editions were company-by-company quote dumps with narrative filler — essentially a themed Chatter, not a distinct editorial product.

The new vision: each Plotline edition picks one narrow thesis (e.g., "Quick commerce impact on FMCG distribution"), gathers management quotes from 5-8 companies across 2-3 quarters, and weaves them into a high-quote-density narrative essay where the quotes ARE the story and the narration is just connective tissue.

## Architecture Decision

The pipeline splits across two tools:

1. **Chatter Analyst (Gemini)** — extraction and curation. The research desk.
2. **Claude Code skill `/plotline-finder`** — brainstorms structure with the user, then writes the edition. The author.

The bridge is a copy-to-clipboard export: a clean, structured quote brief that the user pastes into Claude.

---

## Part 1: Chatter Analyst — Plotline Tab Redesign

### Input (changed)

**Remove:**
- Keyword input field (the entire keyword concept)

**Add:**
- Free-text **thesis textarea** — user describes what they're investigating in natural language
  - Example: "I want to understand how FMCG companies are responding to the rise of quick commerce. Specifically, how it's affecting their general trade distribution, whether they're seeing channel cannibalization, and if they're building separate strategies for quick commerce vs traditional retail."
- This thesis is sent to Gemini alongside each transcript for semantic extraction
- The thesis is included verbatim in the exported brief

**Keep:**
- Batch file upload (PDF/TXT, multi-company, multi-quarter)
- Provider/model selection (for extraction only)

### Extraction (major redesign)

**Remove entirely:**
- Keyword regex matching
- 600-char context windows
- Match window merging
- `buildKeywordRegex()`, `detectMatchedKeywords()`, all keyword dedup
- `PLOTLINE_EXTRACT_PROMPT` (replaced)
- All quote count caps: max 12 per company, max 120 total, max 80 windows, max 450 matches
- The extract prompt instruction to "keep output concise"

**New approach: full semantic extraction**
- Gemini receives: thesis description + full transcript
- Gemini reads both in full and returns every quote relevant to the thesis
- No keyword intermediary, no windowing, no regex
- Quotes that are tangentially relevant should also be included

**New extraction prompt requirements:**
- Understand the thesis deeply
- Find management quotes relevant to the thesis (exclude analyst questions)
- Return every relevant quote — no self-censoring, no consolidation
- Explicitly instruct: "Return all relevant quotes. Err on the side of inclusion. Do not limit count."
- For each quote: 2-3 sentence excerpt (context + quote + follow-up)
- Tag with: speaker name, designation, fiscal period label, period sort key
- Extract company metadata: name, NSE scrip, market cap, industry

**Keep:**
- Quote dedup by Jaccard similarity (across transcripts, same company) — still useful to catch identical quotes appearing in multiple transcripts
- Batch processing (sequential per-file with progress)
- Per-file progress tracking
- Company metadata extraction
- PDF-to-text parsing via pdf.js
- Retry logic with model fallback chain

### Curation UI (new)

After extraction completes across all transcripts, present all quotes for user curation.

**Layout:**
- Each quote is a card: quote text, speaker + designation, company name + scrip, fiscal period
- Checkbox/toggle on each card to include/exclude
- Default: all quotes selected, user deselects the weak ones

**Grouping toggle at the top:**
- "By Company" — all quotes from one company together, chronological within each
- "By Period" — all quotes from Q2 FY26 together, then Q3 FY26, etc.

**Quick actions:**
- "Deselect all from [Company]" — dismiss an entire company
- Counter: "23 of 31 quotes selected"

**No starring, no drag-and-drop, no reordering.** This is a filter step, not an editor.

### Export (new — replaces story generation)

**Format: Claude-ready brief, plain text, copy to clipboard.**

```
THEME
[User's original thesis description, verbatim]

COMPANIES COVERED
[Company Name (SCRIP) — Q2 FY26, Q3 FY26]
[Company Name (SCRIP) — Q3 FY26]
...

---

QUOTES

[Company Name] | [Fiscal Period]
Speaker: [Name], [Designation]
"[Full quote excerpt]"

[Company Name] | [Fiscal Period]
Speaker: [Name], [Designation]
"[Full quote excerpt]"

...
```

**Ordering:** Company-by-company, chronological within each company (oldest first).

**No company descriptions.** No narrative. No analysis. Just thesis + quotes.

**One-click "Copy to clipboard" button.** No download option.

### Backend Endpoints

**Delete:**
- `/api/plotline/summarize` — story planning
- `/api/plotline/write` — narrative generation

**Rewrite:**
- `/api/plotline/analyze` — new semantic extraction (thesis + full transcript)

**Keep:**
- Health check endpoints
- All chatter and points endpoints (unchanged)

### Prompt Deletions
- `PLOTLINE_PLAN_PROMPT` — gone
- `PLOTLINE_WRITE_PROMPT` — gone
- `PLOTLINE_PLAN_RESPONSE_SCHEMA` — gone
- `PLOTLINE_WRITE_RESPONSE_SCHEMA` — gone
- `PLOTLINE_EXTRACT_PROMPT` — replaced with new semantic version

### Code Deletions (frontend)
- Story display (title, dek, narrative paragraphs, watchlist, skipped companies)
- HTML/rich-text clipboard export (`plotlineCopyExport.ts` — rewrite for plain text brief)
- Auto-progression from extraction to planning to writing
- Keyword input component and all keyword state management
- `summarizePlotlineTheme()` and `writePlotlineStory()` in geminiService.ts

### Code Deletions (backend)
- `/functions/api/plotline/summarize.ts` — entire file
- `/functions/api/plotline/write.ts` — entire file
- All keyword-related functions in analyze.ts: `buildKeywordRegex()`, `detectMatchedKeywords()`, `dedupeKeywordEntries()`, window building, match scanning
- Fallback plan generation, fallback paragraph generation, fallback watchlist
- Plan normalization logic
- All constants: `MATCH_WINDOW_RADIUS`, `MAX_MATCH_WINDOWS`, `MAX_MATCH_SCAN_RESULTS`, `MAX_FILTERED_TRANSCRIPT_CHARS`, `MAX_KEYWORDS`, quote count caps

---

## Part 2: Claude Code Skill — `/plotline-finder`

### Purpose
The authoring half of the pipeline. User pastes the Claude-ready brief from Chatter Analyst, and this skill brainstorms the structure, then writes a publish-ready Plotline edition.

### Skill Behavior

**Step 1: Ingest**
- Detect the pasted brief (THEME + COMPANIES COVERED + QUOTES structure)
- Parse and count: how many companies, how many quotes, what time range
- Confirm: "I see X quotes from Y companies across Z quarters on [theme]. Let me read through them."

**Step 2: Brainstorm structure**
- Read all quotes, identify natural clusters
- Propose 2-3 structural options:
  - Thematic clustering (e.g., "The shift → Who's adapting → The holdouts")
  - Chronological arc (e.g., "Q2: early signals → Q3: acceleration → Q4: scramble")
  - Hybrid approaches
- For each option, show which quotes/companies would fall where
- Discuss with the user. Refine. Agree on structure.

**Step 3: Write the edition**
- **Opening:** 1-2 paragraph editorial setup framing the thesis
- **Body:** Quote clusters with narrative connective tissue
  - Quotes are the backbone — high density
  - Narrative between quotes provides context, builds the argument, connects dots
  - Medium glue: enough to explain why each quote matters and how it connects to the next
  - Quotes in blockquotes with speaker attribution and period label
- **Closing:** Brief editorial paragraph tying the threads together + "What to watch" forward-looking lines
- Target: 2,000-3,000 words for 5-8 companies

**Step 4: Learn**
- After the user reviews and edits, save learnings:
  - Structural preferences (did thematic or chronological work better?)
  - Tone feedback (too much narration? too little?)
  - Quote density preferences
  - What the user cut or rewrote
  - Thesis types that worked well
- Save to a session-learnings file that the skill reads on next invocation

### Editorial Voice Rules (baked into the skill)
- The quotes ARE the story. Narrative is connective tissue, not the main event.
- Medium glue between quotes: 1-3 sentences explaining context and connection
- Plain English, conversational. "Explaining to a smart friend over coffee."
- No jargon without immediate translation
- Be analytical, not neutral — the narrative should have a point of view
- Short sentences. Active voice.
- This is a Chatter edition, not a Daily Brief. Quote density >> prose density.

### Self-Learning Mechanism
- Reads `session-learnings.md` on every invocation
- Appends new learnings after each session
- Learnings file lives in the skill's directory
- Over time, accumulates editorial preferences, structural patterns that worked, tone calibrations

### Skill Location
- Install as a Claude Code skill: `/plotline-finder`
- Dependencies: none (just needs the pasted brief as input)

---

## Implementation Sequence

### Phase 1: Chatter Analyst Plotline Redesign
1. Replace keyword input with thesis textarea (frontend)
2. Rewrite `/api/plotline/analyze` — new semantic extraction prompt, remove keyword pipeline, remove quote caps
3. Build curation UI — quote cards with include/exclude toggles, grouping toggle, deselect-by-company
4. Build plain-text export — Claude-ready brief format, copy to clipboard
5. Delete dead code — summarize/write endpoints, prompts, schemas, frontend story display, keyword logic
6. Test end-to-end with real transcripts

### Phase 2: Claude Code Skill
7. Create `/plotline-finder` skill with editorial voice rules
8. Build session-learnings mechanism (read on invoke, save after session)
9. Test with real extracted briefs from the redesigned tool

---

## What Success Looks Like

- User describes a thesis in 2-3 sentences
- Feeds 5-15 transcripts across 2-3 quarters
- Gets a comprehensive dump of all relevant quotes (no artificial caps)
- Scans and curates in under 5 minutes
- Copies brief, pastes into Claude, brainstorms structure, gets a draft
- Draft is high-quote-density narrative essay, reads like a Plotline edition should
- Each session makes the next one better via learnings
