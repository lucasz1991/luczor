/** Research metadata belongs to one principal, conversation and workspace run. */
export type ResearchStage = 'planning' | 'collecting' | 'synthesizing' | 'reviewing' | 'publishing'
export type ResearchStatus = 'queued' | 'running' | 'paused' | 'blocked' | 'completed' | 'cancelled'
export type ResearchQuestion = { id: string; text: string; requiresFreshness: boolean }
export type ResearchSegment = Readonly<{ id: string; text: string; locator?: string }>
/** Only trusted tool adapters create source records after a successful content read. */
export type ResearchSource = Readonly<{
  id: string
  url: string
  title: string
  publisher?: string
  capturedAt: number
  publishedAt?: string
  updatedAt?: string
  contentHash: string
  readReceiptId: string
  kind: 'web' | 'file' | 'context'
  coverage: 'complete' | 'partial'
  segments: readonly ResearchSegment[]
}>
export type ResearchEvidenceRef = { sourceId: string; segmentId: string }
export type ResearchClaimReview = {
  supported: boolean
  freshness: 'current' | 'not_required' | 'stale' | 'unknown'
  explanation: string
}
export type ResearchClaim = {
  id: string
  text: string
  questionIds: string[]
  evidence: ResearchEvidenceRef[]
  review?: ResearchClaimReview
}
export type ResearchArtifact = {
  id: string
  path: string
  kind: 'download' | 'extract' | 'report' | 'metadata'
  contentHash: string
  verifiedAt?: number
  sourceId?: string
  sourceUrl?: string
  requestedUrl?: string
}
export type ResearchReview = {
  completedAt: number
  inputFingerprint: string
  readReceiptIds: string[]
  summary: string
  issues: string[]
}
export type ResearchReport = {
  markdownPath: string
  htmlPath: string
  verifiedAt?: number
  contentFingerprint?: string
}
export type ResearchRun = {
  id: string
  principalId: string
  projectId: string
  conversationId: string
  workspaceBindingId?: string
  topic: string
  clarifications?: string[]
  depth: 'deep'
  stage: ResearchStage
  status: ResearchStatus
  revision: number
  createdAt: number
  updatedAt: number
  asOf: string
  outputDir: string
  questions: ResearchQuestion[]
  sources: ResearchSource[]
  claims: ResearchClaim[]
  artifacts: ResearchArtifact[]
  blockers: string[]
  limitations?: string[]
  review?: ResearchReview
  /** Internal checkpoint of verified source reads within a bounded independent review. */
  reviewProgress?: { inputFingerprint: string; readReceiptIds: string[]; deliveredReceiptIds?: string[] }
  report?: ResearchReport
}
export type ResearchPlanProposal = { questions: ResearchQuestion[]; queries: string[] }
export type ResearchClaimsProposal = { claims: ResearchClaim[]; limitations: string[] }
export type ResearchReviewProposal = {
  claims: Array<ResearchClaimReview & { claimId: string }>
  issues: string[]
  summary: string
}
export type ResearchCompletion = { ok: boolean; issues: string[] }
