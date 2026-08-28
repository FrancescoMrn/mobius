import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTIONABLE_STATUSES,
  CHAT_VISIBLE_STATUSES,
  DISMISS_DX_PX,
  PLATFORM_REPO,
  actionableRecords,
  autopilotOnSend,
  chatCardRecords,
  chatContributionRecords,
  contributeApp,
  contributeAppId,
  contributionFollowupPrompt,
  contributionRecoveryAction,
  contributionRecoveryDraft,
  contributionReviewRunPhase,
  contributionReviewIntent,
  diffStatSummary,
  dismissKey,
  isDismissed,
  isHorizontalSwipe,
  passedDismissThreshold,
  publicationAction,
  publicationFailureOwner,
  publicationItemsAction,
  publicationStackAction,
  reviewActionKey,
  rememberDismissed,
  rememberReviewItemDismissed,
  reviewDestinationLabel,
  reviewItemIntent,
  reviewItems,
  reviewGroupDefault,
  reviewPanelSummary,
  sendBlocker,
  stackSendBlocker,
  statusLabel,
  submitFailure,
  trackingNarration,
  trackingStatusLabel,
  visibleReviewItems,
  visibleRecords,
} from '../contributionReviewModel.js'

const cardSrc = readFileSync(new URL('../ContributionReviewCard.jsx', import.meta.url), 'utf8')
const publicationSrc = readFileSync(new URL('../chatContributionPublication.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../../../api/client.js', import.meta.url), 'utf8')
const cardCss = readFileSync(new URL('../ContributionReviewCard.css', import.meta.url), 'utf8')
const chatViewSrc = readFileSync(new URL('../ChatView.jsx', import.meta.url), 'utf8')

const APPS = [
  { id: 3, slug: 'some-other-app' },
  { id: 8, slug: 'contribute' },
]

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    size: () => map.size,
  }
}

test('the ledger owner is resolved by slug, and a missing app hides the card', () => {
  assert.equal(contributeAppId(APPS), 8)
  assert.equal(contributeAppId([{ id: 3, slug: 'some-other-app' }]), null)
  assert.equal(contributeAppId([]), null)
  assert.equal(contributeAppId(undefined), null)
  assert.equal(contributeApp(APPS, 8).slug, 'contribute')
  assert.equal(contributeApp(APPS, 99), null)
})

test('publication decisions stay distinct from the lifecycle kept in chat', () => {
  const payload = { records: [
    { id: 'a', status: 'prepared' },
    { id: 'b', status: 'submitting' },
    { id: 'c', status: 'open' },
    { id: 'd', status: 'merged' },
    { id: 'e', status: 'closed' },
    { id: 'f' },
  ] }
  assert.deepEqual(actionableRecords(payload).map(record => record.id), ['a', 'b'])
  assert.deepEqual(actionableRecords(null), [])
  assert.deepEqual([...ACTIONABLE_STATUSES], ['prepared', 'submitting'])
  assert.deepEqual(
    chatContributionRecords(payload).map(record => record.id),
    ['a', 'b', 'c', 'd', 'e'],
  )
  assert.deepEqual(
    chatCardRecords(payload).map(record => record.id),
    ['a', 'b'],
  )
  assert.deepEqual(
    chatCardRecords({ records: [{ id: 'attention', status: 'open', needs_attention: true }] })
      .map(record => record.id),
    ['attention'],
  )
  assert.equal(CHAT_VISIBLE_STATUSES.has('abandoned'), false)
})

test('sent contribution status stays plain-language and attention continues in chat', () => {
  assert.equal(trackingStatusLabel({ status: 'open' }), 'PR open')
  assert.equal(trackingStatusLabel({ status: 'merged' }), 'Merged')
  assert.equal(
    trackingStatusLabel({ status: 'open', needs_attention: true }),
    'Needs attention',
  )
  assert.match(trackingNarration({ status: 'open' }), /latest status stays attached/)
  assert.match(
    trackingNarration({ status: 'open', needs_attention: true }),
    /Ask the agent here/,
  )
  const prompt = contributionFollowupPrompt({
    id: 'chat-flow', title: 'Keep the whole contribution in chat',
  })
  assert.match(prompt, /contribution chat-flow/)
  assert.match(prompt, /Keep every further public update behind explicit approval in this chat/)
})

