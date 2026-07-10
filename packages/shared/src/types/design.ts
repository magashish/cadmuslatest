export type ComponentVariant<T extends string> = T;

export interface HeroBlock {
  blockType: "hero";
  variant: ComponentVariant<"centered" | "split" | "video-bg" | "image-bg">;
  data: {
    headline: string;
    subheadline?: string;
    ctaText?: string;
    ctaUrl?: string;
    imageUrl?: string;
    videoUrl?: string;
  };
}

export interface TextBlock {
  blockType: "text";
  variant: ComponentVariant<"single-col" | "single-col-dropcap" | "two-col" | "with-image">;
  data: {
    content: string;
    imageUrl?: string;
    imagePosition?: "left" | "right";
  };
}

export interface HeadingBlock {
  blockType: "heading";
  variant: ComponentVariant<"default" | "with-subtitle" | "centered">;
  data: {
    text: string;
    level: 1 | 2 | 3 | 4;
    subtitle?: string;
  };
}

export interface ImageBlock {
  blockType: "image";
  variant: ComponentVariant<"full-width" | "contained" | "rounded">;
  data: {
    url: string;
    alt: string;
    caption?: string;
  };
}

export interface CTABlock {
  blockType: "cta";
  variant: ComponentVariant<"banner" | "inline" | "card">;
  data: {
    headline: string;
    description?: string;
    buttonText: string;
    buttonUrl: string;
    secondaryButtonText?: string;
    secondaryButtonUrl?: string;
  };
}

export interface TestimonialBlock {
  blockType: "testimonial";
  variant: ComponentVariant<"carousel" | "grid" | "single-feature">;
  data: {
    items: Array<{
      quote: string;
      name: string;
      title?: string;
      imageUrl?: string;
      rating?: number;
    }>;
  };
}

export interface FAQBlock {
  blockType: "faq";
  variant: ComponentVariant<"accordion" | "two-col" | "simple">;
  data: {
    items: Array<{
      question: string;
      answer: string;
    }>;
  };
}

export interface PricingBlock {
  blockType: "pricing";
  variant: ComponentVariant<"cards" | "table" | "simple">;
  data: {
    items: Array<{
      name: string;
      price: string;
      period?: string;
      description?: string;
      features: string[];
      ctaText?: string;
      ctaUrl?: string;
      highlighted?: boolean;
    }>;
  };
}

export interface GalleryBlock {
  blockType: "gallery";
  variant: ComponentVariant<"grid" | "masonry" | "carousel">;
  data: {
    items: Array<{
      url: string;
      alt: string;
      caption?: string;
    }>;
    columns?: number;
  };
}

export interface FormBlock {
  blockType: "form";
  variant: ComponentVariant<"contact" | "newsletter" | "custom">;
  data: {
    name?: string;
    formId?: string;
    fields: Array<{
      name: string;
      // "file" requires the form-file-uploads add-on: the editor only offers it
      // when entitled, and the API rejects file parts from non-entitled sites.
      type: "text" | "email" | "textarea" | "phone" | "select" | "checkbox" | "file";
      label: string;
      required?: boolean;
      options?: string[];
      placeholder?: string;
    }>;
    submitText: string;
    successMessage?: string;
    notificationEmail?: string;
    confirmationEnabled?: boolean;
    confirmationMessage?: string;
    redirectUrl?: string;
    // POST submissions to this URL on submit (server-side, signed). Server-only:
    // stripped from publicly-served blocks. Signing secret is per-site.
    webhookUrl?: string;
    webhookEnabled?: boolean;
  };
}

export interface VideoBlock {
  blockType: "video";
  variant: ComponentVariant<"embed" | "full-width" | "contained">;
  data: {
    source?: "url" | "library";
    url: string;
    mediaUrl?: string;
    title?: string;
    autoplay?: boolean;
  };
}

export interface EmbedBlock {
  blockType: "embed";
  variant: ComponentVariant<"default">;
  data: {
    html: string;
  };
}

export interface MapBlock {
  blockType: "map";
  variant: ComponentVariant<"default" | "with-info" | "full-width">;
  data: {
    address: string;
    lat?: number;
    lng?: number;
    zoom?: number;
    businessName?: string;
    phone?: string;
    hours?: string;
  };
}

export interface ParagraphBlock {
  blockType: "paragraph";
  variant: ComponentVariant<"default">;
  data: { text: string };
}

export interface SectionBlock {
  blockType: "section";
  variant: ComponentVariant<"default">;
  data: { heading?: string; body?: string };
}

export interface HtmlBlockEditableField {
  selector: string;
  type: "text" | "richtext" | "image" | "link";
  value: string;
  label: string;
}

export interface HtmlBlock {
  blockType: "html";
  variant: ComponentVariant<"stitch" | "custom">;
  data: {
    html: string;
    css?: string;
    editableFields: Record<string, HtmlBlockEditableField>;
    sectionName?: string;
    formSettings?: {
      name?: string;
      formId?: string;
      notificationEmail?: string;
      confirmationEnabled?: boolean;
      confirmationMessage?: string;
      successMessage?: string;
      redirectUrl?: string;
      // See FormBlock.data.webhookUrl — server-only, stripped from served blocks.
      webhookUrl?: string;
      webhookEnabled?: boolean;
    };
  };
}

export interface MortgageCalculatorBlock {
  blockType: "mortgage-calculator";
  variant: ComponentVariant<"default">;
  data: {
    title?: string;
    defaultPrice?: number;
    defaultDownPct?: number;
    defaultRatePct?: number;
    defaultTermYears?: number;
    showAmortization?: boolean;
    /** Hex color overriding the theme primary for this block. Empty/absent → theme var. */
    accentColor?: string;
    /** When true, adds property-tax + insurance inputs and shows a PITI total. */
    includeTaxesInsurance?: boolean;
    /** Default property tax rate (%/yr) when taxes & insurance are enabled. Fallback 1.1. */
    defaultTaxRatePct?: number;
    /** Default home insurance ($/yr) when taxes & insurance are enabled. Fallback 1500. */
    defaultInsuranceYearly?: number;
    /** When PITI is enabled, controls whether the P&I/tax/insurance breakdown renders. Default true. */
    showBreakdown?: boolean;
  };
}

export type ContentBlock =
  | HeroBlock
  | TextBlock
  | HeadingBlock
  | ImageBlock
  | CTABlock
  | TestimonialBlock
  | FAQBlock
  | PricingBlock
  | GalleryBlock
  | FormBlock
  | VideoBlock
  | EmbedBlock
  | MapBlock
  | ParagraphBlock
  | SectionBlock
  | HtmlBlock
  | MortgageCalculatorBlock;
