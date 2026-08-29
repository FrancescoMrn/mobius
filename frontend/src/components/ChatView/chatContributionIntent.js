/* Chat-owned contract for turning recorded edits into private contribution reviews. */

import {
  publicationAction,
  publicationStackAction,
  sendBlocker,
  stackSendBlocker,
} from './contributionReviewModel.js'

export const CHAT_CONTRIBUTION_PREPARE_PROMPT = [
  'Sort the file changes recorded by this chat into coherent contributions.',
  '',
  'Verify the current source state, then privately prepare every worthwhile contribution for review, grouped by owning project and dependency. Keep personal, experimental, local-only, incoming-only, and duplicate work out. Do not push, publish, or send anything upstream.',
  '',
  'For every excluded path, record its reviewed-through timestamp and disposition in Changes using Contribute’s chat-settlement workflow, so it stays settled until that path changes again.',
  '',
  'When finished, summarize the prepared contributions and what intentionally stayed local in this chat.',
].join('\n')

export const CHAT_CONTRIBUTION_FINISH_PROMPT = [
  'Prepare every worthwhile contribution represented by this chat for submission.',
  '',
  'First refresh the current Contribute ledger and source state. Sort every worthwhile unsorted change by owning project, reconcile any existing pull requests, prepare exact updates where newer local work belongs to them, and repair any contribution that needs attention. Reuse an existing prepared or public contribution instead of duplicating it.',
  '',
  'Keep all new work private. Do not push, publish, update a pull request, merge, or send anything upstream. Record every intentionally excluded path through the exact edit timestamp reviewed using Contribute’s chat-settlement workflow. Stop at clear approval buttons for every exact public action, then summarize what is ready and what intentionally stays local.',
  '',
  'This source chat owns the run and the final contribution records. If genuinely independent project work would benefit from parallel preparation, use durable background Delegation helpers, wait for their results, and integrate them here. Do not create app-owned worker chats or make the owner chase another conversation.',
].join('\n')

export function projectContributionPreparePrompt(source) {
  const id = String(source?.id || '').trim()
  const label = String(source?.label || 'this project').trim()
  return [
    `Prepare the unsorted changes from ${label} (${id}) in this chat for contribution.`,
    '',
    'Verify the current source state, group the worthwhile changes coherently, reconcile them with any existing prepared or public contribution, and create or refresh private reviews. Record every intentionally excluded path through the exact edit timestamp reviewed using Contribute’s chat-settlement workflow, so it stays settled until changed. Keep unrelated projects untouched. Do not push, publish, or send anything upstream.',
  ].join('\n')
}

export function openContributionUpdatePrompt(records) {
  const ids = (Array.isArray(records) ? records : [records])
    .map(record => String(record?.id || '').trim())
    .filter(Boolean)
  return [
    `Check ${ids.length === 1 ? 'this open contribution' : 'these open contributions'} for newer work from this chat: ${ids.join(', ')}.`,
    '',
    'Refresh the source and GitHub state first. If newer unsorted changes belong to an existing pull request, prepare an exact private update for review; otherwise leave the pull request unchanged. Reconcile duplicate or already-applied work programmatically. Do not push or update any pull request without a new explicit approval button.',
  ].join('\n')
}

export function chatContributionPrepareAction() {
  return {
    label: 'Prepare to submit',
    description: 'Align and review worthwhile work here, then bring back one exact public approval.',
  }
}

export function chatContributionFinishAction() {
  return {
    label: 'Prepare to submit',
    description: 'Resolve every private step without repeating work, then bring the exact send decision back here.',
  }
}

export function chatChangesPrimaryAction(overview) {
  const counts = overview?.counts || {}
  const kinds = [
    counts.unsorted > 0 ? 'unsorted' : '',
    counts.prepared > 0 ? 'prepared' : '',
    counts.attention > 0 ? 'attention' : '',
  ].filter(Boolean)
  if (kinds.length > 1) return {
    kind: 'finish', label: 'Prepare to submit',
    description: 'Align new work, repair private reviews, and bring one exact send decision back here.',
  }
  if (counts.unsorted > 0) return {
    kind: 'prepare', label: 'Prepare to submit',
    description: 'Sort, align, and review the worthwhile work without leaving this chat.',
  }
  if (counts.attention > 0) return {
    kind: 'finish', label: 'Resolve all',
    description: 'Continue every private fix here and return only the decisions that still need you.',
  }
  if (counts.prepared > 0) return {
    kind: 'review', label: 'Review prepared',
    description: 'Review the exact private work, then send or update it directly when you approve.',
  }
  if (counts.open > 0) return {
    kind: 'updates', label: 'Check for updates',
    description: 'Refresh open pull requests and prepare any newer work that belongs with them.',
  }
  return null
}

export function preparedChangesPrimaryAction(values, { connected } = {}) {
  const items = (Array.isArray(values) ? values : []).map(value => (
    value?.kind ? value : { kind: 'record', id: value?.id, record: value }
  ))
  if (items.length === 0) return null
  const ready = items.every(item => item.kind === 'stack'
    ? !stackSendBlocker(item, { connected })
    : !sendBlocker(item.record, { connected }))
  if (ready) {
    if (items.length === 1) {
      const item = items[0]
      const action = item.kind === 'stack'
        ? publicationStackAction(item)
        : publicationAction(item.record)
      return {
        kind: 'publish-items',
        items,
        label: action.label,
        description: item.kind === 'stack'
          ? 'Confirm the complete linked set once, then open every reviewed pull request in order.'
          : 'Complete this exact reviewed GitHub action.',
      }
    }
    const allUpdates = items.every(item => item.kind === 'stack'
      ? publicationStackAction(item).updating
      : item.record?.action === 'pr_update')
    const allStacks = items.every(item => item.kind === 'stack')
    return {
      kind: 'publish-items',
      items,
      label: allStacks && items.length === 2
        ? `${allUpdates ? 'Update' : 'Send'} both stacks`
        : `${allUpdates ? 'Update' : 'Send'} all ${items.length}${allStacks ? ' stacks' : ''}`,
      description: 'Confirm the complete reviewed units once, then publish every included action.',
    }
  }
  return {
    kind: 'fix-prepared',
    items,
    label: items.length === 1 ? 'Fix and review' : `Fix and review all ${items.length}`,
    description: 'Give every incomplete private review to the agent in one pass.',
  }
}
