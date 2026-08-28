import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chatChangesActionIsCurrent,
  chatEditDiffsQueryKey,
  contributionsForChatQueryKey,
  invalidateChatChangesQueries,
  refreshChatChangesOverview,
} from '../chatChangesQueries.js'

test('chat completion invalidates both lifecycle inputs for only that chat', async () => {
  const calls = []
  const queryClient = {
    invalidateQueries: async options => { calls.push(options) },
  }

  await invalidateChatChangesQueries(queryClient, 'chat-a')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].predicate({
    queryKey: contributionsForChatQueryKey(80, 'chat-a'),
  }), true)
  assert.equal(calls[0].predicate({
    queryKey: contributionsForChatQueryKey(80, 'chat-b'),
  }), false)
  assert.deepEqual(calls[1], {
    queryKey: chatEditDiffsQueryKey('chat-a'),
    exact: true,
  })
})

test('fresh lifecycle state rejects a stale organize action before agent work', async () => {
  const record = {
    id: 'prepared-review',
    status: 'prepared',
    action_key: 'reviewed-head',
    source_root: '/data/platform',
    coverage_at: 200,
    files: ['frontend/src/example.js'],
  }
  const queryClient = {
    fetchQuery: async ({ queryKey }) => {
      if (queryKey[0] === 'contributions-for-chat') {
        return { records: [record], settlements: [] }
      }
      return [{
        id: 'edit-1',
        ts: 100,
        preview: {
          files: [{ path: '/data/platform/frontend/src/example.js' }],
        },
      }]
    },
  }

  const overview = await refreshChatChangesOverview({
    queryClient,
    apps: [{ id: 80, slug: 'contribute' }],
    chatId: 'chat-a',
  })

  assert.equal(overview.counts.unsorted, 0)
  assert.equal(chatChangesActionIsCurrent(overview, {
    kind: 'unsorted',
    revision: 'old-unsorted-revision',
  }), false)
  assert.equal(chatChangesActionIsCurrent(overview, {
    kind: 'workflow',
    revision: overview.workflowRevision,
  }), true)
  assert.equal(chatChangesActionIsCurrent(overview, {
    kind: 'records',
    recordKeys: ['prepared-review:reviewed-head'],
  }), true)
})
