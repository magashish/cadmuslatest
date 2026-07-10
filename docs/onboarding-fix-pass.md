# Onboarding Fix Pass — Design Doc

Status: **Draft, post-launch.** Not in scope for the 2026-05-08 release. Intended branch: `feature/onboarding-fix-pass`.

## Goal

After Stitch generates a site at onboarding, run a pass that scans every generated page for *obvious* shortcomings and either:

1. **Auto-fixes** them in place when the answer is unambiguous, or
2. **Surfaces an insight** when the fix needs the user's input (real email address, real product link, etc.).

Net effect: a freshly onboarded site has working buttons, valid forms, no `href="#"`, no `Lorem ipsum` — and the user sees a small list of "things that need your input" rather than a wall of broken UI.

## Why now (and why not at launch)

Stitch produces visually polished pages but its HTML is full of orphan widgets — buttons with no link, inputs not in a form, "Add to Calendar" text with no calendar wired up. Today the user discovers these one click at a time, which directly undermines our "AI-native, just works" positioning.

This is post-launch because (a) the launch path already works end-to-end without it, and (b) the pattern library only sharpens once we've seen real Stitch output across many site briefs. Shipping it earlier risks baking in detectors for problems we haven't actually seen.

## Where it hooks in

Two integration points, same pass:

1. **End of `runApplyStitchScreen`** in `apps/api/src/routes/ai.ts` — runs once per page during onboarding, after blocks are written.
2. **End of `runDesignPageTool`** in `apps/api/src/routes/ai.ts` — same pass for any post-onboarding page design.

Run the pass *after* the blocks land in the DB so detectors operate on the same content the user will see, and so auto-fixes go through the regular update_html_block path (same audit log, same undo).

## Architecture

```
packages/shared/src/onboarding-fixpass/
  index.ts              — runFixPass(siteId, contentId): Promise<FixPassResult>
  detectors/
    empty-link.ts
    placeholder-text.ts
    unwrapped-input.ts
    add-to-calendar.ts  — example pattern detector
    ...
  patterns/
    email-signup.ts     — fix template
    contact-form.ts
    ...
  types.ts              — Detector, Fix, Insight interfaces
```

### Detector contract

```ts
interface Detector {
  id: string;                          // "empty-link", "lorem-ipsum"
  scan(block: ContentBlock, ctx: ScanContext): Finding[];
}

interface Finding {
  detectorId: string;
  blockId: string;
  selector: string;                    // CSS path inside the block's html
  severity: "auto-fix" | "needs-input";
  fix?: Fix;                           // present iff severity === "auto-fix"
  insight?: Omit<Insight, "id">;       // present iff severity === "needs-input"
}

interface Fix {
  description: string;                 // what we did, for the audit log
  apply(html: string): string;         // pure, deterministic
}
```

Detectors are pure scanners against a single block's parsed HTML. The fix pass orchestrator calls each detector, applies all `auto-fix` findings via `update_html_block` (one update per block, batched), and inserts the `needs-input` findings into the existing `ai_insights` pipeline so they appear in the AI panel.

### Decision rule: auto-fix vs insight

Default to **insight, not auto-fix**. Auto-fix only when *all* of the following hold:

- The fix is fully determined by what's already on the site (e.g. a `Contact Us` button → link to the existing `/contact` page; a `Sign Up` button → link to `/signup` if it exists).
- Wrong answer is recoverable by Undo (which it is — every auto-fix runs through `update_html_block`).
- No third-party data needed (no real email, no real Stripe link, no real social URL).

When in doubt, make it an insight. The cost of a misleading auto-fix is much higher than the cost of one extra insight in the panel.

## Initial detector list (v1 of the pass)

These are the ones we already know are common from the Stitch output we've seen. Start here, add more as patterns surface.

| Detector | What it catches | Auto-fix? |
| --- | --- | --- |
| `empty-link` | `<a href="#">`, `href=""`, `href="javascript:void(0)"` | Auto-fix if anchor text matches an existing page slug; else insight |
| `placeholder-text` | `Lorem ipsum`, `Your text here`, `[Edit this]` | Insight |
| `unwrapped-input` | `<input>`, `<textarea>` not inside a `<form>` | Auto-fix: wrap in a `<form>` that posts to a no-op endpoint we provide; record as insight so user can wire it to a real handler |
| `mailto-placeholder` | `mailto:hello@example.com`, `mailto:your@email.com` | Insight (needs real address) |
| `placeholder-image` | `<img src="https://placehold.co/...">` and similar | Insight (needs real upload) |
| `social-icon-empty` | Social-icon elements with no href | Auto-fix from `siteSettings.socialLinks` if set; else insight |
| `add-to-calendar` | Button text matches /add to calendar/i with no working link | Insight tagged for the future Events add-on |
| `buy-now-empty` | Button text matches /(buy now|add to cart|checkout)/i with no link | Insight tagged for the future Commerce add-on |

## Pattern library

Patterns are reusable HTML+behavior templates the auto-fixer can splice in. v1 of the library is small:

- **Email signup form** — `<form>` wrapping an email input + submit button, posting to a Cadmus-provided collect-emails endpoint we already own.
- **Contact form** — name + email + message, posting to the same endpoint with a different `formType`.
- **Generic form wrapper** — for `unwrapped-input`: wraps loose inputs in a noop form so they at least submit cleanly.

Each pattern exports `{ id, html, requires: { endpoint?, settings? } }` so future detectors can compose them.

## Relationship to the add-on system

The fix pass is the **seed**, not the implementation, of the add-on marketplace.

- v1 of the fix pass surfaces add-on-shaped patterns (`add-to-calendar`, `buy-now-empty`) as insights. It does *not* activate add-ons.
- A later track decides what "activate the Events add-on" means — schema, UI, billing tier, code-sandbox boundary. That's a separate design doc.
- The detector library written for v1 is what tells us *which* add-ons are worth building first: whichever insight categories show up most across real onboarded sites.

Don't build the add-on system inside this branch. Keep the fix pass purely additive and reversible.

## What's out of scope for v1

- **Visual / layout fixes.** No "this hero is too tall," no contrast checks. Stick to broken functionality.
- **Cross-page fixes.** Each page is scanned in isolation. No "this page links to a page that doesn't exist."
- **Add-on activation.** Insights only.
- **AI-driven detectors.** All v1 detectors are deterministic regex + DOM walks. AI judgment (e.g. "this button doesn't make sense for a yoga studio") comes later, if at all.
- **Re-running on edits.** Fix pass runs at onboarding and on `design_page`. Editing a block in the admin doesn't re-trigger it.

## Open questions

- **Insight de-dup.** If the same page has 12 placeholder images, do we emit 12 insights or one rolled-up insight? Lean toward one with a count, but needs UI agreement.
- **Auto-fix audit trail.** Each auto-fix goes through `update_html_block`, so it's already in `ai_history` and Undo-able. Decide whether the user sees these as a single "Onboarding cleanup" turn (probably yes — keeps the history clean) or one entry per fix.
- **Failure mode.** If a detector throws, the pass should log and continue. Never block onboarding because of a fix-pass bug.

## Suggested first PR on the branch

Just the scaffolding:

1. `packages/shared/src/onboarding-fixpass/` skeleton with `Detector` / `Finding` types.
2. One detector (`empty-link`) end-to-end with tests.
3. Wire-up at the end of `runApplyStitchScreen` behind a feature flag that defaults off in prod.
4. No UI changes — insights land in the existing panel.

Everything else is incremental from there.
