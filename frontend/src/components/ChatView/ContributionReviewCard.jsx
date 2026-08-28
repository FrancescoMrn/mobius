import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from '@openai/apps-sdk-ui/components/Icon'
import { api } from '../../api/client.js'
import { appQueries } from '../../hooks/queries.js'
import { captureLayoutSpace, clientLengthToLayout } from '../../lib/layoutSpace.js'
import {
  autopilotOnSend,
  contributionRecoveryAction,
  contributionReviewIntent,
  currentReviewItems,
  diffStatSummary,
  isTrackingRecord,
  isHorizontalSwipe,
  passedDismissThreshold,
  publicationAction,
  publicationFailureOwner,
  publicationItemsAction,
  publicationStackAction,
  rememberReviewItemDismissed,
  reviewActionKey,
  reviewItemIntent,
  reviewGroupDefault,
  reviewPanelSummary,
  sendBlocker,
  stackSendBlocker,
  statusLabel,
  trackingNarration,
  trackingStatusLabel,
  visibleReviewItems,
} from './contributionReviewModel.js'
import {
  isUnsortedDismissed,
  rememberUnsortedDismissed,
} from './chatChangesLifecycle.js'
import { useChatChangesOverview } from './useChatChangesOverview.js'
import {
  projectPublishedContribution,
  publishContribution,
  publishContributionStack,
} from './chatContributionPublication.js'
import './ContributionReviewCard.css'

function itemRevision(item) {
  if (item?.kind === 'unsorted') return item.id
  if (item?.kind === 'record') {
    return reviewActionKey(item.record)
  }
  return `${item?.id || ''}:${(item?.records || [])
    .map(record => reviewActionKey(record))
    .join('|')}`
}

