import {
  ProductArea,
  RELEASE_SIZE_DEFAULT,
  defaultReleaseStage,
  ReleaseSize,
  ReleaseStage,
} from './types';

export interface InferredBundle {
  productArea: ProductArea;
  releaseSize: ReleaseSize;
  releaseStage: ReleaseStage;
}

// Keyword signals -> Product Area. Order matters: more specific signals checked first.
const SIGNALS: Array<{ area: ProductArea; keywords: string[] }> = [
  {
    area: 'Data Infrastructure',
    keywords: ['snowflake', 'data lake', 'azure data', 'pipeline', 'warehouse', 'etl'],
  },
  {
    area: 'Customer Integrations',
    keywords: ['dropbox', 'sharepoint', 'salesforce', 'connector', 'integration', 'vendor'],
  },
  {
    area: 'AI & Chat',
    keywords: ['chat', 'skill', 'agent', 'copilot', 'shortcut', '/'],
  },
  {
    area: 'Search & Views',
    keywords: ['saved view', 'filter', 'search', 'view'],
  },
  {
    area: 'Onboarding',
    keywords: ['onboarding', 'checklist', 'setup flow', 'activation'],
  },
  {
    area: 'Core Product',
    keywords: ['editor', 'trial', 'export', 'multi-tab', 'feature'],
  },
];

/**
 * Infers the full bundle (Product Area -> Release Size -> Release Stage) from
 * Project name + Project Brief text. Falls back to Platform/Medium/GA when no
 * signal matches - this is also the fallback used when a user gives a bare "no"
 * with no further correction.
 */
export function inferBundle(projectName: string, projectBrief: string): InferredBundle {
  const text = `${projectName} ${projectBrief}`.toLowerCase();

  let productArea: ProductArea = 'Platform'; // fallback default
  for (const { area, keywords } of SIGNALS) {
    if (keywords.some((kw) => text.includes(kw))) {
      productArea = area;
      break;
    }
  }

  const releaseSize = RELEASE_SIZE_DEFAULT[productArea];
  const releaseStage = defaultReleaseStage(releaseSize);

  return { productArea, releaseSize, releaseStage };
}

export const DEFAULT_BUNDLE: InferredBundle = {
  productArea: 'Platform',
  releaseSize: 'Medium',
  releaseStage: 'GA',
};

/**
 * Formats the bundle into the single confirmation question presented to the user,
 * per the locked design: one bundled yes/no question, not three separate ones.
 */
export function formatConfirmation(bundle: InferredBundle): string {
  return `This looks like a ${bundle.productArea} launch, ${bundle.releaseSize} release, starting in ${bundle.releaseStage}. Correct?`;
}
