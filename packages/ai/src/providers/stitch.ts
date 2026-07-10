import { Stitch, StitchToolClient, Screen } from "@google/stitch-sdk";
import type { SiteBrief, SiteTheme } from "@cadmus/shared";

export interface StitchDesignOptions {
  brief: SiteBrief;
  pageType: string;
  pagePurpose?: string;
  theme?: SiteTheme;
  existingContent?: string;
  inspirationAnalysis?: string;
  deviceType?: "DESKTOP" | "MOBILE";
  projectId?: string;
}

export interface StitchDesignResult {
  html: string;
  screenId: string;
  projectId: string;
}

export interface StitchScreenInfo {
  screenId: string;
  name?: string;
  html: string;
}

export interface StitchServiceConfig {
  apiKey: string;
}

export class StitchDesignService {
  private stitch: Stitch;
  private client: StitchToolClient;

  constructor(config: StitchServiceConfig) {
    this.client = new StitchToolClient({ apiKey: config.apiKey });
    this.stitch = new Stitch(this.client);
  }

  async generatePageDesign(options: StitchDesignOptions): Promise<StitchDesignResult> {
    const prompt = this.buildPrompt(options);

    // Reuse existing project or create a new one
    let projectId: string;
    if (options.projectId) {
      projectId = options.projectId;
      console.log(`Stitch: reusing project ${projectId} for ${options.pageType}`);
    } else {
      const project = await this.stitch.createProject(
        options.brief.businessName,
      );
      projectId = project.id;
      console.log(`Stitch: created project ${projectId} for ${options.brief.businessName}`);
    }

    // Snapshot existing screen count so we can detect the new one
    const existingScreens = await this.listProjectScreens(projectId);
    const existingCount = existingScreens.length;

    // Generate a screen from the prompt.
    const raw = await this.client.callTool("generate_screen_from_text", {
      projectId,
      prompt,
      deviceType: options.deviceType ?? "DESKTOP",
    }) as Record<string, unknown>;

    // Check if inline screen data is present (future SDK compatibility)
    const outputComponents = (raw.outputComponents ?? raw.output_components) as Array<Record<string, unknown>> | undefined;
    let screen: InstanceType<typeof Screen> | null = null;

    // Try to find inline screen data in any outputComponent
    if (outputComponents) {
      for (const component of outputComponents) {
        const design = component?.design as Record<string, unknown> | undefined;
        const screens = design?.screens as Array<Record<string, unknown>> | undefined;
        if (screens?.[0]) {
          screen = new Screen(this.client, { ...screens[0], projectId });
          break;
        }
      }
    }

    // If no inline screen data, poll for new screens (generation is async)
    if (!screen) {
      console.log(`Stitch: no inline screen data for project ${projectId}, polling for screens...`);
      screen = await this.pollForScreen(projectId, existingCount, 5, 3000);
    }

    if (!screen) {
      throw new Error(
        `Stitch: no screens appeared for project ${projectId} after polling. ` +
        `outputComponents count: ${outputComponents?.length ?? 0}`
      );
    }

    // getHtml() returns a download URL — fetch the actual HTML content
    const htmlUrl = await screen.getHtml();
    let html: string;
    if (htmlUrl.startsWith("http")) {
      const res = await fetch(htmlUrl);
      html = await res.text();
    } else {
      html = htmlUrl;
    }

    return {
      html,
      screenId: screen.id,
      projectId,
    };
  }

  async listProjectScreens(projectId: string): Promise<Array<{ screenId: string; name: string; screenshotUrl?: string }>> {
    const raw = await this.client.callTool("list_screens", { projectId }) as Record<string, unknown>;
    const rawScreens = (raw.screens ?? []) as Array<Record<string, unknown>>;
    if (rawScreens[0]) {
      console.log("Stitch: raw screen keys:", Object.keys(rawScreens[0]));
    }
    return rawScreens.map((s, i) => {
      const screen = new Screen(this.client, { ...s, projectId });
      // Try various fields for a human-readable name
      const name = (s.displayName ?? s.title ?? "") as string;
      // Extract screenshot URL if available
      const screenshot = s.screenshot as Record<string, unknown> | undefined;
      const screenshotUrl = (screenshot?.downloadUrl ?? screenshot?.url ?? "") as string;
      return {
        screenId: screen.id,
        name: name || `Screen ${i + 1}`,
        ...(screenshotUrl ? { screenshotUrl } : {}),
      };
    });
  }

