# Plotline Story-First Design (2026-02-26)

## Goal
Shift Plotline from "quote list + narrative add-on" to a Daily Brief-style integrated story where narrative and evidence are woven together. Quotes remain verbatim management evidence and appear inline as indented evidence blocks.

## Editorial Contract
- One consolidated story, not separate sections for narrative and quotes.
- Story rotates company-by-company using soft subheads.
- Company order is by narrative strength (strongest signal first).
- Per company: 2-4 narrative paragraphs and 2-3 embedded quote blocks.
- Global length target: 1000-1400 words.
- Chronology is conditional:
  - multi-period evidence -> evolution framing
  - same-quarter evidence -> cross-company strategic contrast
- Weak-evidence companies are skipped.
- Ending is forward-looking: 3-5 "what to watch" lines.

## Pipeline
### Pass A: Evidence Extraction (existing endpoint)
- Keep current keyword-led extraction and dedupe.
- Standardize quote IDs before planning.
- Preserve period labels and sort keys for chronology logic.

### Pass B: Story Planner (new planner output)
- Input: validated company evidence + keywords.
- Output: title, dek, ordered section plan, company subheads, section quote IDs, skipped companies, chronology mode.
- If planner fails, use deterministic fallback planner in app logic.

### Pass C: Story Writer (new writer output)
- Input: planner output + full evidence map.
- Output: section narrative paragraphs + selected quote IDs + closing watchlist.
- Server rehydrates quote IDs to verbatim quote blocks to prevent hallucinated quote text.
- If writer fails, return deterministic fallback story using planner + evidence blocks.

## UX & Progress
- Plotline progress explicitly shows pass stages:
  - Pass 1/3: Extracting evidence
  - Pass 2/3: Planning story arc
  - Pass 3/3: Writing integrated story
- Final output panel renders one continuous story with inline quote blocks.
- Copy action exports a publish-ready story (HTML + plain text).

## Validation
- Quote IDs in plan/writer must exist in evidence map.
- Sections without valid evidence are dropped.
- Minimum story quality guardrails:
  - at least one section
  - each section has narrative and quote blocks
  - forward-looking close present