test('every unsettled record remains reachable even when its current review needs attention', () => {
  const payload = { connected: false, records: [
    { id: 'ready', status: 'prepared', review: { state: 'ready' } },
    { id: 'drifted', status: 'prepared', review: { state: 'needs_refresh' } },
    { id: 'unreviewed', status: 'prepared' },
    { id: 'publishing', status: 'submitting' },
  ] }
  assert.deepEqual(
    visibleReviewItems(payload, fakeStorage()).map(item => item.id),
    ['ready', 'drifted', 'unreviewed', 'publishing'],
  )
})

test('record identities become opaque review intents, never routes', () => {
  assert.equal(contributionReviewIntent({ id: 'review.1-ready' }), 'review:review.1-ready')
  assert.equal(contributionReviewIntent({ id: '  review_2  ' }), 'review:review_2')
  assert.equal(contributionReviewIntent({ id: '../escape' }), null)
  assert.equal(contributionReviewIntent({ id: 'has spaces' }), null)
  assert.equal(contributionReviewIntent(null), null)

  assert.equal(
    reviewItemIntent({ kind: 'record', record: { id: 'single' } }),
    'review:single',
  )
  assert.equal(
    reviewItemIntent({ kind: 'stack', records: [{ id: 'layer-1' }, { id: 'layer-2' }] }),
    'review:layer-1',
  )
  assert.equal(reviewItemIntent({ kind: 'stack', records: [] }), null)
})

test('status and destination copy describe the next Contribute view', () => {
  assert.equal(statusLabel({ status: 'prepared' }), 'Review ready')
  assert.equal(statusLabel({
    status: 'prepared', quality_review_ready: true, review: { state: 'ready' },
  }), 'Ready to send')
  assert.equal(statusLabel({
    status: 'prepared', action: 'pr_update', quality_review_ready: true,
    review: { state: 'ready' },
  }), 'Ready to update')
  assert.equal(statusLabel({ status: 'prepared', stack: { id: 'demo' } }), 'Review together')
  assert.equal(statusLabel({ status: 'submitting' }), 'Publishing')
  assert.equal(statusLabel({ status: 'prepared', last_submit_error: 'failed' }), 'Needs attention')

  assert.equal(reviewDestinationLabel({ status: 'prepared' }), 'Review in Contribute')
  assert.equal(
    reviewDestinationLabel({ status: 'prepared', stack: { id: 'demo' } }),
    'Review stack in Contribute',
  )
  assert.equal(reviewDestinationLabel({ status: 'submitting' }), 'View in Contribute')
  assert.equal(
    reviewDestinationLabel({ status: 'prepared', last_submit_error: 'failed' }),
    'Resolve in Contribute',
  )
})

test('direct send requires the exact reviewed happy path', () => {
  const ready = {
    id: 'ready', status: 'prepared', quality_review_ready: true,
    review: { state: 'ready' },
  }
  assert.equal(sendBlocker(ready, { connected: true }), null)
  assert.match(sendBlocker({ ...ready, quality_review_ready: false }), /exact agent review/)
  assert.match(sendBlocker({ ...ready, review: { state: 'needs_refresh', message: 'Moved' } }), /Moved/)
  assert.match(sendBlocker({ ...ready, is_stack: true }), /linked set/)
  assert.match(sendBlocker(ready, { connected: false }), /Connect GitHub/)
  assert.equal(sendBlocker({ ...ready, status: 'submitting' }), null)

  assert.deepEqual(publicationAction(ready), {
    label: 'Send PR', busyLabel: 'Sending PR',
  })
  assert.deepEqual(publicationAction({ ...ready, action: 'pr_update' }), {
    label: 'Update PR', busyLabel: 'Updating PR',
  })
  assert.equal(autopilotOnSend({ autopilot_available: true }), true)
  assert.equal(autopilotOnSend({ autopilot_available: true, autopilot_default: false }), false)
  assert.equal(autopilotOnSend({ autopilot_available: false }), false)
})

