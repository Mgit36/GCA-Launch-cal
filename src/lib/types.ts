export const PRODUCT_AREAS = [
  'Platform',
  'Customer Integrations',
  'Data Infrastructure',
  'Core Product',
  'AI & Chat',
  'Search & Views',
  'Onboarding',
] as const;
export type ProductArea = (typeof PRODUCT_AREAS)[number];

export const TEAMS = ['Legal', 'Sales', 'Marketing', 'Finance', 'Support'] as const;
export type Team = (typeof TEAMS)[number];

export const STATUSES = ['Backlog', 'In Progress', 'At Risk', 'Off Track', 'Shipped', 'Cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const PROJECT_STAGES = [
  'Discovery',
  'Design',
  'Implementation',
  'Launch Readiness',
  'Post Launch Support',
  'Completed',
  'Cancelled',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const SCOPE_CHANGES = ['Scope Creep', 'Trade Off', 'Descoped'] as const;
export type ScopeChange = (typeof SCOPE_CHANGES)[number];

export const RELEASE_STAGES = ['Pilot', 'Beta', 'GA'] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export const RELEASE_SIZES = ['Small', 'Medium', 'Large', 'Extra Large'] as const;
export type ReleaseSize = (typeof RELEASE_SIZES)[number];

export const YES_NO_NA = ['Yes', 'No', 'Not Applicable'] as const;
export type YesNoNA = (typeof YES_NO_NA)[number];

export const SUCCESS_METRICS = [
  'Regulatory & Compliance',
  'Productivity',
  'Growth',
  'Activation',
  'Retention',
] as const;
export type SuccessMetric = (typeof SUCCESS_METRICS)[number];

export interface Launch {
  id: string;
  project: string;
  project_brief: string;
  product_area: ProductArea;
  dri: string;
  requesting_team: Team;
  impacted_teams: Team[] | null;
  launch_date: string; // ISO date
  previous_launch_date: string | null;
  status: Status;
  status_summary: string | null;
  project_stage: ProjectStage | null;
  scope_change: ScopeChange | null;
  release_stage: ReleaseStage | null;
  release_size: ReleaseSize | null;
  dependency: string | null;
  customer_data_impact: YesNoNA;
  jurisdiction: YesNoNA;
  collaborators: string[] | null;
  success_metrics: SuccessMetric | null;
  change_log: string;
  created_date: string;
  last_updated: string;
  last_update_by: string;
}

export interface UnresolvedMessage {
  id: string;
  raw_message: string;
  reason: string;
  matched_project_id: string | null;
  created_date: string;
  resolved: boolean;
}

// Product Area -> default Release Size
export const RELEASE_SIZE_DEFAULT: Record<ProductArea, ReleaseSize> = {
  'Customer Integrations': 'Large',
  'Data Infrastructure': 'Large',
  Platform: 'Medium',
  'Core Product': 'Medium',
  'AI & Chat': 'Small',
  'Search & Views': 'Small',
  Onboarding: 'Extra Large',
};

// Release Size -> default Release Stage
// Small/Medium -> GA, Large/Extra Large -> Pilot
export function defaultReleaseStage(size: ReleaseSize): ReleaseStage {
  return size === 'Small' || size === 'Medium' ? 'GA' : 'Pilot';
}
