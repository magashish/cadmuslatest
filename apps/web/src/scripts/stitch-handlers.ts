/**
 * Globals expected by Stitch-generated inline `onclick=` handlers.
 *
 * Stitch sometimes emits accordion / disclosure UI with inline handlers like
 * `onclick="toggleAccordion(this)"` and ships no JS to back them. Without a
 * matching global, the click throws ReferenceError. We register lightweight,
 * markup-driven implementations that work against the standard Stitch shape.
 */

declare global {
  interface Window {
    toggleAccordion?: (btn: HTMLElement) => void;
  }
}

function toggleAccordion(btn: HTMLElement) {
  const content = btn.nextElementSibling as HTMLElement | null;
  if (!content) return;
  const icon = btn.querySelector<HTMLElement>('[data-icon], .material-symbols-outlined');
  const isOpen = content.style.maxHeight && content.style.maxHeight !== "0px";
  if (isOpen) {
    content.style.maxHeight = "0px";
    if (icon) icon.style.transform = "";
  } else {
    content.style.maxHeight = `${content.scrollHeight}px`;
    if (icon) icon.style.transform = "rotate(180deg)";
  }
}

window.toggleAccordion = toggleAccordion;

export {};
