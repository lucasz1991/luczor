import type { MessageMeta } from '@/state/types'
import type { ArchivedRun } from './runArchive'

/** Apply only after capture succeeds. Retention never grants external egress. */
export function checkpointMessageRetention(
  saved: Pick<ArchivedRun, 'dataPolicy' | 'gaps'>
): Pick<MessageMeta, 'retentionPolicy' | 'dataHandling' | 'serverSpeechAllowed'> {
  return {
    retentionPolicy: saved.gaps.length ? 'ephemeral' : saved.dataPolicy,
    dataHandling: 'ephemeral',
    serverSpeechAllowed: false,
  }
}
