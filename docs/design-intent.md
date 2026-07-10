# Design Intent

**Status:** COMPLETE — P1, P2, P3 all shipped. **Owner:** —

## Problem

Initial site generation is design-rich: the Claude designer (`packages/ai/src/designers/claude.ts`)
receives the full brief, constraints, theme tokens, inspiration analysis, and an explicit
"Aesthetic Direction" section it commits to and executes. That committed direction is then
**thrown away** — only the raw theme tokens (colors/fonts) survive in `settings.theme`.

Every subsequent AI edit (`buildChatSystemPrompt` in `apps/api/src/routes/ai.ts` + the edit
tools in `ai-write-tools.ts`) runs on the leftovers: business basics + theme tokens + a
truncated view of the current page. It is missing the constraints (they live in
`brief.constraints` but were never passed to chat), the inspiration analysis, and any
aesthetic direction. `update_html_block` edits a single block blind to its siblings, and
image generation during edits is generic. Result: edits make locally-plausible changes that
drift from the global design intent — the classic failure mode of AI site builders.

The fix is to **capture the realized design intent as a durable artifact** and reference it
on every edit, not just at first generation.

## The artifact

`DesignIntent` — a small (~250–400 token) structured doc, persisted at `settings.designIntent`.

```ts
interface DesignIntent {
  aestheticDirection: string; // north-star paragraph: the executed look in plain language
  voiceAndTone: string;       // copy voice ("confident, plain-spoken, benefit-led; short headlines")
  layoutPrinciples: string;   // section rhythm, dark/light alternation, asymmetry, whitespace, cards
  imageryStyle: string;       // photographic vs illustrated, mood, subject, treatment
  colorAndType: string;       // when accent is used, heading treatment — complements theme tokens
  constraints: string[];      // mirrors brief.constraints, kept here so every edit sees the bans
  positioning?: string;       // differentiators to reinforce in copy
  version: number;
  updatedAt: string;
  source: "generated" | "refined" | "user-edited";
}
```

Theme tokens persist *what colors*; DesignIntent persists *why and how* — the thing edits
currently re-guess.

## Capture (when + how)

A dedicated synthesis call **after the homepage generates** — the homepage is the design
anchor, and it's the moment all context exists *and* the aesthetic has been executed. Inputs:
brief + constraints + theme + the **actual generated homepage HTML**. Output: `DesignIntent`.

- Hooked server-side in the `design-page` handler when the page is the homepage, so it's
  automatic (no client orchestration change).
- Structured output via the existing `parse-brief`/`extract-brief` pattern: `router.generateText`
  with a JSON-shape system prompt, then parse + validate. (Anthropic structured outputs /
  forced tool use is a later hardening once the router supports those params.)
- Routed through the router's **primary/strong tier** — it runs once per site and anchors every
  downstream edit, so this is the wrong place to economize. The call is small regardless.
- If the homepage-first feedback gate ships, re-synthesize after the approved feedback round.

## Storage

`settings.designIntent` (sibling of `theme`/`brief`). No migration (jsonb). **Stripped from the
public `/site` response** — internal guidance, never served to visitors.

## Injection (the payoff)

- **Chat system prompt** (`buildChatSystemPrompt`): a `## DESIGN INTENT — every change must stay
  consistent with this` block **plus the constraints** (currently missing from chat). One change
  covers all tool-based edits, since they inherit this prompt.
- **`update_html_block`:** additionally load the immediate neighbor blocks so a section edit
  matches its surroundings (kills single-block myopia).
- **Subsequent page generation** (`claude.ts` designer): pass `designIntent` so pages 2..N match
  the homepage.
- **Image generation:** enrich prompts with `imageryStyle` + `voiceAndTone` + palette.

## Caching strategy

Prompt caching is a prefix match (render order `tools → system → messages`; any byte change in
the prefix invalidates everything after). Reorder `buildChatSystemPrompt`:

- **Stable prefix (cached):** persona + theme tokens + design intent + constraints. Deterministic
  — no timestamps/UUIDs/unsorted JSON.
- **Volatile suffix (after the cache breakpoint):** existing-content list, nav menus, current-page
  block previews, the user turn.

The prefix must clear the model's minimum cacheable size (Sonnet 4.6 = 2048, Opus 4.8 = 4096
tokens; persona+theme+intent likely does). Net: the design-intent doc rides in a cached prefix →
negligible per-turn cost.

