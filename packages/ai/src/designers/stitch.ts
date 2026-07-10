import { StitchDesignService } from "../providers/stitch.js";
import type { PageDesigner, DesignPageInput, DesignPageOutput } from "./types.js";

/**
 * PageDesigner adapter around StitchDesignService. Translates the pluggable
 * PageDesigner contract into Stitch's native options and threads the
 * per-site projectId through the SiteTheme.designerState field.
 */
export class StitchPageDesigner implements PageDesigner {
  readonly name = "stitch";

  constructor(private readonly service: StitchDesignService) {}

  async designPage(input: DesignPageInput): Promise<DesignPageOutput> {
    const projectId = input.designerState?.stitch?.projectId;

    const result = await this.service.generatePageDesign({
      brief: input.brief,
      pageType: input.pageType,
      pagePurpose: input.pagePurpose,
      theme: input.theme,
      existingContent: input.existingContent,
      inspirationAnalysis: input.inspirationAnalysis,
      deviceType: input.deviceType,
      projectId,
    });

    return {
      html: result.html,
      designerState: {
        ...(input.designerState ?? {}),
        stitch: { projectId: result.projectId },
      },
    };
  }
}
