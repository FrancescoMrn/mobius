/* Shared read-only hook for one chat's recorded edits and contribution lifecycle. */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { appQueries } from '../../hooks/queries.js'
import {
  contributeApp,
  contributeAppId,
} from './contributionReviewModel.js'
import {
  chatChangesOverview,
} from './chatChangesLifecycle.js'
import { mergeChatDiffEntries } from './chatDiffs.js'
import {
  chatEditDiffsQueryOptions,
  contributionsForChatQueryOptions,
  contributionsForChatQueryKey,
} from './chatChangesQueries.js'

export function useChatContributions(chatId, { enabled = true } = {}) {
  const appsQuery = appQueries.list.useQuery()
  const appId = contributeAppId(appsQuery.data)
  const app = contributeApp(appsQuery.data, appId)
  const queryKey = useMemo(
    () => contributionsForChatQueryKey(appId, chatId),
    [appId, chatId],
  )
  const query = useQuery({
    ...contributionsForChatQueryOptions(appId, chatId),
    queryKey,
    enabled: Boolean(enabled && appId && chatId),
  })
  return { appId, app, queryKey, ...query }
}

export function useChatChangesOverview(chatId, initialEntries = [], { enabled = true } = {}) {
  const contributions = useChatContributions(chatId, { enabled })
  const diffs = useQuery({
    ...chatEditDiffsQueryOptions(chatId),
    enabled: Boolean(enabled && chatId),
  })
  const entries = useMemo(
    () => mergeChatDiffEntries(diffs.data || [], initialEntries),
    [diffs.data, initialEntries],
  )
  const overview = useMemo(
    () => chatChangesOverview(entries, contributions.data),
    [entries, contributions.data],
  )
  return {
    ...overview,
    contributeApp: contributions.app,
    contributeAppId: contributions.appId,
    contributions: contributions.data,
    contributionsQuery: contributions,
    diffsQuery: diffs,
    loading: diffs.isLoading || contributions.isLoading,
    error: diffs.isError || contributions.isError,
  }
}
