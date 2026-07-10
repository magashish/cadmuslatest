import { useState } from "react";
import type { ContentBlock, HeroBlock } from "@cadmus/shared";

type BlockTypeOption = {
  type: ContentBlock["blockType"];
  label: string;
  description: string;
  variants: string[];
  // If set, this block is only offered when the given add-on is installed & active.
  requiresAddon?: string;
};

const BLOCK_TYPES: BlockTypeOption[] = [
  {
    type: "hero",
    label: "Hero",
    description: "Large hero section with headline",
    variants: ["centered", "split", "video-bg", "image-bg"],
  },
  {
    type: "text",
    label: "Text",
    description: "Rich text content block",
    variants: ["single-col", "single-col-dropcap", "two-col", "with-image"],
  },
  {
    type: "heading",
    label: "Heading",
    description: "Section heading with optional subtitle",
    variants: ["default", "with-subtitle", "centered"],
  },
  {
    type: "image",
    label: "Image",
    description: "Single image with caption",
    variants: ["full-width", "contained", "rounded"],
  },
  {
    type: "cta",
    label: "Call to Action",
    description: "Conversion-focused CTA section",
    variants: ["banner", "inline", "card"],
  },
  {
    type: "faq",
    label: "FAQ",
    description: "Frequently asked questions",
    variants: ["accordion", "two-col", "simple"],
  },
  {
    type: "testimonial",
    label: "Testimonial",
    description: "Customer testimonials",
    variants: ["carousel", "grid", "single-feature"],
  },
  {
    type: "paragraph",
    label: "Paragraph",
    description: "Simple text paragraph",
    variants: ["default"],
  },
  {
    type: "section",
    label: "Section",
    description: "Section with heading and body",
    variants: ["default"],
  },
  {
    type: "pricing",
    label: "Pricing",
    description: "Pricing plans and tiers",
    variants: ["cards", "table", "simple"],
  },
  {
    type: "gallery",
    label: "Gallery",
    description: "Image gallery grid or carousel",
    variants: ["grid", "masonry", "carousel"],
  },
  {
    type: "form",
    label: "Form",
    description: "Contact or custom form",
    variants: ["contact", "newsletter", "custom"],
  },
  {
    type: "video",
    label: "Video",
    description: "Embedded video player",
    variants: ["embed", "full-width", "contained"],
  },
  {
    type: "embed",
    label: "Embed",
    description: "Raw HTML embed code",
    variants: ["default"],
  },
  {
    type: "map",
    label: "Map",
    description: "Location map with business info",
    variants: ["default", "with-info", "full-width"],
  },
  {
    type: "html",
    label: "Custom HTML",
    description: "Raw HTML section (Stitch designs)",
    variants: ["stitch", "custom"],
  },
  {
    type: "mortgage-calculator",
    label: "Mortgage Calculator",
    description: "Interactive mortgage payment calculator",
    variants: [],
    requiresAddon: "mortgage-calculator",
  },
];

