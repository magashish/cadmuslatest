/**
 * Shared client-side form submission handler.
 * Handles both FormBlock forms (.form__container) and Stitch HTML forms (.stitch-section form).
 *
 * Optionally wires Cloudflare Turnstile spam protection when the site has the
 * "turnstile-spam-protection" add-on active — signalled by a
 * `data-turnstile-sitekey` attribute on <body> (set by BaseLayout).
 */

// Minimal Turnstile API surface we rely on. The real object is injected on
// `window` by Cloudflare's script.
type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; size?: string }) => string;
  getResponse: (widgetId?: string) => string | undefined;
  reset: (widgetId?: string) => void;
};

function getTurnstile(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

// Per-form Turnstile widget ids, populated once the script renders each widget.
const turnstileWidgets = new WeakMap<HTMLFormElement, string>();
// Forms awaiting a widget render, with the container we injected for each.
const pendingTurnstileForms: { form: HTMLFormElement; container: HTMLElement }[] = [];
let turnstileScriptRequested = false;

function getApiUrl(): string {
  return document.body.dataset.apiUrl || "";
}

function getSiteId(): string {
  return document.body.dataset.siteId || "";
}

function getTurnstileSitekey(): string | undefined {
  return document.body.dataset.turnstileSitekey || undefined;
}

function getFieldLabel(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): string | undefined {
  // Prefer the native labels collection (covers <label for="..."> and wrapping <label>)
  const labels = (el as HTMLInputElement).labels;
  const source = labels && labels.length > 0
    ? labels[0]
    : el.closest("label");
  if (!source) return undefined;
  // textContent includes nested elements' text (e.g. the required asterisk).
  // Strip the input's own value so we don't echo what the user typed back as the label.
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
  const text = clone.textContent?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

// Surface an error under the form, reusing/creating the shared .form__error box.
function showFormError(form: HTMLFormElement, message: string): void {
  let errDiv = form.querySelector<HTMLElement>(".form__error");
  if (!errDiv) {
    errDiv = document.createElement("div");
    errDiv.className = "form__error";
    errDiv.style.cssText = "margin-top:0.75rem;padding:0.75rem;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#dc2626;font-size:0.9rem";
    form.appendChild(errDiv);
  }
  errDiv.textContent = message;
}

async function handleSubmit(form: HTMLFormElement) {
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"], .form__submit, button:not([type="button"]):not([type="reset"])');
  const originalText = submitBtn?.textContent || "Submit";

  const restoreSubmit = () => {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  };

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
  }

  // Turnstile token gate. Only enforced when the widget script actually loaded —
  // if it was blocked (ad-blocker), we submit without a token and let the server
  // decide, so those visitors aren't hard-blocked here.
  let turnstileToken: string | undefined;
  const sitekey = getTurnstileSitekey();
  if (sitekey) {
    const ts = getTurnstile();
    if (ts) {
      const widgetId = turnstileWidgets.get(form);
      const token = widgetId ? ts.getResponse(widgetId) : undefined;
      if (!token) {
        restoreSubmit();
        showFormError(form, "Please complete the spam check.");
        return;
      }
      turnstileToken = token;
    }
  }

  // Gather field data from FormData (requires name attributes). Strip the
  // honeypot so it never lands in the submitted fields object. File inputs
  // (form-file-uploads add-on) are collected separately and sent as multipart
  // parts — stringifying a File would submit "[object File]".
  const formData = new FormData(form);
  const honeypot = (formData.get("_hp") ?? "").toString();
  const fields: Record<string, string> = {};
  const files: Array<{ field: string; file: File }> = [];
  formData.forEach((value, key) => {
    if (key === "_hp") return;
    // Turnstile injects a hidden `cf-turnstile-response` input into the widget
    // container; keep it out of the submitted fields.
    if (key === "cf-turnstile-response" || key === "g-recaptcha-response") return;
    if (value instanceof File) {
      if (value.size > 0) files.push({ field: key, file: value });
      return;
    }
    fields[key] = value.toString();
  });

  // Fallback: if FormData is empty (e.g. Stitch forms without name attrs),
  // collect values from all visible inputs/textareas/selects
  if (Object.keys(fields).length === 0) {
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea, select"
    ).forEach((el, i) => {
      if (!el.value.trim()) return;
      const key = el.name
        || getFieldLabel(el)
        || el.getAttribute("aria-label")
        || el.id
        || el.getAttribute("placeholder")
        || el.type
        || `field_${i + 1}`;
      fields[key] = el.value;
    });
  }

  // File inputs without a name attribute never appear in FormData — collect
  // them directly so hand-authored HTML forms can still attach files.
  form.querySelectorAll<HTMLInputElement>("input[type=file]:not([name])").forEach((el, i) => {
    const key = getFieldLabel(el) || el.getAttribute("aria-label") || el.id || `file_${i + 1}`;
    for (const file of el.files ?? []) {
      if (file.size > 0) files.push({ field: key, file });
    }
  });

  // Determine form identifier — prefer block ID from parent stitch-section, then form's own attribute
  const parentSection = form.closest("[data-form-identifier]");
  const formIdentifier = form.dataset.formIdentifier
    || parentSection?.getAttribute("data-form-identifier")
    || `html:${form.closest("[data-section]")?.getAttribute("data-section") || "unknown"}`;

  try {
    const payload = {
      formIdentifier,
      fields,
      sourceUrl: window.location.href,
      honeypot,
      renderedAt: Number(form.dataset.renderedAt) || undefined,
      turnstileToken,
    };

    // With attachments, switch to multipart: a `payload` part carrying the
    // same JSON plus `file:<fieldName>` parts. No Content-Type header — the
    // browser sets it with the multipart boundary.
    let res: Response;
    if (files.length > 0) {
      const mp = new FormData();
      mp.append("payload", JSON.stringify(payload));
      for (const { field, file } of files) mp.append(`file:${field}`, file, file.name);
      res = await fetch(`${getApiUrl()}/api/public/forms/submit`, {
        method: "POST",
        headers: { "x-site-id": getSiteId() },
        body: mp,
      });
    } else {
      res = await fetch(`${getApiUrl()}/api/public/forms/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-site-id": getSiteId(),
        },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Submission failed" }));
      throw new Error((err as { error?: string }).error || "Submission failed");
    }

    // Post-submit behavior — check form first, then parent section (for Stitch forms)
    const redirectUrl = form.dataset.redirectUrl || parentSection?.getAttribute("data-redirect-url");
    if (redirectUrl) {
      window.location.href = redirectUrl;
      return;
    }

    // Show success message
    const msg = form.dataset.successMessage || parentSection?.getAttribute("data-success-message") || "Thank you for your submission!";
    form.innerHTML = `<div class="form__success" style="padding:2rem;text-align:center;font-size:1.1rem;color:#16a34a">${msg}</div>`;
  } catch (err) {
    restoreSubmit();
    // Turnstile tokens are single-use — reset so the visitor can retry.
    const widgetId = turnstileWidgets.get(form);
    if (widgetId) getTurnstile()?.reset(widgetId);
    showFormError(form, err instanceof Error ? err.message : "Something went wrong. Please try again.");
  }
}

function stampRenderedAt(form: HTMLFormElement) {
  if (!form.dataset.renderedAt) form.dataset.renderedAt = Date.now().toString();
}

// Inject a managed Turnstile widget container just above the form's submit
// button (or at the end of the form if none is found). The actual widget is
// rendered once Cloudflare's script loads (see renderPendingTurnstileWidgets).
function addTurnstileWidget(form: HTMLFormElement) {
  if (form.querySelector(".cadmus-turnstile")) return;
  const container = document.createElement("div");
  container.className = "cadmus-turnstile";
  container.style.margin = "0.75rem 0";

  const submitBtn = form.querySelector<HTMLElement>(
    'button[type="submit"], .form__submit, button:not([type="button"]):not([type="reset"])'
  );
  if (submitBtn && submitBtn.parentElement) {
    submitBtn.parentElement.insertBefore(container, submitBtn);
  } else {
    form.appendChild(container);
  }
  pendingTurnstileForms.push({ form, container });
}

function renderPendingTurnstileWidgets(sitekey: string) {
  const ts = getTurnstile();
  if (!ts) return;
  for (const { form, container } of pendingTurnstileForms) {
    if (turnstileWidgets.has(form)) continue;
    try {
      const id = ts.render(container, { sitekey, size: "normal" });
      turnstileWidgets.set(form, id);
    } catch {
      // Ignore render failures for a single widget; submit will fall back to
      // the no-token path and let the server decide.
    }
  }
}

function injectTurnstileScript(sitekey: string) {
  if (turnstileScriptRequested) return;
  turnstileScriptRequested = true;

  const CALLBACK = "onCadmusTurnstileLoad";
  (window as unknown as Record<string, () => void>)[CALLBACK] = () =>
    renderPendingTurnstileWidgets(sitekey);

  const script = document.createElement("script");
  script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${CALLBACK}&render=explicit`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

// Stitch sometimes emits newsletter signups as a bare input[type=email] + button
// without a wrapping <form>. Pages imported before the import-time fix shipped
// won't have a <form> in their HTML, so wrap orphan email-capture patterns at
// runtime by renaming the smallest enclosing element (in .stitch-section) that
// contains both the input and a button.
function changeTag(el: HTMLElement, newTag: string): HTMLElement {
  const newEl = document.createElement(newTag);
  for (const attr of Array.from(el.attributes)) {
    newEl.setAttribute(attr.name, attr.value);
  }
  while (el.firstChild) newEl.appendChild(el.firstChild);
  el.parentNode?.replaceChild(newEl, el);
  return newEl;
}

function wrapOrphanEmailInputs() {
  document.querySelectorAll<HTMLInputElement>(
    '.stitch-section input[type="email"]'
  ).forEach((input) => {
    if (input.closest("form")) return;
    const section = input.closest<HTMLElement>(".stitch-section");
    if (!section) return;

    let target: HTMLElement | null = input.parentElement;
    let boundary: HTMLElement | null = null;
    while (target && target !== section) {
      if (target.querySelector('button, input[type="submit"]')) {
        boundary = target;
        break;
      }
      target = target.parentElement;
    }
    if (!boundary) boundary = input.parentElement;
    if (!boundary || boundary === section || boundary.tagName === "FORM") return;

    changeTag(boundary, "form");
  });
}

function initForms() {
  wrapOrphanEmailInputs();

  const sitekey = getTurnstileSitekey();

  // FormBlock forms
  document.querySelectorAll<HTMLFormElement>(".form__container").forEach((form) => {
    stampRenderedAt(form);
    if (sitekey) addTurnstileWidget(form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      handleSubmit(form);
    });
  });

  // Stitch HTML forms (inside .stitch-section)
  document.querySelectorAll<HTMLFormElement>(".stitch-section form").forEach((form) => {
    // Skip if already handled
    if (form.dataset.cadmusHandled) return;
    form.dataset.cadmusHandled = "true";
    stampRenderedAt(form);
    if (sitekey) addTurnstileWidget(form);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      handleSubmit(form);
    });
  });

  // Load Turnstile once, after all widget containers are in place.
  if (sitekey && pendingTurnstileForms.length > 0) {
    injectTurnstileScript(sitekey);
  }
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initForms);
} else {
  initForms();
}