**Provider-agnostic caching (important).** Caching is enabled *without* coupling the route layer
to Anthropic. The router options carry a provider-neutral hint — `cachedSystemPrefix?: string`
(`packages/ai/src/types.ts`) — expressing intent ("this part is stable"), not a mechanism. Each
provider translates it: the Claude provider emits two system blocks with `cache_control:
{type:"ephemeral"}` on the prefix; other providers simply prepend it (or use their own caching).
Business logic (`buildChatSystemPrompt` returns `{cachedPrefix, volatile}`) never references
`cache_control`. Caching is a transparent optimization, never a behavioral dependency — a provider
switch that ignores the hint loses the savings, never breaks correctness. Same discipline applies
to any future Anthropic-specific feature (e.g. structured outputs → a neutral `responseSchema?`
option): keep the mechanism inside the provider, behind a neutral hint.

## Freshness (evolving memory)

Don't freeze at gen-1:
- An **`update_design_intent` tool** the chat calls when the user expresses a *global* direction
  change ("make it bolder/darker") — so the doc evolves with the user.
- **User-editable** in the admin (like the brief-constraints field) — to correct "the AI keeps
  forgetting we're X."

(Auto-resynthesis on a material theme change is a possible later mechanism; explicit signals
first.)

## Phases

- **P1 (core) — DONE:** schema + capture-after-homepage + persist + inject into chat (with
  constraints) + caching reorder. Fixes most drift on its own. (commits cdd98b1, e818a1e)
- **P2 — DONE:** subsequent-page generation + image-prompt enrichment + sibling-block context.
  (commits 2dabfc3, 2c8b835)
  - Subsequent-page generation: `DesignPageInput.designIntent` flows to the Claude designer,
    which emits an "ESTABLISHED DESIGN DIRECTION — MATCH THIS" block. Wired both the onboarding
    `design-page` path and the chat `create_page` tool path. Homepage skips it (no intent yet).
  - Image-prompt enrichment: `WriteToolContext.designIntent` + `enrichImagePrompt()` append
    imageryStyle / voiceAndTone / palette to `generate_image` and `create_content` featured-image
    prompts.
  - Sibling-block context: `get_html_block` now appends a preview of the immediate neighbor
    blocks (above/below) so a single-block edit matches its surroundings.
- **P3 — DONE:** freshness. (commit 3207b09)
  - `update_design_intent` chat tool (admin+, `ai-write-tools.ts`): the AI patches the intent on a
    *global* direction change (bumps version, `source="refined"`), then applies it to the current
    page. The chat system prompt instructs the protocol; one-off edits leave the intent alone.
  - Admin editor (Settings → Design Direction, `SiteSettings.tsx`): `GET`/`PUT
    /sites/:id/design-intent` (`source="user-edited"`). Intent stays stripped from public `/site`.
  - Shared `mergeDesignIntent()` (`lib/design-intent.ts`) centralizes version/timestamp/source
    bookkeeping across synthesis, tool, and REST paths.

## Implementation map (as shipped)

- **Type:** `packages/shared/src/types/design-intent.ts`.
- **Synthesis + merge:** `apps/api/src/lib/design-intent.ts` (`synthesizeAndPersistDesignIntent`,
  `mergeDesignIntent`, `DESIGN_INTENT_TEXT_FIELDS`).
- **Capture hook:** `runDesignPage` in `apps/api/src/routes/ai.ts` (homepage only, fire-and-forget).
- **Chat injection + caching:** `buildChatSystemPrompt` returns `{cachedPrefix, volatile}`; the
  Claude provider marks the prefix cacheable via the neutral `cachedSystemPrefix` hint.
- **Designer injection:** `DesignPageInput.designIntent` → `buildSystemPrompt` "ESTABLISHED DESIGN
  DIRECTION" block (`packages/ai/src/designers/claude.ts`).
- **Edit-time images:** `WriteToolContext.designIntent` + `enrichImagePrompt()`.
- **Sibling context:** `get_html_block` (`apps/api/src/lib/ai-read-tools.ts`) appends neighbor blocks.
- **Freshness:** `update_design_intent` tool + `GET`/`PUT /sites/:id/design-intent` + admin UI.

## Decisions (locked)

1. Capture after homepage now; re-synthesize after feedback if/when the homepage-feedback gate ships.
2. JSON-parse synthesis now; Anthropic structured outputs as later hardening.
3. Synthesis on the strong/primary model tier.
4. Freshness = tool + user-edit (P3); no auto-resynth initially.
5. Caching enabled via a provider-neutral `cachedSystemPrefix` hint (Claude marks it cacheable;
   others prepend) — abstraction stays intact, provider switches stay smooth.
