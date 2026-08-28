/* Query ownership for one chat's edits and contribution lifecycle. */

import { api, apiFetch } from '../../api/client.js'
import { chatChangesOverview } from './chatChangesLifecycle.js'
import { mergeChatDiffEntries, normalizeChatDiffEntries } from './chatDiffs.js'
import { contributeAppId, reviewActionKey } from './contributionReviewModel.js'

export function contributionsForChatQueryKey(appId, chatId) {
  return ['contributions-for-chat', appId, chatId]
}

export function chatEditDiffsQueryKey(chatId) {
  return ['chat-edit-diffs', String(chatId || '')]
}

export function contributionsForChatQueryOptions(appId, chatId) {
  return {
    queryKey: contributionsForChatQueryKey(appId, chatId),
    queryFn: () => api.contributions.forChat(appId, chatId)
      .then(response => (response.ok ? response.json() : null)),
    staleTime: 15000,
    retry: false,
  }
}

export function chatEditDiffsQueryOptions(chatId) {
  return {
    queryKey: chatEditDiffsQueryKey(chatId),
    queryFn: async ({ signal } = {}) => {
      const response = await apiFetch(
        `/chats/${encodeURIComponent(chatId)}/edit-diffs`,
        { signal },
      )
      if (!response.ok) throw new Error(`Request failed (${response.status})`)
      const data = await response.json()
      return normalizeChatDiffEntries(data?.entries)
    },
    staleTime: 15000,
    retry: false,
  }
}

export function invalidateChatChangesQueries(queryClient, chatId) {
  if (!queryClient || !chatId) return Promise.resolve([])
  const targetChatId = String(chatId)
  return Promise.all([
    queryClient.invalidateQueries({
      predicate: query => (
        query?.queryKey?.[0] === 'contributions-for-chat'
        && String(query.queryKey[2] || '') === targetChatId
      ),
    }),
    queryClient.invalidateQueries({
      queryKey: chatEditDiffsQueryKey(chatId),
      exact: true,
    }),
  ])
}

export async function refreshChatChangesOverview({
  queryClient,
  apps,
  chatId,
  initialEntries = [],
}) {
  const appId = contributeAppId(apps)
  if (!queryClient || !appId || !chatId) return null
  try {
    const [contributions, entries] = await Promise.all([
      queryClient.fetchQuery({
        ...contributionsForChatQueryOptions(appId, chatId),
        staleTime: 0,
      }),
      queryClient.fetchQuery({
        ...chatEditDiffsQueryOptions(chatId),
        staleTime: 0,
      }),
    ])
    if (!contributions) return null
    return {
      ...chatChangesOverview(
        mergeChatDiffEntries(entries || [], initialEntries),
        contributions,
      ),
      contributions,
    }
  } catch {
    return null
  }
}

export function chatChangesActionIsCurrent(overview, action) {
  if (!overview || !action) return false
  const revision = String(action.revision || '')
  if (action.kind === 'unsorted') {
    return overview.counts?.unsorted > 0
      && Boolean(revision)
      && overview.unsortedRevision === revision
  }
  if (action.kind === 'workflow') {
    return overview.needsAction === true
      && Boolean(revision)
      && overview.workflowRevision === revision
  }
  if (action.kind === 'records') {
    const expected = (action.recordKeys || []).filter(Boolean)
    if (expected.length === 0) return false
    const current = new Set(
      (overview.contributions?.records || []).map(reviewActionKey),
    )
    return expected.every(key => current.has(key))
  }
  return false
}
