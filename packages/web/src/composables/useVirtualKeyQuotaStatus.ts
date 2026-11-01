import { ref } from 'vue'
import { virtualKeyApi } from '@/api/virtual-key'
import { deriveQuotaHealth, type VirtualKeyQuotaHealth } from '@/utils/virtual-key-quota'

export type VirtualKeyQuotaStatus =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; health: VirtualKeyQuotaHealth }

type GetQuotas = typeof virtualKeyApi.getQuotas

export function useVirtualKeyQuotaStatus(getQuotas: GetQuotas = virtualKeyApi.getQuotas.bind(virtualKeyApi)) {
  const statusById = ref<Record<string, VirtualKeyQuotaStatus>>({})
  // Latest-fetch guard per key: a response for a superseded fetch (post-reset)
  // must not overwrite the fresher one.
  const tokensById = new Map<string, number>()

  function setStatus(id: string, status: VirtualKeyQuotaStatus) {
    statusById.value = { ...statusById.value, [id]: status }
  }

  async function fetchOne(id: string) {
    const mine = (tokensById.get(id) ?? 0) + 1
    tokensById.set(id, mine)
    setStatus(id, { phase: 'loading' })
    try {
      const [daily, weekly] = await Promise.all([getQuotas(id, 'daily'), getQuotas(id, 'weekly')])
      if (mine !== tokensById.get(id)) return
      setStatus(id, {
        phase: 'loaded',
        health: deriveQuotaHealth(daily.quotas ?? [], weekly.quotas ?? [])
      })
    } catch (error: any) {
      if (mine !== tokensById.get(id)) return
      setStatus(id, { phase: 'error', message: error?.message || String(error ?? 'unknown') })
    }
  }

  async function ensure(ids: string[]) {
    for (const id of ids) {
      const cached = statusById.value[id]
      if (cached && cached.phase !== 'error') continue
      void fetchOne(id)
    }
  }

  function reset() {
    for (const id of Object.keys(statusById.value)) {
      tokensById.set(id, (tokensById.get(id) ?? 0) + 1)
    }
    statusById.value = {}
  }

  return { statusById, ensure, reset }
}
