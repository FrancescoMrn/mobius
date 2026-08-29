/* Complete chat-scoped contribution control surface. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from '@openai/apps-sdk-ui/components/Icon'
import useDialogFocus from '../../hooks/useDialogFocus.js'
import { formatRelativeTime } from '../../lib/relativeTime.js'
import FileDiffList from '../DiffView/FileDiffList.jsx'
import {
  chatChangesPrimaryAction,
  preparedChangesPrimaryAction,
} from './chatContributionIntent.js'
import {
  CHANGE_STAGES,
  compactChangesSummary,
  contributionNeedsAttention,
  groupUnsortedFiles,
  initialChangesStage,
} from './chatChangesLifecycle.js'
import {
  autopilotOnSend,
  contributionReviewIntent,
  currentReviewItems,
  publicationAction,
  publicationFailureOwner,
  publicationItemsAction,
  publicationStackAction,
  reviewItems,
  sendBlocker,
  stackSendBlocker,
} from './contributionReviewModel.js'
import { useChatChangesOverview } from './useChatChangesOverview.js'
import {
  projectPublishedContribution,
  publishContribution,
  publishContributionStack,
} from './chatContributionPublication.js'
import './ChatWork.css'

const STAGE_LABELS = {
  unsorted: 'Unsorted',
  prepared: 'Prepared',
  open: 'Open',
  settled: 'Settled',
}

function updateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatRelativeTime(new Date(value).toISOString())
  }
  return formatRelativeTime(value)
}

function lifecycleStatus(record, stage) {
  if (record?.kind === 'local') return 'Kept local'
  if (contributionNeedsAttention(record)) return 'Needs attention'
  if (record?.status === 'submitting') return 'Publishing'
  if (record?.status === 'draft') return 'Draft PR'
  if (record?.status === 'landing') return 'Merging'
  if (record?.status === 'superseded') return 'Already shared'
  if (record?.status === 'closed') return 'Closed, not merged'
  if (stage === 'prepared') return 'Private review'
  if (stage === 'open') return 'PR open'
  return 'Merged'
}

function recordRevision(record) {
  return `${record?.id || ''}:${record?.action_key || record?.updated_at || ''}:${record?.status || ''}`
}

function preparedItemRevision(item) {
  if (item?.kind === 'record') return recordRevision(item.record)
  return `${item?.id || ''}:${(item?.records || []).map(recordRevision).join('|')}`
}

function localDispositionLabel(record) {
  return {
    'local-only': 'Local to this instance',
    personal: 'Personal work',
    experimental: 'Experimental work',
    'incoming-only': 'Incoming work',
    duplicate: 'Already covered elsewhere',
  }[record?.disposition] || 'Kept local'
}

function EmptyStage({ stage, hasRecordedEdits }) {
  const copy = {
    unsorted: hasRecordedEdits
      ? ['Everything is organized', 'Every recorded edit is covered by prepared or public work.']
      : ['No file changes yet', 'Edits made through this chat will collect here automatically.'],
    prepared: ['Nothing prepared', 'Private reviews created from this chat will appear here.'],
    open: ['No open pull requests', 'Published work stays here while it moves through review and checks.'],
    settled: ['Nothing settled yet', 'Merged, closed, and already-shared work will collect here.'],
  }[stage]
  return (
    <div className="chat-work__empty">
      <strong>{copy[0]}</strong>
      <span>{copy[1]}</span>
    </div>
  )
}

export default function ChatDiffViewer({
  chatId,
  initialEntries,
  onClose,
  onPrepareChanges,
  onPrepareProject,
  onContributeAll,
  onCheckUpdates,
  onOpenApp,
  onContinueInChat,
  returnFocusRef,
  turnActive = false,
}) {
  const queryClient = useQueryClient()
  const overview = useChatChangesOverview(chatId, initialEntries)
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const expansionSequenceRef = useRef(0)
  const stageSeededRef = useRef(false)
  const [activeStage, setActiveStage] = useState('unsorted')
  const [expansionCommand, setExpansionCommand] = useState(null)
  const [accepted, setAccepted] = useState(() => new Set())
  const [failures, setFailures] = useState({})
  const [confirming, setConfirming] = useState(null)
  const [publishPhase, setPublishPhase] = useState(null)
  const publishInFlightRef = useRef(false)

  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    restoreFocusRef: returnFocusRef,
    onClose,
  })

  useEffect(() => {
    if (overview.loading || stageSeededRef.current) return
    stageSeededRef.current = true
    setActiveStage(initialChangesStage(overview))
  }, [overview])

  const unsortedGroups = useMemo(
    () => groupUnsortedFiles(overview.unsortedFiles),
    [overview.unsortedFiles],
  )
  const visibleRecords = (overview.stages[activeStage] || []).filter(
    record => !accepted.has(recordRevision(record)),
  )
  const visiblePrepared = overview.stages.prepared.filter(
    record => !accepted.has(recordRevision(record)),
  )
  const visiblePreparedItems = reviewItems({
    ...(overview.contributions || {}),
    records: visiblePrepared,
  })
  const summary = compactChangesSummary(overview)
  const shortenedCount = overview.unsortedEntries.filter(entry => entry.preview?.truncated).length
  const lifecycleAction = chatChangesPrimaryAction(overview)
  const primaryAction = lifecycleAction?.kind === 'review'
    ? preparedChangesPrimaryAction(visiblePreparedItems, {
        connected: overview.contributions?.connected !== false,
      })
    : lifecycleAction
  const confirmingAction = confirming ? publicationItemsAction(confirming) : null

  function consume(record) {
    setAccepted(current => new Set(current).add(recordRevision(record)))
  }

  function release(record, failure) {
    const key = recordRevision(record)
    setAccepted(current => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    setFailures(current => ({ ...current, [record.id]: failure }))
  }

  function setEveryDiffExpanded(expanded) {
    expansionSequenceRef.current += 1
    setExpansionCommand({ id: expansionSequenceRef.current, expanded })
  }

  function openContribute(record = null, intent = '') {
    const resolvedIntent = intent || contributionReviewIntent(record) || 'reviews:queue'
    if (!overview.contributeApp || !onOpenApp) return
    onOpenApp(overview.contributeApp, { final: true, intent: resolvedIntent })
    onClose?.()
  }

  function continueInChat(record) {
    consume(record)
    onContinueInChat?.(record)
    onClose?.()
  }

  function runPrimaryAction() {
    if (!primaryAction) return
    if (primaryAction.kind === 'prepare') {
      onPrepareChanges?.(overview.unsortedRevision)
      onClose?.()
      return
    }
    if (primaryAction.kind === 'finish') {
      onContributeAll?.(overview.workflowRevision)
      onClose?.()
      return
    }
    if (primaryAction.kind === 'publish-items') {
      setConfirming(primaryAction.items)
      return
    }
    if (primaryAction.kind === 'fix-prepared') {
      onContributeAll?.(overview.workflowRevision)
      onClose?.()
      return
    }
    if (primaryAction.kind === 'updates') {
      onCheckUpdates?.(overview.stages.open)
      onClose?.()
    }
  }

  async function publish(record) {
    consume(record)
    setFailures(current => ({ ...current, [record.id]: null }))
    const outcome = await publishContribution({
      appId: overview.contributeAppId,
      record,
      autopilot: overview.contributions?.autopilot_available === true
        && overview.contributions?.autopilot_default !== false,
      refetch: overview.contributionsQuery.refetch,
    })
    if (outcome.kind === 'published') {
      queryClient.setQueryData(overview.contributionsQuery.queryKey, current => (
        projectPublishedContribution(current, record.id, outcome.publication)
      ))
      return { ok: true }
    }
    if (outcome.kind === 'reconciled') {
      return { ok: true, reconciled: true }
    }
    if (publicationFailureOwner(outcome.failure) === 'owner') {
      release(record, outcome.failure)
      return { ok: false, owner: true }
    }
    return { ok: false, recover: outcome.record }
  }

  function consumeItem(item) {
    if (item?.kind === 'stack') item.records.forEach(consume)
    else if (item?.record) consume(item.record)
  }

  function releaseItem(item, failure) {
    if (item?.kind === 'stack') item.records.forEach(record => release(record, failure))
    else if (item?.record) release(item.record, failure)
  }

  async function publishStack(item) {
    consumeItem(item)
    const outcome = await publishContributionStack({
      appId: overview.contributeAppId,
      item,
      refetch: overview.contributionsQuery.refetch,
    })
    if (outcome.kind === 'published' || outcome.kind === 'reconciled') {
      return { ok: true }
    }
    if (publicationFailureOwner(outcome.failure) === 'owner') {
      releaseItem(item, outcome.failure)
      return { ok: false, owner: true }
    }
    return { ok: false, recover: true }
  }

  async function publishBatch(items) {
    if (publishInFlightRef.current) return
    publishInFlightRef.current = true
    setPublishPhase('checking')
    const refreshed = await overview.contributionsQuery.refetch().catch(() => null)
    const current = refreshed?.data
      ? currentReviewItems(items, refreshed.data)
      : items
    if (!current) {
      setConfirming(null)
      setPublishPhase(null)
      publishInFlightRef.current = false
      return
    }
    setPublishPhase('publishing')
    const outcomes = []
    for (const item of current) {
      outcomes.push(item.kind === 'stack'
        ? await publishStack(item)
        : await publish(item.record))
    }
    if (outcomes.some(outcome => outcome?.recover)) {
      // The requests above already reconciled the ledger. One batch has one
      // recovery intent, based on current state rather than the stale click.
      onContributeAll?.()
      onClose?.()
    }
    setConfirming(null)
    setPublishPhase(null)
    publishInFlightRef.current = false
  }

  const latestUnsortedTime = overview.unsortedEntries.reduce((latest, entry) => (
    typeof entry?.ts === 'number' && entry.ts > latest ? entry.ts : latest
  ), 0)

  return (
    <div className="chat-work__overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="chat-work chat-work--diffs chat-work--lifecycle"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-work-diff-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="chat-work__head">
          <div>
            <h2 id="chat-work-diff-title">Changes from this chat</h2>
            <p>{summary}</p>
          </div>
          <button ref={closeRef} type="button" className="chat-work__close" onClick={onClose} aria-label="Close changes">
            <X width={19} height={19} />
          </button>
        </header>

        <section className="chat-work__primary-actions" aria-label="Contribution actions">
          <div>
            <strong>{primaryAction ? 'Next contribution step' : 'Contribution history'}</strong>
            <span>{primaryAction?.description || 'Prepared work, pull requests, and settled decisions stay connected to this chat.'}</span>
          </div>
          <div className="chat-work__primary-buttons">
            {primaryAction ? (
              <button type="button" className="is-primary" onClick={runPrimaryAction}>
                {primaryAction.label}
              </button>
            ) : null}
          </div>
        </section>

        <div className="chat-work__stages" role="tablist" aria-label="Change stages">
          {CHANGE_STAGES.map(stage => (
            <button
              type="button"
              role="tab"
              key={stage}
              id={`chat-work-tab-${stage}`}
              aria-controls={`chat-work-panel-${stage}`}
              className={activeStage === stage ? 'is-active' : ''}
              aria-selected={activeStage === stage}
              tabIndex={activeStage === stage ? 0 : -1}
              onClick={() => setActiveStage(stage)}
            >
              <span>{STAGE_LABELS[stage]}</span>
              <b>{overview.counts[stage] || 0}</b>
            </button>
          ))}
        </div>

        <div className="chat-work__stage-actions">
          {activeStage === 'unsorted' && overview.unsortedEntries.length > 0 ? (
            <>
              <button type="button" onClick={() => setEveryDiffExpanded(true)}>Expand all</button>
              <button type="button" onClick={() => setEveryDiffExpanded(false)}>Collapse all</button>
            </>
          ) : null}
        </div>

        <div
          id={`chat-work-panel-${activeStage}`}
          className="chat-work__body"
          role="tabpanel"
          aria-labelledby={`chat-work-tab-${activeStage}`}
        >
          {overview.loading && !overview.hasWork ? (
            <p className="chat-work__state" role="status">Loading changes…</p>
          ) : overview.error && !overview.hasWork ? (
            <p className="chat-work__state chat-work__state--error" role="alert">Could not refresh this chat’s complete change history.</p>
          ) : activeStage === 'unsorted' ? (
            unsortedGroups.length > 0 ? (
              <div className="chat-work__updates">
                {overview.error ? <p className="chat-work__notice">Showing the changes already loaded in this chat.</p> : null}
                {shortenedCount > 0 ? <p className="chat-work__notice">{shortenedCount} older {shortenedCount === 1 ? 'update is' : 'updates are'} excerpt-only.</p> : null}
                {unsortedGroups.map(group => (
                  <section className="chat-work__update" key={group.id}>
                    <div className="chat-work__update-head">
                      <div>
                        <span className="chat-work__update-number">{group.label}</span>
                        <strong>{group.files.length} {group.files.length === 1 ? 'file' : 'files'}</strong>
                      </div>
                      <div className="chat-work__update-head-actions">
                        {latestUnsortedTime ? <span>{updateTime(latestUnsortedTime)}</span> : null}
                        {onPrepareProject ? (
                          <button type="button" onClick={() => { onPrepareProject(group, overview.unsortedRevision); onClose?.() }}>Prepare</button>
                        ) : null}
                      </div>
                    </div>
                    <FileDiffList files={group.files} diffTruncated={shortenedCount > 0} expansionCommand={expansionCommand} />
                  </section>
                ))}
              </div>
            ) : <EmptyStage stage="unsorted" hasRecordedEdits={overview.counts.files > 0} />
          ) : activeStage === 'prepared' && visiblePreparedItems.length > 0 ? (
            <div className="chat-work__contributions">
              {visiblePreparedItems.map(item => {
                const stack = item.kind === 'stack'
                const representative = stack
                  ? item.records.find(record => visiblePrepared.some(row => row.id === record.id))
                    || item.records.at(-1)
                  : item.record
                const blocker = stack
                  ? stackSendBlocker(item, { connected: overview.contributions?.connected !== false })
                  : sendBlocker(representative, { connected: overview.contributions?.connected !== false })
                const action = stack
                  ? publicationStackAction(item)
                  : publicationAction(representative)
                const meta = [
                  representative?.repo,
                  stack ? `${item.records.length} linked changes` : '',
                  updateTime(representative?.updated_at),
                ].filter(Boolean).join(' · ')
                return (
                  <article className="chat-work__contribution is-prepared" key={preparedItemRevision(item)}>
                    <div className="chat-work__contribution-copy">
                      <span className="chat-work__contribution-state">{stack ? 'Private stack' : 'Private review'}</span>
                      <strong>{stack
                        ? item.stack?.name || representative?.summary || 'Linked contribution'
                        : representative?.summary || representative?.title || 'Contribution from this chat'}</strong>
                      {meta ? <small>{meta}</small> : null}
                      {blocker ? <small>{blocker}</small> : null}
                    </div>
                    <div className="chat-work__contribution-actions">
                      {!blocker ? (
                        <>
                          <button type="button" className="is-primary" onClick={() => setConfirming([item])}>{action.label}</button>
                          <button type="button" onClick={() => openContribute(representative)}>Details</button>
                        </>
                      ) : (
                        <>
                          {onContributeAll ? (
                            <button type="button" className="is-primary" onClick={() => {
                              consumeItem(item)
                              onContributeAll?.(overview.workflowRevision)
                              onClose?.()
                            }}>Fix and review</button>
                          ) : null}
                          <button type="button" onClick={() => openContribute(representative)}>Details</button>
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : visibleRecords.length > 0 ? (
            <div className="chat-work__contributions">
              {visibleRecords.map(record => {
                const attention = contributionNeedsAttention(record)
                const canOpenPr = typeof record?.url === 'string' && record.url.startsWith('https://github.com/')
                const blocker = activeStage === 'prepared'
                  ? sendBlocker(record, { connected: overview.contributions?.connected !== false })
                  : null
                const action = publicationAction(record)
                const number = Number(record?.number)
                const meta = [record?.repo, Number.isInteger(number) && number > 0 ? `PR #${number}` : '', updateTime(record?.updated_at)].filter(Boolean).join(' · ')
                return (
                  <article className={`chat-work__contribution is-${activeStage}${attention ? ' needs-attention' : ''}`} key={recordRevision(record)}>
                    <div className="chat-work__contribution-copy">
                      <span className="chat-work__contribution-state">{lifecycleStatus(record, activeStage)}</span>
                      <strong>{record?.summary || record?.title || (record?.kind === 'local' ? localDispositionLabel(record) : 'Contribution from this chat')}</strong>
                      {meta ? <small>{meta}</small> : null}
                      {record?.kind === 'local' ? <code>{record.path}</code> : null}
                      {failures[record.id] ? <small className="is-error">{failures[record.id].message}</small> : null}
                    </div>
                    <div className="chat-work__contribution-actions">
                      {attention && onContinueInChat ? (
                        <button type="button" className="is-primary" onClick={() => continueInChat(record)}>
                          Ask agent to fix
                        </button>
                      ) : activeStage === 'prepared' && !blocker ? (
                        <>
                          <button type="button" className="is-primary" onClick={() => setConfirming([{ kind: 'record', id: record.id, record }])}>{action.label}</button>
                          <button type="button" onClick={() => openContribute(record)}>Review</button>
                        </>
                      ) : activeStage === 'prepared' ? (
                        <>
                          {onContinueInChat ? (
                            <button type="button" className="is-primary" onClick={() => continueInChat(record)}>Fix and review</button>
                          ) : null}
                          <button type="button" onClick={() => openContribute(record)}>Details</button>
                        </>
                      ) : activeStage === 'open' ? (
                        <>
                          {canOpenPr ? <a href={record.url} target="_blank" rel="noopener noreferrer">Open PR</a> : null}
                          {onCheckUpdates ? <button type="button" onClick={() => { onCheckUpdates([record]); onClose?.() }}>Check for update</button> : null}
                        </>
                      ) : record?.kind === 'local' ? null : canOpenPr ? (
                        <a href={record.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a>
                      ) : (
                        <button type="button" onClick={() => openContribute(record)}>Details</button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : <EmptyStage stage={activeStage} hasRecordedEdits={overview.counts.files > 0} />}
        </div>

        {confirming ? (
          <div className="chat-work__confirm" role="alertdialog" aria-label="Confirm public contribution actions">
            <div>
              <strong>{confirmingAction.promptLabel}</strong>
              <span>GitHub will receive only these exact reviewed heads. Nothing will be merged.</span>
            </div>
            <div>
              <button type="button" disabled={Boolean(publishPhase)} onClick={() => setConfirming(null)}>Keep private</button>
              <button type="button" className="is-primary" disabled={Boolean(publishPhase)} onClick={() => publishBatch(confirming)}>
                {publishPhase === 'checking'
                  ? 'Checking…'
                  : publishPhase === 'publishing'
                    ? confirmingAction.updating ? 'Updating…' : 'Sending…'
                    : confirmingAction.confirmLabel}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