  async fetchScreenHtml(projectId: string, screenId: string): Promise<string> {
    const screen = new Screen(this.client, { projectId, id: screenId });
    const htmlUrl = await screen.getHtml();
    if (htmlUrl.startsWith("http")) {
      const res = await fetch(htmlUrl);
      return await res.text();
    }
    return htmlUrl;
  }

  async fetchProjectScreens(projectId: string): Promise<StitchScreenInfo[]> {
    const raw = await this.client.callTool("list_screens", { projectId }) as Record<string, unknown>;
    const rawScreens = (raw.screens ?? []) as Array<Record<string, unknown>>;

    const results: StitchScreenInfo[] = [];
    for (const s of rawScreens) {
      const screen = new Screen(this.client, { ...s, projectId });
      const htmlUrl = await screen.getHtml();
      let html: string;
      if (htmlUrl.startsWith("http")) {
        const res = await fetch(htmlUrl);
        html = await res.text();
      } else {
        html = htmlUrl;
      }
      results.push({
        screenId: screen.id,
        name: (s.displayName ?? s.name ?? "") as string,
        html,
      });
    }
    return results;
  }

  private async pollForScreen(
    projectId: string,
    existingCount: number,
    maxAttempts: number,
    delayMs: number,
  ): Promise<InstanceType<typeof Screen> | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      console.log(`Stitch: polling for screens, attempt ${attempt}/${maxAttempts}...`);
      try {
        const raw = await this.client.callTool("list_screens", { projectId }) as Record<string, unknown>;
        const rawScreens = (raw.screens ?? []) as Array<Record<string, unknown>>;
        if (rawScreens.length > existingCount) {
          console.log(`Stitch: found ${rawScreens.length} screen(s) on attempt ${attempt} (was ${existingCount})`);
          const newest = rawScreens[rawScreens.length - 1];
          return new Screen(this.client, { ...newest, projectId });
        }
      } catch (err) {
        console.warn(`Stitch: poll attempt ${attempt} failed:`, err);
      }
    }
    return null;
  }

  private buildPrompt(options: StitchDesignOptions): string {
    const { brief, pageType, pagePurpose, theme, existingContent } = options;

    const parts: string[] = [
      `Design a professional, modern ${pageType} page for "${brief.businessName}".`,
      `Business: ${brief.businessDescription}`,
    ];

    const constraints = (brief.constraints ?? []).filter((c) => typeof c === "string" && c.trim());
    if (constraints.length) {
      // Absolute user prohibitions/requirements — must win over other guidance.
      parts.push(
        `ABSOLUTE REQUIREMENTS — obey every one of these, even if it conflicts with other guidance:\n${constraints.map((c) => `- ${c}`).join("\n")}`,
      );
    }

    if (brief.targetAudience) {
      parts.push(`Target audience: ${brief.targetAudience}`);
    }
    if (brief.tone) {
      parts.push(`Tone/style: ${brief.tone}`);
    }
    if (brief.primaryGoal) {
      parts.push(`Primary goal: ${brief.primaryGoal}`);
    }
    if (pagePurpose) {
      parts.push(`Page purpose: ${pagePurpose}`);
    }

    const themeColorEntries = theme ? Object.entries(theme.colors ?? {}) : [];
    if (themeColorEntries.length > 0) {
      parts.push(
        "COLOR PALETTE (use these exact hex values — do not substitute):",
        ...themeColorEntries.map(([name, hex]) => `  - ${name}: ${hex}`),
      );
    } else if (brief.brandColors) {
      parts.push(
        `BRAND COLORS (the user requested these — use them prominently in the design): ${brief.brandColors}`,
      );
    }

    if (theme) {
      const headingStack = theme.fontFamilies?.heading?.join(", ");
      const bodyStack = theme.fontFamilies?.body?.join(", ");
      if (headingStack) parts.push(`Heading font stack: ${headingStack}`);
      if (bodyStack && bodyStack !== headingStack) parts.push(`Body font stack: ${bodyStack}`);
      const radiusValues = Object.entries(theme.borderRadius ?? {});
      if (radiusValues.length > 0) {
        parts.push(
          `Border radii: ${radiusValues.map(([k, v]) => `${k}=${v}`).join(", ")}`,
        );
      }
      if (theme.presetSeed) {
        parts.push(`Design style: ${theme.presetSeed}`);
      }
    }

    if (brief.logoUrl) {
      parts.push(
        `LOGO: The business has a logo image at this URL: ${brief.logoUrl}`,
        `Use this logo in the header/navigation area with an <img> tag. Add class="site-logo" so we can find it later. Do NOT use text-only branding — display the actual logo image. Keep it appropriately sized (e.g. height 40-48px) with the business name as alt text.`,
      );
    }

    if (existingContent) {
      parts.push(`Existing content context: ${existingContent}`);
    }

    if (options.inspirationAnalysis) {
      parts.push(
        `\nDESIGN INSPIRATION (based on reference images the user provided):\n${options.inspirationAnalysis}`,
        "Use the above design cues as strong guidance for the visual direction — adapt the color palette, typography feel, layout patterns, and overall aesthetic to match the inspiration while keeping the design original and appropriate for this business.",
      );
    }

    parts.push(
      "Make the design visually polished with clear hierarchy, strong CTAs, and conversion-optimized layout.",
      "Use real-looking placeholder content that matches the business.",
    );

    // Hero conversion requirements
    const audienceHint = brief.targetAudience
      ? `The target audience is: ${brief.targetAudience}.`
      : "";
    parts.push(
      `HERO SECTION — CONVERSION CRITICAL: Visitors decide in 3–5 seconds whether to stay or leave. The hero headline and subheadline must immediately answer three questions: (1) What is this? (2) Who is it for? (3) Why should I care? ${audienceHint} Write the headline and subheadline to speak directly to that audience — use their language, address their pain point or desire, and make the value proposition unmistakable. Do NOT use generic headlines like "Welcome to [Business]" or vague taglines. The subheadline should reinforce the headline with a specific benefit or proof point.`,
    );

    // CTA rules
    parts.push(
      "CALL-TO-ACTION COPY — NEVER use generic labels: do NOT write 'Learn More', 'Get Started', 'Click Here', 'Submit', or 'Contact Us' on any button or CTA. Every CTA must tell the visitor exactly what happens when they click — it should describe the specific action or outcome. Examples: 'Get my free website audit', 'Book a free 30-min call', 'Send me the checklist', 'See our portfolio', 'Start my free trial', 'Get a custom quote'. Make the CTA feel like a natural next step for someone who just read the hero copy.",
    );

    parts.push(
      "HEADER POSITIONING: The header/nav must use sticky positioning (e.g. class=\"sticky top-0\"). Do NOT use position: fixed or class=\"fixed\" on the header — fixed headers pull out of the document flow and cause body content to render behind them.",
      "SECTION LAYOUT: Every <section> must have horizontal padding and an inner max-width container so content does not hit the viewport edges. Use class=\"px-6 py-16 md:py-24\" on each <section> and wrap its content in <div class=\"max-w-7xl mx-auto\"> (or max-w-4xl for narrower content). Apply this consistently across every section on every page — never emit a bare <section> with no padding classes.",
      "LAYERING / Z-INDEX: Any element layered on top of an image — a floating badge, stat card, price tag, caption, or label that overlaps a photo — MUST carry a z-index higher than that image. If the image uses class=\"... z-10\", the overlay must use z-20 (or higher). Never emit a floating overlay over an image without a z-index above the image's, or the image will paint over it and hide it.",
      "NAVIGATION DROPDOWNS (one level only): Most sites don't need dropdown menus — only add them if the brief specifically mentions many pages that benefit from grouping. If used, implement as a CSS <details>/<summary> dropdown: `<details class=\"cadmus-dropdown\"><summary class=\"[nav-link-classes]\">Label <svg class=\"cadmus-dropdown-caret\" viewBox=\"0 0 20 20\" fill=\"currentColor\" aria-hidden=\"true\"><path fill-rule=\"evenodd\" d=\"M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z\" clip-rule=\"evenodd\"/></svg></summary><ul class=\"cadmus-dropdown-menu\"><li><a href=\"/path\">Child</a></li></ul></details>`. The platform injects the .cadmus-dropdown CSS automatically.",
    );

    return parts.join("\n");
  }
}
