import { api } from '../../api/client.js'

function publicationFailure(response, body) {
  const detail = body?.detail
  return {
    status: response.status,
    message: typeof detail === 'string'
      ? detail
      : detail?.message || 'Could not complete the reviewed GitHub action.',
    detail: typeof detail?.detail === 'string' ? detail.detail : '',
    code: typeof detail?.code === 'string' ? detail.code : '',
  }
}

export function projectPublishedContribution(payload, recordId, publication = null) {
  if (!payload || !Array.isArray(payload.records)) return payload
  const status = publication?.record?.status === 'draft' ? 'draft' : 'open'
  return {
    ...payload,
    records: payload.records.map(record => record.id === recordId ? {
      ...record,
      status,
      number: publication?.number ?? record.number,
      url: publication?.url ?? record.url,
      needs_attention: false,
    } : record),
  }
}

/**
 * Execute one exact reviewed publication and reconcile an ambiguous outcome.
 * Both chat surfaces use this path so their state transitions cannot drift.
 */
export async function publishContribution({
  appId,
  record,
  autopilot,
  refetch,
  publish = api.contributions.publish,
}) {
  let failure
  try {
    const response = await publish(appId, record, { autopilot })
    const body = await response.json().catch(() => null)
    if (response.ok) return { kind: 'published', publication: body }
    failure = publicationFailure(response, body)
  } catch {
    failure = {
      status: 0,
      message: 'The result could not be confirmed.',
      detail: 'Contribute will reconcile the current branch and pull request before trying anything else.',
      code: 'unconfirmed_result',
    }
  }

  const refreshed = typeof refetch === 'function'
    ? await refetch().catch(() => null)
    : null
  const latest = refreshed?.data?.records?.find(row => row.id === record.id)
  if (latest && (latest.status !== 'prepared' || latest.updated_at !== record.updated_at)) {
    return { kind: 'reconciled', record: latest }
  }
  return { kind: 'failed', failure, record: latest || record }
}

/** Execute one complete immutable stack action and reconcile partial/lost outcomes. */
export async function publishContributionStack({
  appId,
  item,
  refetch,
  publish = api.contributions.publishStack,
}) {
  const records = Array.isArray(item?.records) ? item.records : []
  let failure
  try {
    const response = await publish(appId, records)
    const body = await response.json().catch(() => null)
    if (response.ok) {
      await refetch?.().catch(() => null)
      return { kind: 'published', records: body?.records || [] }
    }
    failure = publicationFailure(response, body)
  } catch {
    failure = {
      status: 0,
      message: 'The stack result could not be confirmed.',
      detail: 'Contribute will reconcile every linked pull request before another action is offered.',
      code: 'unconfirmed_result',
    }
  }

  const refreshed = typeof refetch === 'function'
    ? await refetch().catch(() => null)
    : null
  const lifecycle = new Map(
    (refreshed?.data?.records || []).map(record => [record.id, record]),
  )
  const stacked = new Map(
    (refreshed?.data?.stack_units || [])
      .flatMap(unit => unit?.records || [])
      .map(record => [record.id, record]),
  )
  const advanced = records.some(record => {
    const current = stacked.get(record.id) || lifecycle.get(record.id)
    return current && (
      current.status !== record.status
      || (stacked.has(record.id) && current.action_key !== record.action_key)
    )
  })
  if (advanced) return {
    kind: 'reconciled',
    records: records
      .map(record => stacked.get(record.id) || lifecycle.get(record.id))
      .filter(Boolean),
  }
  return { kind: 'failed', failure, records }
}