test('failed publication becomes a calm recovery action, not another blind send', () => {
  const record = {
    id: 'existing-pr',
    title: 'Refine the existing contribution',
    status: 'prepared',
    last_submit_error: 'The approved pull request is no longer open on this exact branch.',
    last_submit_stage: 'pushed',
    last_submit_push_sha: 'a'.repeat(40),
    plan: { head_sha: 'a'.repeat(40) },
  }
  assert.deepEqual(submitFailure(record), {
    message: 'Contribute could not confirm the update after the reviewed branch reached GitHub.',
    detail: record.last_submit_error,
    code: '',
  })
  assert.match(contributionRecoveryDraft(record), /^Fix and review contribution existing-pr/)
  assert.match(contributionRecoveryDraft(record), /reconcile the contribution record/)
  assert.match(contributionRecoveryDraft(record), /existing approval button/)
  const recovery = contributionRecoveryAction(record)
  assert.equal(recovery.scope, 'contribute-review:b0661670f342e064')
  assert.equal(recovery.scopeLabel, 'Fix and review contribution')
  assert.equal(recovery.draft, contributionRecoveryDraft(record))
  assert.match(cardSrc, />\s*Fix and review\s*</)
  assert.match(cardSrc, />\s*Details\s*</)
  assert.doesNotMatch(cardSrc, /contrib-card__progress/)
  assert.doesNotMatch(chatViewSrc, /handleContributionRecovery|onFixContribution/)
  assert.match(cardSrc, /api\.appChats\.startWithToken\(appToken/)
  assert.match(cardSrc, /async function fixItem/)
  assert.match(cardSrc, /const started = await startRecovery\(record\)/)
  assert.match(cardSrc, /onOpenApp\(contributeApp, \{ final: true, intent \}\)[\s\S]*onDismiss\(\)/)
})

test('agent contribution intents refresh their lifecycle before sending', () => {
  assert.match(
    chatViewSrc,
    /const overview = await refreshContributionOverview\(\)[\s\S]*?overview && !chatChangesActionIsCurrent\(overview, action\)[\s\S]*?await doSend\(prompt/,
  )
  assert.match(chatViewSrc, /kind: 'unsorted', revision/)
  assert.match(chatViewSrc, /kind: 'workflow', revision/)
  assert.match(chatViewSrc, /kind: 'records', recordKeys/)
})

test('existing review runtime becomes one unambiguous continuation state', () => {
  assert.equal(contributionReviewRunPhase({ running: true }), 'running')
  assert.equal(contributionReviewRunPhase({ pending_question_id: 'q1' }), 'waiting')
  assert.equal(contributionReviewRunPhase({ goal: { status: 'paused' } }), 'paused')
  assert.equal(contributionReviewRunPhase({ running: false }), 'existing')
  assert.equal(contributionReviewRunPhase(null), 'existing')
})

test('multiple independent items share one centered bounded panel', () => {
  assert.match(cardSrc, /const panel = reviewPanelSummary\(pendingItems\)/)
  assert.match(cardSrc, /const grouped = panel\.count > 1/)
  assert.match(cardSrc, /contrib-card-stack--grouped/)
  assert.match(cardSrc, /\{panel\.title\}/)
  assert.match(cardSrc, /\{panel\.copy\}/)
  assert.doesNotMatch(cardSrc, /contrib-card-stack__count/)
  assert.match(cardCss, /\.contrib-card-stack\s*\{[\s\S]*?width:\s*min\(100%, 640px\);[\s\S]*?margin-inline:\s*auto;/)
  assert.match(cardCss, /\.contrib-card-stack--grouped\s*\{[\s\S]*?max-height:\s*min\(52vh, 520px\);/)
  assert.match(cardCss, /\.contrib-card-stack--grouped \.contrib-card\s*\{[\s\S]*?border-radius:\s*0;/)
})

test('stack layers collapse into one ordered review item and one exact doorway', () => {
  const payload = { records: [
    { id: 'three', status: 'prepared', repo: PLATFORM_REPO, stack: {
      id: 'drawer', name: 'Drawer navigation', position: 3, total: 3,
    } },
    { id: 'single', status: 'prepared' },
    { id: 'one', status: 'prepared', repo: PLATFORM_REPO, stack: {
      id: 'drawer', name: 'Drawer navigation', position: 1, total: 3,
    } },
    { id: 'two', status: 'prepared', repo: PLATFORM_REPO, stack: {
      id: 'drawer', name: 'Drawer navigation', position: 2, total: 3,
    } },
  ] }
  const items = reviewItems(payload)
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, 'stack')
  assert.deepEqual(items[0].records.map(record => record.id), ['one', 'two', 'three'])
  assert.equal(reviewItemIntent(items[0]), 'review:one')
  assert.equal(items[1].record.id, 'single')

  assert.match(cardSrc, /item\.kind === 'stack'/)
  assert.match(cardSrc, /<StackReviewRow/)
  assert.match(cardSrc, /Fix and review stack/)
  assert.match(cardSrc, /action\.label/)
  assert.doesNotMatch(cardSrc, />Layers</)
})

test('a complete stack from another source chat becomes one direct approval', () => {
  const layer = (id, position) => ({
    id, status: 'prepared', action: 'pr', quality_review_ready: true,
    review: { state: 'ready' }, repo: PLATFORM_REPO,
    stack: { id: 'approval', name: 'Direct approval', position, total: 2 },
  })
  const first = layer('first', 1)
  const second = layer('second', 2)
  const items = reviewItems({
    records: [second],
    stack_units: [{
      id: 'approval', name: 'Direct approval', repo: PLATFORM_REPO,
      records: [first, second],
    }],
  })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].records.map(record => record.id), ['first', 'second'])
  assert.equal(stackSendBlocker(items[0], { connected: true }), null)
  assert.deepEqual(publicationStackAction(items[0]), {
    label: 'Send stack', confirmLabel: 'Send PRs', count: 2, updating: false,
  })
  assert.match(stackSendBlocker({
    ...items[0], records: [second],
  }, { connected: true }), /complete linked set/)

  const partial = reviewItems({
    records: [{ ...first, status: 'draft' }],
    stack_units: [{
      id: 'approval', name: 'Direct approval', repo: PLATFORM_REPO,
      records: [{ ...first, status: 'draft', review: null }, second],
    }],
  })
  assert.equal(partial.length, 1)
  assert.equal(stackSendBlocker(partial[0], { connected: true }), null)
  assert.equal(publicationStackAction(partial[0]).count, 1)
})

test('confirmation copy counts exact pull requests rather than stack containers', () => {
  const stack = (id, action = 'pr') => ({
    kind: 'stack',
    id,
    records: [1, 2].map(position => ({
      id: `${id}-${position}`,
      status: 'prepared',
      action,
    })),
  })

  assert.deepEqual(publicationItemsAction([stack('one'), stack('two')]), {
    count: 4,
    updating: false,
    promptLabel: 'Send 4 reviewed pull requests?',
    confirmLabel: 'Send 4 PRs',
  })
  assert.deepEqual(publicationItemsAction([stack('one', 'pr_update')]), {
    count: 2,
    updating: true,
    promptLabel: 'Update 2 reviewed pull requests?',
    confirmLabel: 'Update 2 PRs',
  })
})

test('loaded older backends group canonical stack branches during hot reload', () => {
  const items = reviewItems({ records: [
    { id: 'a-second', status: 'prepared', repo: PLATFORM_REPO, is_stack: true,
      branch: 'stack/drawer-navigation/02-pins' },
    { id: 'z-first', status: 'prepared', repo: PLATFORM_REPO, is_stack: true,
      branch: 'stack/drawer-navigation/01-apps' },
  ] })
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'stack')
  assert.equal(items[0].stack.name, 'Drawer navigation')
  assert.deepEqual(items[0].records.map(record => record.id), ['z-first', 'a-second'])
})

test('the grouped panel uses one stable explanation instead of redundant counts', () => {
  for (const count of [0, 1, 3]) {
    const items = Array.from({ length: count }, (_, index) => ({
      kind: 'record', record: { id: String(index), status: 'prepared' },
    }))
    assert.deepEqual(reviewPanelSummary(items), {
      count: items.length,
      title: 'Reviews ready',
      copy: 'Each opens at its exact decision in Contribute.',
    })
  }
  assert.deepEqual(reviewPanelSummary([{
    kind: 'record', record: { id: 'sent', status: 'open', needs_attention: true },
  }]), {
    count: 1,
    title: 'Needs attention',
    copy: 'Continue the work in this chat.',
  })
  assert.deepEqual(reviewPanelSummary([{ kind: 'unsorted' }]), {
    count: 1,
    title: 'Changes ready to organize',
    copy: 'Sort reusable work into private reviews.',
  })
})

test('grouped cards expose one safe default for the exact visible set', () => {
  const ready = (id, action = 'pr') => ({
    kind: 'record', id, record: {
      id, action, status: 'prepared', quality_review_ready: true,
      review: { state: 'ready' },
    },
  })
  assert.deepEqual(reviewGroupDefault([ready('one'), ready('two')], { connected: true }), {
    kind: 'publish-items',
    items: [ready('one'), ready('two')],
    label: 'Send all 2',
  })
  assert.deepEqual(reviewGroupDefault([
    ready('one'),
    { kind: 'stack', id: 'stack:demo', records: [{ id: 'layer' }] },
  ], { connected: true }), {
    kind: 'review', intent: 'reviews:queue', label: 'Fix and review all 2',
  })
  assert.deepEqual(reviewGroupDefault([
    ready('one'),
    { kind: 'record', id: 'sent', record: { id: 'sent', status: 'open' } },
  ], { connected: true }), { kind: 'contribute', label: 'Handle all' })
  assert.deepEqual(reviewGroupDefault([
    { kind: 'unsorted', id: 'unsorted:x' }, ready('one'),
  ], { connected: true }), { kind: 'contribute', label: 'Handle all' })
  assert.equal(reviewGroupDefault([ready('one')], { connected: true }), null)
})

test('public failures distinguish agent recovery from owner account work', () => {
  assert.equal(publicationFailureOwner({ status: 403, code: 'forbidden' }), 'owner')
  assert.equal(publicationFailureOwner({ status: 0, code: 'unconfirmed_result' }), 'agent')
  assert.equal(publicationFailureOwner({ status: 409, code: 'review_refresh_needed' }), 'agent')
  assert.equal(reviewActionKey({ id: 'one', updated_at: 'T1', status: 'prepared' }), 'one:T1:prepared')
  assert.equal(
    reviewActionKey({ id: 'one', action_key: 'stable', updated_at: 'T2', status: 'open' }),
    'one:stable',
  )
  assert.equal(
    reviewActionKey({ id: 'one', updated_at: 'T1', status: 'open', needs_attention: true }),
    reviewActionKey({ id: 'one', updated_at: 'T2', status: 'open', needs_attention: true }),
  )
})

test('healthy sent records leave chat while attention can hand work back to the agent', () => {
  assert.deepEqual(reviewItems({ records: [
    { id: 'healthy', status: 'open' },
    { id: 'done', status: 'merged' },
    { id: 'attention', status: 'open', needs_attention: true },
  ] }).map(item => item.id), ['attention'])
  assert.match(cardSrc, /function TrackingRow\(/)
  assert.match(cardSrc, /trackingStatusLabel\(record\)/)
  assert.match(cardSrc, /trackingNarration\(record\)/)
  assert.match(cardSrc, /onContinueInChat\(record\)/)
  assert.match(cardSrc, />\s*Ask agent to fix\s*</)
  assert.doesNotMatch(cardSrc, /Queue agent follow-up/)
  assert.match(cardSrc, /acceptedRef\.current\.has\(key\)/)
  assert.match(
    chatViewSrc,
    /const revision = reviewActionKey\(record\)[\s\S]*?sendContributionIntent\([\s\S]*?`followup:\$\{revision\}`/,
  )
  assert.match(chatViewSrc, /onContinueInChat=\{handleContributionFollowup\}/)
  assert.match(publicationSrc, /publication\?\.record\?\.status === 'draft'/)
})
test('chat cards keep direct send and exact review on the same guarded routes', () => {
  assert.match(clientSrc, /submitter:\s*'chat-review-card'/)
  assert.match(clientSrc, /record\?\.action === 'pr_update'/)
  assert.match(clientSrc, /update-existing/)
  assert.match(publicationSrc, /publish = api\.contributions\.publish/)
  assert.match(cardSrc, /consume\(item\)[\s\S]*const outcome = await publishContribution\(\{/)
  assert.match(cardSrc, /publicationFailureOwner\(outcome\.failure\) === 'agent'/)
  assert.match(cardSrc, /const started = await startRecovery/)
  assert.doesNotMatch(cardSrc, /contrib-card__progress/)
  assert.match(cardSrc, />\s*Review\s*</)
  assert.doesNotMatch(cardSrc, /body_draft|record\.files|The exact text that will be published/)
  assert.doesNotMatch(cardSrc, /Contribute this improvement|>Details<|>Layers</)
  assert.match(cardSrc, /onOpenApp\(contributeApp, \{ final: true, intent \}\)/)
  assert.match(cardSrc, /contributionReviewIntent\(record\)/)
  assert.match(cardCss, /\.contrib-card__send\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*42px;/)
  assert.match(cardCss, /\.contrib-card__review\s*\{[\s\S]*?min-height:\s*42px;/)
  assert.doesNotMatch(cardCss, /border-left:\s*2px/)
})

test('the floating card reduces a multi-line diff stat to its aggregate', () => {
  assert.equal(
    diffStatSummary(' frontend/src/a.js | 12 +++++\n backend/app/b.py | 3 ---\n 2 files changed, 12 insertions(+), 3 deletions(-)'),
    '2 files changed, 12 insertions(+), 3 deletions(-)',
  )
  assert.equal(diffStatSummary(' 1 file changed, 4 insertions(+)\n'), '1 file changed, 4 insertions(+)')
  assert.equal(diffStatSummary(null), '')
})

test('the card opts back into pointer events inside the pass-through foot', () => {
  assert.match(cardCss, /\.contrib-card-stack,\s*\n\.contrib-card \{\s*\n\s*pointer-events: auto;/)
})

test('only a decisively sideways drag counts, in either direction', () => {
  assert.equal(isHorizontalSwipe(20, 0), true)
  assert.equal(isHorizontalSwipe(-20, 0), true)
  assert.equal(isHorizontalSwipe(0, 30), false)
  assert.equal(isHorizontalSwipe(20, 19), false)
  assert.equal(isHorizontalSwipe(8, 0), false)
})

test('dismissal needs real horizontal travel', () => {
  assert.equal(passedDismissThreshold(DISMISS_DX_PX, 0), true)
  assert.equal(passedDismissThreshold(-DISMISS_DX_PX, 0), true)
  assert.equal(passedDismissThreshold(DISMISS_DX_PX - 1, 0), false)
  assert.equal(passedDismissThreshold(70, 90), false)
})

test('dismissal hides only this version without touching the ledger', () => {
  const record = { id: 'r1', status: 'prepared', updated_at: 'T1' }
  const store = fakeStorage()
  const payload = { records: [record] }
  assert.equal(visibleRecords(payload, store).length, 1)
  rememberDismissed(record, store)
  assert.equal(isDismissed(record, store), true)
  assert.equal(visibleRecords(payload, store).length, 0)
  assert.deepEqual(record, { id: 'r1', status: 'prepared', updated_at: 'T1' })
  assert.equal(isDismissed({ ...record, updated_at: 'T2' }, store), false)
})

test('dismissing a stack hides one card and any revised layer brings it back', () => {
  const storage = fakeStorage()
  const payload = { records: [
    { id: 'one', status: 'prepared', updated_at: '1', repo: PLATFORM_REPO,
      stack: { id: 'drawer', position: 1, total: 2 } },
    { id: 'two', status: 'prepared', updated_at: '1', repo: PLATFORM_REPO,
      stack: { id: 'drawer', position: 2, total: 2 } },
  ] }
  const item = visibleReviewItems(payload, storage)[0]
  assert.equal(rememberReviewItemDismissed(item, storage), true)
  assert.equal(visibleReviewItems(payload, storage).length, 0)
  payload.records[0].updated_at = '2'
  assert.equal(visibleReviewItems(payload, storage).length, 1)
})

test('dismissal degrades safely without usable storage', () => {
  const record = { id: 'r1', status: 'prepared', updated_at: 'T1' }
  const hostile = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  assert.equal(rememberDismissed(record, hostile), false)
  assert.equal(isDismissed(record, hostile), false)
  assert.equal(isDismissed(record, null), false)
  assert.equal(dismissKey({ updated_at: 'T1' }), null)
})

test('the swipe has a visible focusable equivalent', () => {
  assert.match(cardSrc, /className="contrib-card__dismiss"/)
  assert.match(cardSrc, /aria-label="Dismiss — keeps it in Contribute"/)
  assert.match(cardSrc, /onClick=\{\(\) => onDismiss\?\.\(\)\}/)
  assert.match(cardSrc, /import \{ X \} from '@openai\/apps-sdk-ui\/components\/Icon'/)
  assert.equal((cardSrc.match(/<X width=\{14\} height=\{14\} aria-hidden="true" \/>/g) || []).length, 4)
})

test('the dismissal gesture is claimed with a non-passive touchmove', () => {
  assert.match(cardSrc, /addEventListener\('touchmove', onMove, \{ passive: false \}\)/)
  assert.match(cardSrc, /event\.preventDefault\(\)/)
  assert.doesNotMatch(cardSrc, /onTouchMove=\{/)
})

test('every card shape shares one swipe implementation', () => {
  assert.equal((cardSrc.match(/function useSwipeToDismiss\(/g) || []).length, 1)
  assert.equal((cardSrc.match(/= useSwipeToDismiss\(onDismiss\)/g) || []).length, 4)
  assert.equal((cardSrc.match(/addEventListener\('touchmove'/g) || []).length, 1)
})
