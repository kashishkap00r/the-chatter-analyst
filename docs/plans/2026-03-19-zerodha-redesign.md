# Chatter Analyst — Zerodha Brand Redesign

**Date:** 2026-03-19
**Status:** Approved for implementation
**Scope:** Full visual redesign of all 4 modes + tweet generator images

## Goal

Align the entire Chatter Analyst app to Zerodha's official brand guidelines. Move from the current glassy/gradient aesthetic to a clean, calm, Zerodha-compliant design while retaining subtle depth through tints and shadows allowed by the brand system.

## Design Decisions

- **Approach:** Zerodha-compliant with subtle depth — white dominant, subtle elevation shadows, soft blue tints for section differentiation
- **App name:** "Chatter Analyst" (unchanged)
- **Tweet images:** Text badge "The Chatter by Zerodha" only — no logo rendering
- **Header:** Simplified, no serif fonts

---

## 1. Color & Typography Foundation

### Colors

| Token | Current | New | Rationale |
|-------|---------|-----|-----------|
| brand | #387ED1 | #387ED1 | Already Zerodha blue |
| accent | #FFA412 | #FFA412 | Already Sunshine Yellow |
| ink | #132238 | #222222 | Zerodha heading color |
| stone | #5C6F88 | #666666 | Zerodha body text color |
| canvas | #EEF4FB | #FFFFFF | White default per guidelines |
| brand-soft | #EAF2FF | #F5F7FB | Lighter tint for differentiation |
| line | #D3DEEC | #E7E7E7 | Zerodha approved stroke |

### Typography

- **Font:** Inter exclusively (replace Manrope + Fraunces)
- **Self-host** Inter variable weight woff2
- **Sizes on 8pt scale:** 12px labels, 14px secondary, 16px body, 24px subheading, 32px heading
- **Line heights:** Rounded to 8px multiples (body ~24px, headings ~32px or 40px)
- **No all-caps anywhere** — "INPUT DESK" becomes "Input Desk"
- **Max 2 weights per composition:** Regular + Semibold (or Regular + Bold)

### Shadows

- Panel: `0 1px 3px rgba(213, 213, 213, 0.4)`
- Elevated: `0 4px 16px rgba(213, 213, 213, 0.4)`
- Shadow color #D5D5D5 at max 40% opacity, max 16px blur — per Zerodha spec

### Background

- Body: plain #FFFFFF
- Remove multi-layer gradient body background
- Remove grid overlay pseudo-element
- Keep very subtle brand-blue radial at top-left ~8% opacity for warmth

---

## 2. Header & Navigation

### Header
- White background, 1px bottom border #E7E7E7
- No gradients, no backdrop blur
- "Chatter Analyst" — Inter Semibold 24px, #222222
- "Research Workflow Studio" — Inter Regular 14px, #666666, no all-caps, no letter-spacing
- Blue "C" badge: flat solid #387ED1, white text, 8px radius, no gradient, no shadow

### Mode Tabs
- Container: white background, 1px #E7E7E7 border, 32px radius
- Active: #387ED1 background, white text, 8px radius, flat
- Idle: #666666 text, hover #222222
- No backdrop-filter, no gradient

### Controls
- Dropdowns: 1px #E7E7E7 border, 8px radius, white background
- Focus: 2px #387ED1 ring at 35% opacity
- Labels: Inter Medium 14px, #666666, no all-caps

---

## 3. Workspace Panels & Cards

### Studio Panels
- Background: #FFFFFF
- Border: 1px solid #E7E7E7
- Radius: 16px
- Shadow: `0 1px 3px rgba(213, 213, 213, 0.4)`
- Padding: 24px
- Remove: gradient fill, top-edge pseudo-element

### Section Headers
- Panel label: Inter Semibold 16px, #222222, no all-caps
- Panel title: Inter Bold 24px, #222222

### File Upload
- Dashed border: 1px dashed #E7E7E7
- Background: #FAFAFB
- Radius: 8px
- Hover: border → #387ED1 at 50%

### Buttons
- Primary: solid #387ED1, white text, 8px radius
- Ghost: white bg, 1px #E7E7E7 border, #666666 text, hover border → #387ED1
- Padding: 12px vertical, 24px horizontal (squish inset)

### Quote Cards
- #FFFFFF background, 1px #E7E7E7 border, 16px radius
- Category badges: lighter tints, no strong borders
- Quote text: Inter Regular 18px italic
- Speaker: Inter Semibold 14px, #387ED1
- Context box: #F5F7FB background, 8px radius

### Empty States
- #FAFAFB background, 1px dashed #E7E7E7, 16px radius
- Inter Regular 16px, #666666

---

## 4. Tracker Page

- White background
- "Coverage Tracker" — Inter Bold 24px, #222222
- Subtitle — Inter Regular 14px, #666666
- Summary cards: #F5F7FB, 16px radius, 1px #E7E7E7 border
- Chatter accent: 4px left border #387ED1
- P&F accent: 4px left border #FFA412
- Pending count: Inter Bold 32px
- Progress bars: 8px height, #E7E7E7 track, brand fill, 8px radius
- Company rows: 14px, 24px height, hover #FAFAFB
- Covered items: #999999 line-through

---

## 5. Tweet Generator Images (1200x675 Canvas)

- Background: #FFFFFF
- Top badge: "The Chatter by Zerodha" — Inter Bold 18px, white on #387ED1, 8px radius
- Company: Inter Bold 28px, #222222
- Industry: Inter Regular 18px, #666666
- Quote area: #F5F7FB, 16px rounded rect
- Quote text: Inter Bold, dynamic sizing, #222222
- Opening quote mark: #FFA412
- Speaker: Inter Semibold 22px, #387ED1
- Bottom accent: 3px #387ED1 line
- No gradients, no shadows — flat and clean
- Ensure `document.fonts.ready` before canvas render

---

## Files to Modify

### Core styling
- `tailwind.config.cjs` — update theme colors, fonts, shadows
- `styles.css` — replace font imports, rewrite component classes
- `index.html` — swap font preload links

### Components
- `App.tsx` — header, tabs, controls restyling
- `components/QuoteCard.tsx` — card styling
- `components/ThreadComposer.tsx` — thread UI styling
- `utils/threadImageExport.ts` — canvas colors, fonts, layout

### Feature workspaces
- `src/features/chatter/ChatterWorkspace.tsx`
- `src/features/points/pointsFeature.tsx` (9048 lines)
- `src/features/plotline/plotlineFeature.tsx` (13719 lines)
- `src/features/tracker/TrackerPage.tsx`
- `src/features/tracker/ChecklistPanel.tsx`

### Font assets
- Remove: `public/fonts/manrope-*.woff2`, `public/fonts/fraunces-*.woff2`
- Add: `public/fonts/inter-latin.woff2`, `public/fonts/inter-latin-ext.woff2`
