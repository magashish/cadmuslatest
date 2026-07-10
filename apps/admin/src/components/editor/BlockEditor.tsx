import { useState, useRef } from "react";
import type { ContentBlock, HtmlBlock } from "@cadmus/shared";
import { BlockPicker } from "./BlockPicker";
import { HeroEditor } from "./blocks/HeroEditor";
import { TextEditor } from "./blocks/TextEditor";
import { CTAEditor } from "./blocks/CTAEditor";
import { HeadingEditor } from "./blocks/HeadingEditor";
import { ImageEditor } from "./blocks/ImageEditor";
import { FAQEditor } from "./blocks/FAQEditor";
import { TestimonialEditor } from "./blocks/TestimonialEditor";
import { ParagraphEditor } from "./blocks/ParagraphEditor";
import { SectionEditor } from "./blocks/SectionEditor";
import { PricingEditor } from "./blocks/PricingEditor";
import { GalleryEditor } from "./blocks/GalleryEditor";
import { FormEditor } from "./blocks/FormEditor";
import { VideoEditor } from "./blocks/VideoEditor";
import { EmbedEditor } from "./blocks/EmbedEditor";
import { MapEditor } from "./blocks/MapEditor";
import { HtmlBlockEditor } from "./blocks/HtmlBlockEditor";
import { MortgageCalculatorEditor } from "./blocks/MortgageCalculatorEditor";

interface Props {
  blocks: ContentBlock[];
  onChange: (blocks: ContentBlock[]) => void;
  theme?: Record<string, unknown>;
  installedAddonSlugs?: string[];
}

export function BlockEditor({ blocks, onChange, theme, installedAddonSlugs }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());

  // Stable keys per block object — survives reorders since moveBlock keeps the same references
  const blockKeys = useRef(new WeakMap<ContentBlock, string>());
  const getKey = (block: ContentBlock): string => {
    if (!blockKeys.current.has(block)) {
      blockKeys.current.set(block, crypto.randomUUID());
    }
    return blockKeys.current.get(block)!;
  };

  const addBlock = (block: ContentBlock) => {
    onChange([...blocks, block]);
  };

  const removeBlock = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index));
  };

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const updated = [...blocks];
    const temp = updated[index];
    updated[index] = updated[target];
    updated[target] = temp;
    onChange(updated);
  };

  const updateBlock = (index: number, block: ContentBlock) => {
    const updated = [...blocks];
    const existingKey = blockKeys.current.get(updated[index]);
    if (existingKey) blockKeys.current.set(block, existingKey);
    updated[index] = block;
    onChange(updated);
  };

  const toggleCollapse = (key: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const renderBlockEditor = (block: ContentBlock, index: number) => {
    const onDataChange = (data: ContentBlock["data"]) => {
      updateBlock(index, { ...block, data } as ContentBlock);
    };

    const onVariantChange = (variant: string) => {
      updateBlock(index, { ...block, variant } as ContentBlock);
    };

    switch (block.blockType) {
      case "hero":
        return (
          <HeroEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "text":
        return (
          <TextEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "cta":
        return (
          <CTAEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "heading":
        return (
          <HeadingEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "image":
        return (
          <ImageEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "faq":
        return (
          <FAQEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "testimonial":
        return (
          <TestimonialEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "paragraph":
        return (
          <ParagraphEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "section":
        return (
          <SectionEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "pricing":
        return (
          <PricingEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "gallery":
        return (
          <GalleryEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "form":
        return (
          <FormEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
            installedAddonSlugs={installedAddonSlugs}
          />
        );
      case "video":
        return (
          <VideoEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "embed":
        return (
          <EmbedEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "map":
        return (
          <MapEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
          />
        );
      case "html":
        return (
          <HtmlBlockEditor
            data={block.data}
            variant={block.variant}
            onDataChange={onDataChange}
            onVariantChange={onVariantChange as (v: typeof block.variant) => void}
            theme={theme}
          />
        );
      case "mortgage-calculator":
        return (
          <MortgageCalculatorEditor
            data={block.data}
            onDataChange={onDataChange}
            theme={theme}
          />
        );
      default:
        return (
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
            No editor available for block type: {(block as ContentBlock).blockType}
          </p>
        );
    }
  };

  return (
    <div>
      <div className="block-list">
        {blocks.map((block, index) => {
          const key = getKey(block);
          const sectionLabel = block.blockType === "html"
            ? ((block as HtmlBlock).data.sectionName ?? block.variant)
            : block.variant;
          return (
            <div key={key} className="block-item">
              <div className="block-header" onClick={() => toggleCollapse(key)}>
                <div className="block-header-left">
                  <span className="block-type-badge">{block.blockType}</span>
                  <span className="block-variant-label">{sectionLabel}</span>
                </div>
                <div className="block-header-right">
                  <button
                    type="button"
                    className="block-action-btn"
                    title="Move up"
                    onClick={(e) => { e.stopPropagation(); moveBlock(index, -1); }}
                    disabled={index === 0}
                  >
                    &#x25B2;
                  </button>
                  <button
                    type="button"
                    className="block-action-btn"
                    title="Move down"
                    onClick={(e) => { e.stopPropagation(); moveBlock(index, 1); }}
                    disabled={index === blocks.length - 1}
                  >
                    &#x25BC;
                  </button>
                  <button
                    type="button"
                    className="block-action-btn danger"
                    title="Remove block"
                    onClick={(e) => { e.stopPropagation(); removeBlock(index); }}
                  >
                    &#x2715;
                  </button>
                </div>
              </div>
              {!collapsedBlocks.has(key) && (
                <div className="block-body">
                  {renderBlockEditor(block, index)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="add-block-btn"
        onClick={() => setShowPicker(true)}
      >
        + Add Block
      </button>

      {showPicker && (
        <BlockPicker
          onAdd={addBlock}
          onClose={() => setShowPicker(false)}
          installedAddonSlugs={installedAddonSlugs}
        />
      )}
    </div>
  );
}