export default function ContributionReviewCard({
  chatId,
  turnActive,
  initialChangeEntries = [],
  onOpenApp,
  onContinueInChat,
  onOpenChanges,
  onPrepareChanges,
  onContributeAll,
}) {
  const queryClient = useQueryClient()
  const overview = useChatChangesOverview(chatId, initialChangeEntries)
  const {
    contributeAppId: appId,
    contributeApp,
    contributions: data,
    contributionsQuery,
  } = overview
  const queryKey = contributionsQuery.queryKey
  const { data: appToken } = appQueries.token.useQuery(appId)
  const [dismissRevision, setDismissRevision] = useState(0)
  const [accepted, setAccepted] = useState(() => new Set())
  const acceptedRef = useRef(new Set())
  const [actionFailures, setActionFailures] = useState({})
  const [confirmingItems, setConfirmingItems] = useState(null)
  const [batchPhase, setBatchPhase] = useState(null)
  const batchInFlightRef = useRef(false)
  const storage = typeof localStorage !== 'undefined' ? localStorage : null

  const wasActive = useRef(turnActive)
  useEffect(() => {
    if (wasActive.current && !turnActive) {
      acceptedRef.current = new Set()
      setAccepted(new Set())
    }
    wasActive.current = turnActive
  }, [turnActive])

  const unsortedItem = {
    kind: 'unsorted',
    id: `unsorted:${overview.unsortedRevision}`,
  }
  const unsortedVisible = !turnActive
    && overview.counts.unsorted > 0
    && !isUnsortedDismissed(chatId, overview.unsortedRevision, storage)
  const allItems = [
    ...(unsortedVisible ? [unsortedItem] : []),
    ...visibleReviewItems(data, storage),
  ]
  const pendingItems = allItems.filter(item => !accepted.has(itemRevision(item)))
  const panel = reviewPanelSummary(pendingItems)
  const grouped = panel.count > 1
  const groupDefault = reviewGroupDefault(pendingItems, {
    connected: data?.connected !== false,
  })
  const groupNeedsAgent = groupDefault?.kind !== 'publish-items'
  void dismissRevision
  if (!appId || panel.count === 0) return null

  function consume(item) {
    const key = itemRevision(item)
    if (!key || acceptedRef.current.has(key)) return false
    acceptedRef.current.add(key)
    setAccepted(new Set(acceptedRef.current))
    return true
  }

  function release(item, failure) {
    const key = itemRevision(item)
    acceptedRef.current.delete(key)
    setAccepted(new Set(acceptedRef.current))
    const failureKey = item?.record?.id || item?.id
    if (failureKey && failure) {
      setActionFailures(current => ({ ...current, [failureKey]: failure }))
    }
  }

  async function startRecovery(record) {
    const recovery = contributionRecoveryAction(record)
    if (!appToken || !recovery) return false
    let timezone = 'UTC'
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch {}
    try {
      const response = await api.appChats.startWithToken(appToken, {
        title: recovery.title,
        scope: recovery.scope,
        scope_label: recovery.scopeLabel,
        owner_visible: true,
        content: recovery.draft,
        cid: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `cid-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timezone,
      })
      const body = await response.json().catch(() => null)
      return response.ok && Boolean(body?.chat_id)
    } catch {
      return false
    }
  }

  async function publishItem(item, { deferRecovery = false } = {}) {
    const record = item.record
    if (!record) return
    if (!consume(item)) return
    setActionFailures(current => ({ ...current, [record.id]: null }))
    const outcome = await publishContribution({
      appId,
      record,
      autopilot: autopilotOnSend(data),
      refetch: contributionsQuery.refetch,
    })
    if (outcome.kind === 'published') {
      queryClient.setQueryData(queryKey, current => (
        projectPublishedContribution(current, record.id, outcome.publication)
      ))
      return outcome
    }
    if (outcome.kind === 'reconciled') return outcome

    if (publicationFailureOwner(outcome.failure) === 'agent') {
      if (deferRecovery) return { ...outcome, needsRecovery: true }
      const started = await startRecovery(outcome.record)
      if (started) return { ...outcome, recoveryStarted: true }
    }
    release(item, outcome.failure)
    return outcome
  }

  async function fixItem(item) {
    const record = item.record
    if (!record) return
    if (!consume(item)) return
    const started = await startRecovery(record)
    if (!started) {
      release(item, {
        message: 'The review agent could not start. Try again or open the details.',
      })
    }
  }

  async function publishStackItem(item, { deferRecovery = false } = {}) {
    if (!consume(item)) return
    setActionFailures(current => ({ ...current, [item.id]: null }))
    const outcome = await publishContributionStack({
      appId,
      item,
      refetch: contributionsQuery.refetch,
    })
    if (outcome.kind === 'published' || outcome.kind === 'reconciled') return outcome
    if (publicationFailureOwner(outcome.failure) === 'agent'
      && typeof onContributeAll === 'function') {
      if (deferRecovery) return { ...outcome, needsRecovery: true }
      // The failed request already reconciled the ledger. Do not send the
      // obsolete pre-click revision back through the freshness guard.
      onContributeAll()
      return { ...outcome, recoveryStarted: true }
    }
    release(item, outcome.failure)
    return outcome
  }

  async function publishConfirmedItems() {
    if (batchInFlightRef.current) return
    const snapshot = Array.isArray(confirmingItems) ? confirmingItems : []
    if (snapshot.length === 0) return
    batchInFlightRef.current = true
    setBatchPhase('checking')
    const refreshed = await contributionsQuery.refetch().catch(() => null)
    const current = refreshed?.data
      ? currentReviewItems(snapshot, refreshed.data)
      : snapshot
    if (!current) {
      setConfirmingItems(null)
      setBatchPhase(null)
      batchInFlightRef.current = false
      return
    }
    setBatchPhase('publishing')
    const outcomes = []
    for (const item of current) {
      outcomes.push(item.kind === 'stack'
        ? await publishStackItem(item, { deferRecovery: true })
        : await publishItem(item, { deferRecovery: true }))
    }
    const recoveries = outcomes
      .map((outcome, index) => outcome?.needsRecovery ? [current[index], outcome] : null)
      .filter(Boolean)
    if (recoveries.length > 0) {
      if (typeof onContributeAll === 'function') {
        // One batch intent owns one recovery, even when several stack requests
        // report the same stale or transient failure.
        onContributeAll()
      } else {
        recoveries.forEach(([item, outcome]) => release(item, outcome.failure))
      }
    }
    setConfirmingItems(null)
    setBatchPhase(null)
    batchInFlightRef.current = false
  }

  function acceptPrivate(item, callback) {
    if (typeof callback !== 'function') return
    if (!consume(item)) return
    callback()
  }

  async function runGroupDefault() {
    if (!groupDefault || batchInFlightRef.current) return
    if (groupDefault.kind === 'contribute') {
      if (typeof onContributeAll !== 'function') return
      const direct = pendingItems.filter(item => (
        item.kind === 'record'
        && item.record?.status === 'prepared'
        && !sendBlocker(item.record, { connected: data?.connected !== false })
      ))
      const agent = pendingItems.filter(item => !direct.includes(item))
      await Promise.all(direct.map(publishItem))
      const claimed = agent.filter(consume)
      if (claimed.length > 0) onContributeAll(overview.workflowRevision)
      return
    }
    if (groupDefault.kind === 'review') {
      if (typeof onContributeAll !== 'function') return
      const claimed = pendingItems.filter(consume)
      if (claimed.length > 0) onContributeAll(overview.workflowRevision)
      return
    }
    if (groupDefault.kind === 'publish-items') {
      setConfirmingItems(groupDefault.items)
    }
  }

  function dismissAll() {
    if (batchInFlightRef.current) return
    setConfirmingItems(null)
    for (const item of pendingItems) {
      if (item.kind === 'unsorted') {
        rememberUnsortedDismissed(chatId, overview.unsortedRevision, storage)
      } else {
        rememberReviewItemDismissed(item, storage)
      }
    }
    setDismissRevision(value => value + 1)
  }

  return (
    <div
      className={`contrib-card-stack${grouped ? ' contrib-card-stack--grouped' : ''}`}
      role={grouped ? 'region' : undefined}
      aria-label={grouped ? panel.title : undefined}
    >
      {grouped ? (
        <div className="contrib-card-stack__heading">
          <div className="contrib-card-stack__heading-copy">
            <div className="contrib-card-stack__title">{panel.title}</div>
            <div className="contrib-card-stack__copy">{panel.copy}</div>
          </div>
          <div className="contrib-card-stack__heading-actions">
            {groupDefault ? (
              <button
                type="button"
                className="contrib-card-stack__default"
                disabled={Boolean(batchPhase) || (turnActive && groupNeedsAgent)}
                onClick={runGroupDefault}
              >
                {groupDefault.label}
              </button>
            ) : null}
            <button
              type="button"
              className="contrib-card-stack__dismiss-all"
              disabled={Boolean(batchPhase)}
              aria-label="Dismiss all — keeps the work in Changes and Contribute"
              onClick={dismissAll}
            >
              <X width={16} height={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {pendingItems.map(item => {
        if (item.kind === 'unsorted') {
          return (
            <UnsortedChangesRow
              key={itemRevision(item)}
              fileCount={overview.counts.unsorted}
              updateCount={overview.unsortedEntries.length}
              onOpenChanges={onOpenChanges}
              onPrepareChanges={() => acceptPrivate(item, () => onPrepareChanges?.(overview.unsortedRevision))}
              onDismiss={() => {
                rememberUnsortedDismissed(chatId, overview.unsortedRevision, storage)
                setDismissRevision(value => value + 1)
              }}
            />
          )
        }
        const onDismiss = () => {
          rememberReviewItemDismissed(item, storage)
          setDismissRevision(value => value + 1)
        }
        const onOpenContribute = contributeApp && onOpenApp
          ? intent => {
              onOpenApp(contributeApp, { final: true, intent })
              onDismiss()
            }
          : null
        if (item.kind === 'stack') {
          const blocker = stackSendBlocker(item, {
            connected: data?.connected !== false,
          })
          return (
            <StackReviewRow
              key={itemRevision(item)}
              item={item}
              blocker={blocker}
              failure={actionFailures[item.id]}
              onPublish={() => setConfirmingItems([item])}
              onOpenContribute={onOpenContribute}
              onStartAgent={turnActive ? null : () => acceptPrivate(item, () => onContributeAll?.(overview.workflowRevision))}
              onDismiss={onDismiss}
            />
          )
        }
        const record = item.record
        if (isTrackingRecord(record)) {
          return (
            <TrackingRow
              key={itemRevision(item)}
              record={record}
              onContinueInChat={turnActive ? null : () => acceptPrivate(item, () => onContinueInChat?.(record))}
              onDismiss={onDismiss}
            />
          )
        }
        return (
          <ReviewRow
            key={itemRevision(item)}
            record={record}
            connected={data?.connected !== false}
            onPublish={() => publishItem(item)}
            onFix={turnActive ? null : () => fixItem(item)}
            onOpenContribute={onOpenContribute}
            onDismiss={onDismiss}
            failure={actionFailures[record.id]}
          />
        )
      })}
      {confirmingItems ? (
        <StackPublicationConfirmation
          items={confirmingItems}
          phase={batchPhase}
          onCancel={() => setConfirmingItems(null)}
          onConfirm={publishConfirmedItems}
        />
      ) : null}
    </div>
  )
}

function UnsortedChangesRow({
  fileCount, updateCount, onOpenChanges, onPrepareChanges, onDismiss,
}) {
  const cardRef = useSwipeToDismiss(onDismiss)
  return (
    <div ref={cardRef} className="contrib-card contrib-card--unsorted">
      <div className="contrib-card__topline">
        <span>Ready to organize</span>
        <button
          type="button"
          className="contrib-card__dismiss"
          aria-label="Dismiss — keeps the work in Changes"
          onClick={() => onDismiss?.()}
        >
          <X width={14} height={14} aria-hidden="true" />
        </button>
      </div>
      <p className="contrib-card__summary">
        {fileCount} {fileCount === 1 ? 'file has' : 'files have'} changes that are not yet organized.
      </p>
      <p className="contrib-card__meta">
        {updateCount} {updateCount === 1 ? 'recorded update' : 'recorded updates'} from this chat
      </p>
      <p className="contrib-card__payoff">
        The agent can sort reusable work into private reviews. Nothing is published.
      </p>
      <div className="contrib-card__actions">
        <button
          type="button"
          className="contrib-card__send"
          disabled={typeof onPrepareChanges !== 'function'}
          onClick={() => onPrepareChanges?.()}
        >
          Prepare contributions
        </button>
        <button
          type="button"
          className="contrib-card__review"
          disabled={typeof onOpenChanges !== 'function'}
          onClick={() => onOpenChanges?.()}
        >
          View changes
        </button>
      </div>
    </div>
  )
}


/**
 * Swipe-to-dismiss, either direction, for any card shape in this file.
 *
 * Bound NATIVELY with a non-passive touchmove for the same reason the navigation
 * drawer's handlers are: React's touch props are passive, so they can watch a
 * gesture but never claim it, and `touch-action` cannot cover for that on iOS
 * (WebKit does not implement the pan-* keywords). Claiming is what stops the
 * surface underneath from taking the drag.
 *
 * It lives as a hook rather than inside one card because every actionable card
 * here needs the same exit.
 */
function useSwipeToDismiss(onDismiss) {
  const cardRef = useRef(null)
  const swipe = useRef({ x: 0, y: 0, active: false, claimed: false, layoutSpace: null })
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const el = cardRef.current
    if (!el) return undefined
    let dismissTimer = null

    const clear = () => {
      el.classList.remove('contrib-card--dragging')
      el.style.transform = ''
      el.style.opacity = ''
    }
    const onStart = (event) => {
      if (event.touches.length !== 1) { swipe.current.active = false; return }
      swipe.current = {
        x: event.touches[0].clientX, y: event.touches[0].clientY,
        active: true, claimed: false,
        layoutSpace: captureLayoutSpace(el),
      }
    }
    const onMove = (event) => {
      const state = swipe.current
      if (!state.active || event.touches.length !== 1) return
      const dx = event.touches[0].clientX - state.x
      const dy = event.touches[0].clientY - state.y
      // Vertical movement belongs to the expanded details scroller; only a
      // decisively sideways drag becomes a dismissal, and once claimed it stays
      // claimed for the rest of the gesture.
      if (!state.claimed && !isHorizontalSwipe(dx, dy)) return
      state.claimed = true
      event.preventDefault()
      el.classList.add('contrib-card--dragging')
      const layoutDx = clientLengthToLayout(dx, state.layoutSpace)
      el.style.transform = `translateX(${layoutDx}px)`
      el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 260))
    }
    const onEnd = (event) => {
      const state = swipe.current
      state.active = false
      if (!state.claimed) return
      state.claimed = false
      const touch = event.changedTouches[0]
      const dx = touch.clientX - state.x
      const dy = touch.clientY - state.y
      el.classList.remove('contrib-card--dragging')
      if (passedDismissThreshold(dx, dy)) {
        el.style.transform = `translateX(${dx > 0 ? '110%' : '-110%'})`
        el.style.opacity = '0'
        dismissTimer = window.setTimeout(() => dismissRef.current?.(), 160)
        return
      }
      clear()
    }
    const onCancel = () => {
      swipe.current.active = false
      swipe.current.claimed = false
      clear()
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      if (dismissTimer !== null) window.clearTimeout(dismissTimer)
    }
  }, [])

  return cardRef
}


function StackReviewRow({
  item, blocker, failure, onPublish, onOpenContribute, onStartAgent, onDismiss,
}) {
  const cardRef = useSwipeToDismiss(onDismiss)
  const total = Number(item.stack?.total) || item.records.length
  const name = item.stack?.name || 'This improvement'
  const intent = reviewItemIntent(item)
  const action = publicationStackAction(item)
  const needsRepair = Boolean(failure || blocker)

  return (
    <div ref={cardRef} className="contrib-card contrib-card--stack">
      <div className="contrib-card__topline">
        <span>{needsRepair ? 'Review together' : 'Ready to send'}</span>
        <button
          type="button"
          className="contrib-card__dismiss"
          aria-label="Dismiss — keeps the stack in Contribute"
          onClick={() => onDismiss?.()}
        >
          <X width={14} height={14} aria-hidden="true" />
        </button>
      </div>
      <p className="contrib-card__summary">
        {name} is ready as a {total}-part contribution stack.
      </p>
      {item.repo ? <p className="contrib-card__meta">{item.repo}</p> : null}
      <p className="contrib-card__payoff">
        {failure?.message || blocker || `${action.count} exact pull requests will open in order after approval.`}
      </p>
      <div className="contrib-card__actions">
        <button
          type="button"
          className="contrib-card__send"
          disabled={needsRepair ? !onStartAgent : !onPublish}
          onClick={() => needsRepair ? onStartAgent?.() : onPublish?.()}
        >
          {needsRepair ? 'Fix and review stack' : action.label}
        </button>
        <button
          type="button"
          className="contrib-card__review"
          disabled={!onOpenContribute || !intent}
          onClick={() => onOpenContribute?.(intent)}
        >
          Details
        </button>
      </div>
    </div>
  )
}

function StackPublicationConfirmation({ items, phase, onCancel, onConfirm }) {
  const action = publicationItemsAction(items)
  const busy = Boolean(phase)
  const busyLabel = phase === 'checking'
    ? 'Checking…'
    : action.updating ? 'Updating…' : 'Sending…'
  return (
    <div
      className="contrib-card-stack__confirm"
      role="alertdialog"
      aria-label="Confirm reviewed contribution actions"
    >
      <strong>{action.promptLabel}</strong>
      <span>GitHub will receive only these exact reviewed heads. Nothing is merged.</span>
      <div className="contrib-card__actions">
        <button type="button" className="contrib-card__review" disabled={busy} onClick={onCancel}>Keep private</button>
        <button type="button" className="contrib-card__send" disabled={busy} onClick={onConfirm}>
          {busy ? busyLabel : action.confirmLabel}
        </button>
      </div>
    </div>
  )
}

function TrackingRow({ record, onContinueInChat, onDismiss }) {
  const cardRef = useSwipeToDismiss(onDismiss)
  const canContinue = record.needs_attention === true
    && typeof onContinueInChat === 'function'
  const number = Number(record.number)
  const meta = [
    record.repo,
    Number.isInteger(number) && number > 0 ? `PR #${number}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div ref={cardRef} className="contrib-card contrib-card--tracking">
      <div className="contrib-card__topline">
        <span>{trackingStatusLabel(record)}</span>
        <button
          type="button"
          className="contrib-card__dismiss"
          aria-label="Dismiss — keeps it in Contribute"
          onClick={() => onDismiss?.()}
        >
          <X width={14} height={14} aria-hidden="true" />
        </button>
      </div>
      <p className="contrib-card__summary">
        {record.summary || record.title || 'Contribution from this chat'}
      </p>
      {meta ? <p className="contrib-card__meta">{meta}</p> : null}
      <p className={record.needs_attention ? 'contrib-card__error' : 'contrib-card__payoff'}>
        {trackingNarration(record)}
      </p>
      {canContinue ? (
        <div className="contrib-card__actions">
          <button
            type="button"
            className="contrib-card__send"
            onClick={() => onContinueInChat(record)}
          >
            Ask agent to fix
          </button>
        </div>
      ) : null}
    </div>
  )
}


function ReviewRow({
  record, connected, onPublish, onFix, onOpenContribute, onDismiss, failure = null,
}) {
  const diffStat = diffStatSummary(record.diff_stat)
  const cardRef = useSwipeToDismiss(onDismiss)
  const intent = contributionReviewIntent(record)
  const blocker = sendBlocker(record, { connected })
  const action = publicationAction(record)

  return (
    <div ref={cardRef} className="contrib-card">
      <div className="contrib-card__topline">
        <span>{failure ? 'Needs your help' : statusLabel(record)}</span>
        <button
          type="button"
          className="contrib-card__dismiss"
          aria-label="Dismiss — keeps it in Contribute"
          onClick={() => onDismiss?.()}
        >
          <X width={14} height={14} aria-hidden="true" />
        </button>
      </div>
      <p className="contrib-card__summary">
        {record.summary || record.title || 'An improvement is ready to contribute'}
      </p>
      {(record.repo || diffStat) ? (
        <p className="contrib-card__meta">
          {record.repo}
          {record.repo && diffStat ? <span> · </span> : null}
          {diffStat ? <span>{diffStat}</span> : null}
        </p>
      ) : null}
      <p className={failure ? 'contrib-card__error' : 'contrib-card__payoff'}>
        {failure?.message || blocker || 'The exact reviewed change is ready for your approval.'}
      </p>
      <div className="contrib-card__actions">
        {!failure && !blocker ? (
          <>
            <button type="button" className="contrib-card__send" onClick={onPublish}>
              {action.label}
            </button>
            <button
              type="button"
              className="contrib-card__review"
              disabled={!onOpenContribute || !intent}
              onClick={() => onOpenContribute?.(intent)}
            >
              Review
            </button>
          </>
        ) : connected === false ? (
          <button type="button" className="contrib-card__send" onClick={() => onOpenContribute?.(intent)}>
            Connect GitHub
          </button>
        ) : (
          <>
            <button type="button" className="contrib-card__send" disabled={!onFix} onClick={onFix}>
              Fix and review
            </button>
            <button type="button" className="contrib-card__review" onClick={() => onOpenContribute?.(intent)}>
              Details
            </button>
          </>
        )}
      </div>
    </div>
  )
}
