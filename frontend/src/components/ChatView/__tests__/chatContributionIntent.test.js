import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAT_CONTRIBUTION_PREPARE_PROMPT,
  chatChangesPrimaryAction,
  preparedChangesPrimaryAction,
  chatContributionPrepareAction,
} from '../chatContributionIntent.js'

test('chat preparation is private, scoped to recorded edits, and leaves publishing separate', () => {
  assert.match(CHAT_CONTRIBUTION_PREPARE_PROMPT, /file changes recorded by this chat/)
  assert.match(CHAT_CONTRIBUTION_PREPARE_PROMPT, /Verify the current source state/)
  assert.match(CHAT_CONTRIBUTION_PREPARE_PROMPT, /privately prepare every worthwhile contribution/)
  assert.match(CHAT_CONTRIBUTION_PREPARE_PROMPT, /Do not push, publish, or send anything upstream/)
  assert.match(CHAT_CONTRIBUTION_PREPARE_PROMPT, /chat-settlement workflow/)
})

test('action copy names user intent instead of internal queue timing', () => {
  assert.equal(chatContributionPrepareAction(false).label, 'Prepare all')
  assert.equal(chatContributionPrepareAction(true).label, 'Prepare all')
})

test('Changes exposes one context-aware primary action', () => {
  assert.equal(chatChangesPrimaryAction({ counts: { unsorted: 4 } }).label, 'Prepare all')
  assert.equal(chatChangesPrimaryAction({ counts: { attention: 2 } }).label, 'Fix all')
  assert.equal(chatChangesPrimaryAction({ counts: { prepared: 2 } }).label, 'Review prepared')
  assert.equal(chatChangesPrimaryAction({ counts: { open: 2 } }).label, 'Check for updates')
  assert.equal(chatChangesPrimaryAction({ counts: { unsorted: 1, prepared: 1 } }).label, 'Handle all')
  assert.equal(chatChangesPrimaryAction({ counts: {} }), null)
})

test('prepared work resolves to one direct top action', () => {
  const ready = (id, action = 'pr') => ({
    id, action, status: 'prepared', quality_review_ready: true,
    review: { state: 'ready' },
  })
  const send = ready('send')
  const update = ready('update', 'pr_update')
  assert.equal(preparedChangesPrimaryAction([send], { connected: true }).label, 'Send PR')
  assert.equal(preparedChangesPrimaryAction([update], { connected: true }).label, 'Update PR')
  assert.equal(preparedChangesPrimaryAction([send, update], { connected: true }).label, 'Send all 2')
  assert.equal(preparedChangesPrimaryAction([
    { ...send, review: { state: 'needs_refresh' } }, update,
  ], { connected: true }).label, 'Fix and review all 2')

  const stack = {
    kind: 'stack', id: 'stack:direct', stack: { id: 'direct', total: 2 },
    records: [
      { ...ready('one'), stack: { id: 'direct', position: 1, total: 2 } },
      { ...ready('two'), stack: { id: 'direct', position: 2, total: 2 } },
    ],
  }
  assert.equal(preparedChangesPrimaryAction([stack], { connected: true }).label, 'Send stack')
})