function createDefaultBlock(type: ContentBlock["blockType"], variant: string): ContentBlock {
  switch (type) {
    case "hero":
      return {
        blockType: "hero",
        variant: variant as HeroBlock["variant"],
        data: { headline: "" },
      } as ContentBlock;
    case "text":
      return {
        blockType: "text",
        variant,
        data: { content: "" },
      } as ContentBlock;
    case "heading":
      return {
        blockType: "heading",
        variant,
        data: { text: "", level: 2 },
      } as ContentBlock;
    case "image":
      return {
        blockType: "image",
        variant,
        data: { url: "", alt: "" },
      } as ContentBlock;
    case "cta":
      return {
        blockType: "cta",
        variant,
        data: { headline: "", buttonText: "", buttonUrl: "" },
      } as ContentBlock;
    case "faq":
      return {
        blockType: "faq",
        variant,
        data: { items: [{ question: "", answer: "" }] },
      } as ContentBlock;
    case "testimonial":
      return {
        blockType: "testimonial",
        variant,
        data: { items: [{ quote: "", name: "" }] },
      } as ContentBlock;
    case "paragraph":
      return {
        blockType: "paragraph",
        variant,
        data: { text: "" },
      } as ContentBlock;
    case "section":
      return {
        blockType: "section",
        variant,
        data: { heading: "", body: "" },
      } as ContentBlock;
    case "pricing":
      return {
        blockType: "pricing",
        variant,
        data: { items: [{ name: "", price: "", features: [] }] },
      } as ContentBlock;
    case "gallery":
      return {
        blockType: "gallery",
        variant,
        data: { items: [{ url: "", alt: "" }] },
      } as ContentBlock;
    case "form":
      return {
        blockType: "form",
        variant,
        data: { fields: [{ name: "", type: "text", label: "" }], submitText: "Submit" },
      } as ContentBlock;
    case "video":
      return {
        blockType: "video",
        variant,
        data: { url: "" },
      } as ContentBlock;
    case "embed":
      return {
        blockType: "embed",
        variant,
        data: { html: "" },
      } as ContentBlock;
    case "map":
      return {
        blockType: "map",
        variant,
        data: { address: "" },
      } as ContentBlock;
    case "html":
      return {
        blockType: "html",
        variant,
        data: { html: "", editableFields: {} },
      } as ContentBlock;
    case "mortgage-calculator":
      return {
        blockType: "mortgage-calculator",
        variant: "default",
        data: {
          title: "Mortgage Calculator",
          defaultPrice: 400000,
          defaultDownPct: 20,
          defaultRatePct: 6.5,
          defaultTermYears: 30,
          showAmortization: true,
        },
      } as ContentBlock;
    default:
      return {
        blockType: "heading",
        variant: "default",
        data: { text: "", level: 2 },
      } as ContentBlock;
  }
}

interface Props {
  onAdd: (block: ContentBlock) => void;
  onClose: () => void;
  installedAddonSlugs?: string[];
}

export function BlockPicker({ onAdd, onClose, installedAddonSlugs = [] }: Props) {
  const [selectedType, setSelectedType] = useState<BlockTypeOption | null>(null);

  // Gate add-on-backed block types: only show those whose required add-on is installed & active.
  const availableTypes = BLOCK_TYPES.filter(
    (bt) => !bt.requiresAddon || installedAddonSlugs.includes(bt.requiresAddon)
  );

  const handleTypeSelect = (bt: BlockTypeOption) => {
    // Blocks with no variants are added immediately.
    if (bt.variants.length === 0) {
      onAdd(createDefaultBlock(bt.type, "default"));
      onClose();
      return;
    }
    setSelectedType(bt);
  };

  const handleVariantSelect = (variant: string) => {
    if (!selectedType) return;
    const block = createDefaultBlock(selectedType.type, variant);
    onAdd(block);
    onClose();
  };

  return (
    <div className="block-picker-overlay" onClick={onClose}>
      <div className="block-picker" onClick={(e) => e.stopPropagation()}>
        <div className="block-picker-header">
          <h3>Add Block</h3>
          <button type="button" className="block-picker-close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        {!selectedType ? (
          <div className="block-picker-grid">
            {availableTypes.map((bt) => (
              <button
                key={bt.type}
                type="button"
                className="block-picker-item"
                onClick={() => handleTypeSelect(bt)}
              >
                <span className="block-picker-item-name">{bt.label}</span>
                <span className="block-picker-item-desc">{bt.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="block-picker-variants">
            <button
              type="button"
              className="block-picker-back"
              onClick={() => setSelectedType(null)}
            >
              &larr; Back
            </button>
            <h4>Choose a variant for {selectedType.label}</h4>
            <div className="variant-options">
              {selectedType.variants.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="variant-option"
                  onClick={() => handleVariantSelect(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
